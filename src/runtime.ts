import path from "node:path";
import os from "node:os";
import { JsonCardStore } from "./store.js";
import {
  buildCardRecord,
  createSlackCardBackend,
  injectCardContextIntoBlocks,
  makeCardId,
} from "./slack-api.js";
import type {
  CardRecord,
  CardState,
  InteractionResolution,
  PluginConfig,
  PreparedSlackMessageInput,
  PreparedSlackUpdateInput,
  RuntimeServices,
  SendSlackBlockKitInput,
  UpdateSlackMessageInput,
} from "./types.js";

function getText(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function getQuestionChoices(blocks: unknown[]): Map<string, string> {
  const choiceMap = new Map<string, string>();

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const blockRecord = block as Record<string, unknown>;

    if (blockRecord.type === "actions" && Array.isArray(blockRecord.elements)) {
      for (const element of blockRecord.elements) {
        if (!element || typeof element !== "object") continue;
        const elementRecord = element as Record<string, unknown>;
        const id = getText(elementRecord, "action_id") ?? getText(elementRecord, "actionId");
        const textRecord = typeof elementRecord.text === "object" && elementRecord.text && !Array.isArray(elementRecord.text)
          ? elementRecord.text as Record<string, unknown>
          : undefined;
        const txt = getText(textRecord, "text");
        if (id?.startsWith("wbk:quiz:") && id !== "wbk:quiz:submit" && txt) choiceMap.set(id.slice("wbk:quiz:".length), txt);
      }
      continue;
    }

    const element = blockRecord.type === "input" && blockRecord.element && typeof blockRecord.element === "object"
      ? blockRecord.element as Record<string, unknown>
      : undefined;
    if (getText(element, "action_id") !== "wbk:quiz:pick-many:select") continue;
    const options = Array.isArray(element?.options) ? element.options : [];
    for (const option of options) {
      if (!option || typeof option !== "object") continue;
      const optionRecord = option as Record<string, unknown>;
      const value = getText(optionRecord, "value");
      const textRecord = typeof optionRecord.text === "object" && optionRecord.text && !Array.isArray(optionRecord.text)
        ? optionRecord.text as Record<string, unknown>
        : undefined;
      const text = getText(textRecord, "text");
      if (!value || !text) continue;
      const label = text.replace(new RegExp(`^${value}\\.\\s*`), "");
      choiceMap.set(value, label);
    }
  }

  return choiceMap;
}

function parseSelectedIdsFromStateValue(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;

  const directCandidates = [
    record.selectedOptions,
    record.selected_options,
    record.selectedOption,
    record.selected_option,
    record.selectedOptionsArray,
    record.selected_options_array,
    record.value,
  ];

  for (const candidate of directCandidates) {
    const parsed = parseSelectedIds(candidate);
    if (parsed.length > 0) return parsed;
  }

  return [];
}

function parseSelectedIds(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((item) => parseSelectedIds(item)).filter(Boolean)));
  }
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const directValue = getText(record, "value");
  if (directValue) return [directValue];

  const nestedText = typeof record.text === "object" && record.text && !Array.isArray(record.text)
    ? getText(record.text as Record<string, unknown>, "text")
    : undefined;
  if (nestedText && getText(record, "value")) return [getText(record, "value")!];

  return [];
}

function getPersistedPickManySelectionIds(record?: CardRecord): string[] {
  const candidates = [
    record?.metadata?.draftSelected,
    record?.metadata?.draftSelectedIds,
    record?.metadata?.selected,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const parsed = candidate.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (parsed.length > 0) return Array.from(new Set(parsed));
  }

  return [];
}

function extractPickManySelectionIds(args: any): string[] {
  const directCandidates = [
    args?.interaction?.selectedValues,
    args?.interaction?.selected_values,
    args?.interaction?.selectedOptions,
    args?.interaction?.selected_options,
    args?.interaction?.state,
    args?.interaction?.stateValues,
    args?.interaction?.state_values,
    args?.interaction?.payload?.state,
    args?.interaction?.payload?.state?.values,
    args?.state,
    args?.payload?.state,
  ];

  for (const candidate of directCandidates) {
    const direct = parseSelectedIds(candidate);
    if (direct.length > 0) return direct;

    const parsed = extractFromUnknownState(candidate);
    if (parsed.length > 0) return parsed;
  }

  return [];
}

function extractFromUnknownState(state: unknown): string[] {
  if (!state || typeof state !== "object") return [];
  const record = state as Record<string, unknown>;

  const direct = parseSelectedIdsFromStateValue(record);
  if (direct.length > 0) return direct;

  const values = record.values;
  if (values && typeof values === "object") {
    const parsed = extractFromValuesRecord(values as Record<string, unknown>);
    if (parsed.length > 0) return parsed;
  }

  return extractFromValuesRecord(record);
}

function extractFromValuesRecord(values: Record<string, unknown>): string[] {
  for (const blockValue of Object.values(values)) {
    if (!blockValue || typeof blockValue !== "object") continue;
    const blockRecord = blockValue as Record<string, unknown>;

    const direct = parseSelectedIdsFromStateValue(blockRecord);
    if (direct.length > 0) return direct;

    for (const actionValue of Object.values(blockRecord)) {
      const parsed = parseSelectedIdsFromStateValue(actionValue);
      if (parsed.length > 0) return parsed;
    }
  }
  return [];
}

function formatChoiceLine(id: string, label: string, selectedIds: Set<string>, answerIds: Set<string>, correct: boolean): string {
  if (correct) {
    return selectedIds.has(id) ? `👉✅ *${id}.* ${label}` : `• *${id}.* ${label}`;
  }
  if (selectedIds.has(id) && answerIds.has(id)) return `👉✅ *${id}.* ${label}`;
  if (selectedIds.has(id) && !answerIds.has(id)) return `👉❌ *${id}.* ${label}`;
  if (!selectedIds.has(id) && answerIds.has(id)) return `✅ *${id}.* ${label}`;
  return `• *${id}.* ${label}`;
}

function buildSkillQuizResolver(store: RuntimeServices["store"]): RuntimeServices["resolveInteraction"] {
  return async ({ args, record, actionId, parsedPayload, duplicate }): Promise<InteractionResolution | undefined> => {
    if (duplicate || !record) return undefined;
    if (record.metadata?.interactionResolver !== "skill") return undefined;
    if (record.metadata?.interactionKind !== "quiz-answer") return undefined;

    const questionType = typeof record.metadata?.questionType === "string" ? record.metadata.questionType : undefined;
    const blocks = Array.isArray(record.blocks) ? [...record.blocks] : [];
    const choiceMap = getQuestionChoices(blocks);
    const explanation = typeof record.metadata?.explanation === "string" ? record.metadata.explanation : undefined;
    const questionId = typeof record.metadata?.questionId === "string" ? record.metadata.questionId : undefined;

    if (questionType === "pick-many") {
      if (actionId === "wbk:quiz:pick-many:select") {
        const selectedIds = Array.from(new Set(extractPickManySelectionIds(args)));
        await store.upsertCard({
          ...record,
          metadata: {
            ...(record.metadata ?? {}),
            draftSelected: selectedIds,
            draftSelectedIds: selectedIds,
          },
          state: mergeCardState(record.state, {
            status: "open",
            handledAt: undefined,
            handledActionId: undefined,
            handledActionLabel: undefined,
          }),
        });
        return {
          actionLabel: selectedIds.length > 0 ? `Select answers (${selectedIds.join(",")})` : "Select answers",
          suppressDefaultReply: true,
          suppressDefaultUpdate: true,
        };
      }
      if (actionId !== "wbk:quiz:submit") return undefined;

      const answerIds = Array.isArray(record.metadata?.answer)
        ? record.metadata.answer.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
      if (answerIds.length === 0) return undefined;

      const selectedIds = Array.from(new Set([
        ...extractPickManySelectionIds(args),
        ...getPersistedPickManySelectionIds(record),
      ]));
      const selectedSet = new Set(selectedIds);
      const answerSet = new Set(answerIds);
      const correct = selectedIds.length > 0
        && selectedIds.length === answerIds.length
        && selectedIds.every((id) => answerSet.has(id));

      const choiceLines = Array.from(choiceMap.entries()).map(([id, label]) => formatChoiceLine(id, label, selectedSet, answerSet, correct));
      const preservedBlocks = blocks.filter((b: any) => !(b && typeof b === "object" && (b.type === "actions" || b.type === "input")));
      preservedBlocks.push({
        type: "section",
        text: { type: "mrkdwn", text: choiceLines.join("\n") },
      });

      const selectedSummary = selectedIds.length > 0
        ? selectedIds.map((id) => `${id}. ${choiceMap.get(id) ?? id}`).join(", ")
        : "(none selected)";
      const answerSummary = answerIds.map((id) => `${id}. ${choiceMap.get(id) ?? id}`).join(", ");
      const feedbackText = correct
        ? `✅ Correct\nYour answers: ${selectedSummary}${explanation ? `\nExplanation: ${explanation}` : ""}`
        : `❌ Incorrect\nYour answers: ${selectedSummary}\nCorrect answers: ${answerSummary}${explanation ? `\nExplanation: ${explanation}` : ""}`;
      preservedBlocks.push({
        type: "section",
        text: { type: "mrkdwn", text: feedbackText },
      });

      return {
        actionLabel: selectedIds.length > 0 ? `Submit answer (${selectedIds.join(",")})` : "Submit answer",
        suppressDefaultReply: true,
        update: {
          text: correct ? "✅ Correct" : "❌ Incorrect",
          blocks: preservedBlocks,
          statePatch: {
            status: "handled",
            handledActionId: actionId,
            handledActionLabel: selectedIds.join(",") || "none",
          },
          metadataPatch: {
            postActionRenderMode: "preserve",
            interactionKind: "quiz-answer",
            ...(questionId ? { questionId } : {}),
            draftSelected: selectedIds,
            draftSelectedIds: selectedIds,
            selected: selectedIds,
            correct,
            answer: answerIds,
          },
          postActionRenderModePatch: "preserve",
        },
      };
    }

    const payloadExtra = typeof parsedPayload?.x === "string" ? parsedPayload.x : undefined;
    let choiceId: string | undefined;
    if (payloadExtra) {
      try {
        const parsed = JSON.parse(payloadExtra) as { choiceId?: string };
        if (typeof parsed.choiceId === "string" && parsed.choiceId) choiceId = parsed.choiceId;
      } catch {}
    }
    if (!choiceId && actionId.startsWith("wbk:quiz:")) {
      choiceId = actionId.slice("wbk:quiz:".length);
    }
    if (!choiceId) return undefined;

    const answer = typeof record.metadata?.answer === "string" ? record.metadata.answer : undefined;
    const selectedLabel = choiceMap.get(choiceId) ?? choiceId;
    const answerLabel = answer ? (choiceMap.get(answer) ?? answer) : undefined;
    const correct = Boolean(answer && choiceId === answer);
    const choiceLines = Array.from(choiceMap.entries()).map(([id, label]) => {
      if (correct) {
        return id === choiceId ? `👉✅ *${id}.* ${label}` : `• *${id}.* ${label}`;
      }
      if (id === choiceId) return `👉❌ *${id}.* ${label}`;
      if (answer && id === answer) return `✅ *${id}.* ${label}`;
      return `• *${id}.* ${label}`;
    });
    const preservedBlocks = blocks.filter((b: any) => !(b && typeof b === "object" && b.type === "actions"));
    preservedBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: choiceLines.join("\n") },
    });
    const feedbackText = correct
      ? `✅ Correct\nYour answer: ${choiceId}. ${selectedLabel}${explanation ? `\nExplanation: ${explanation}` : ""}`
      : `❌ Incorrect\nYour answer: ${choiceId}. ${selectedLabel}${answer && answerLabel ? `\nCorrect answer: ${answer}. ${answerLabel}` : ""}${explanation ? `\nExplanation: ${explanation}` : ""}`;
    preservedBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: feedbackText },
    });

    return {
      actionLabel: selectedLabel,
      suppressDefaultReply: true,
      update: {
        text: correct ? "✅ Correct" : "❌ Incorrect",
        blocks: preservedBlocks,
        statePatch: {
          status: "handled",
          handledActionId: actionId,
          handledActionLabel: choiceId,
        },
        metadataPatch: {
          postActionRenderMode: "preserve",
          interactionKind: "quiz-answer",
          ...(questionId ? { questionId } : {}),
          selected: choiceId,
          correct,
          ...(answer ? { answer } : {}),
        },
        postActionRenderModePatch: "preserve",
      },
    };
  };
}

export function createRuntimeServices({
  api,
  config,
}: {
  api: { resolvePath(input: string): string };
  config: PluginConfig;
}): RuntimeServices {
  const fallbackPath = path.join(os.homedir(), ".openclaw", "state", "slack-blockkit-bridge", "cards.json");
  const storePath = config.storePath
    ? api.resolvePath(config.storePath.replace(/^~(?=$|\/)/, os.homedir()))
    : fallbackPath;

  const store = new JsonCardStore(storePath);

  return {
    config,
    store,
    backend: createSlackCardBackend(config),
    resolveInteraction: buildSkillQuizResolver(store),
  };
}

export function mergeCardState(base?: Partial<CardState>, patch?: Partial<CardState>): CardState {
  const now = new Date().toISOString();
  return {
    status: patch?.status ?? base?.status ?? "open",
    handledAt: patch?.handledAt ?? base?.handledAt,
    handledActionId: patch?.handledActionId ?? base?.handledActionId,
    handledActionLabel: patch?.handledActionLabel ?? base?.handledActionLabel,
    lastUpdatedAt: patch?.lastUpdatedAt ?? now,
  };
}

export function prepareSlackMessageInput(
  input: SendSlackBlockKitInput,
  config: PluginConfig,
): PreparedSlackMessageInput {
  const cardId = input.cardId ?? makeCardId();
  const hasBlocks = Array.isArray(input.blocks) && input.blocks.length > 0;

  if (!hasBlocks && !config.fallbackToText) {
    throw new Error("blocks are required when fallbackToText is disabled");
  }

  return {
    ...input,
    cardId,
    blocks: hasBlocks ? injectCardContextIntoBlocks(input.blocks, cardId) : [],
    contentMode: hasBlocks ? "blocks" : "text",
    postActionRenderMode: input.postActionRenderMode ?? "replace",
  };
}

export function prepareSlackUpdateInput(
  record: CardRecord,
  input: UpdateSlackMessageInput,
  config: PluginConfig,
): PreparedSlackUpdateInput {
  const text = input.text ?? "";
  const nextBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  const hasBlocks = nextBlocks.length > 0;

  if (!text && !hasBlocks) {
    throw new Error("text or blocks are required for updateMessage");
  }

  if (!hasBlocks && !config.fallbackToText) {
    throw new Error("blocks are required when fallbackToText is disabled");
  }

  return {
    cardId: record.cardId,
    channel: input.channel ?? record.channel,
    threadTs: input.threadTs ?? record.threadTs,
    messageTs: input.messageTs ?? record.messageTs,
    text,
    blocks: hasBlocks ? injectCardContextIntoBlocks(nextBlocks, record.cardId) : [],
    metadata: input.metadataPatch ? { ...(record.metadata ?? {}), ...input.metadataPatch } : record.metadata,
    state: mergeCardState(record.state, input.statePatch),
    contentMode: hasBlocks ? "blocks" : "text",
    postActionRenderMode: input.postActionRenderModePatch ?? record.postActionRenderMode ?? "replace",
  };
}

export async function sendSlackBlockKit(
  services: RuntimeServices,
  input: SendSlackBlockKitInput,
): Promise<{ ok: true; cardId: string; messageTs?: string; mode: "mock" | "live"; contentMode: "blocks" | "text" }> {
  if (!services.config.enabled) {
    throw new Error("slack-blockkit-bridge is disabled by config");
  }

  const preparedInput = prepareSlackMessageInput(input, services.config);
  const result = await services.backend.postBlockMessage(preparedInput, services.config);
  const record = buildCardRecord(preparedInput, result);
  await services.store.upsertCard(record);
  return {
    ok: true,
    cardId: record.cardId,
    messageTs: result.messageTs,
    mode: result.mode,
    contentMode: preparedInput.contentMode,
  };
}

export async function updateSlackBlockKit(
  services: RuntimeServices,
  input: UpdateSlackMessageInput,
): Promise<{ ok: true; cardId: string; messageTs?: string; mode: "mock" | "live"; contentMode: "blocks" | "text" }> {
  if (!services.config.enabled) {
    throw new Error("slack-blockkit-bridge is disabled by config");
  }

  const record = await services.store.getCard(input.cardId);
  if (!record) {
    throw new Error(`card not found: ${input.cardId}`);
  }

  const preparedInput = prepareSlackUpdateInput(record, input, services.config);
  const result = await services.backend.updateMessage(preparedInput, services.config);
  const updatedRecord: CardRecord = {
    ...record,
    channel: preparedInput.channel,
    threadTs: preparedInput.threadTs,
    messageTs: result.messageTs ?? preparedInput.messageTs,
    text: preparedInput.text,
    blocks: preparedInput.blocks,
    contentMode: preparedInput.contentMode,
    metadata: preparedInput.metadata,
    state: preparedInput.state,
    postActionRenderMode: preparedInput.postActionRenderMode,
  };
  await services.store.upsertCard(updatedRecord);

  return {
    ok: true,
    cardId: updatedRecord.cardId,
    messageTs: updatedRecord.messageTs,
    mode: result.mode,
    contentMode: preparedInput.contentMode,
  };
}
