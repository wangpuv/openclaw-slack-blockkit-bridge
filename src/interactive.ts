import { updateSlackBlockKit } from "./runtime.js";
import type { CardPayload, CardRecord, InteractionResolution, RuntimeServices } from "./types.js";

type ParsedInteractionData = {
  namespace: string;
  payload?: string;
};

type DecodedCardPayload = CardPayload;

export function parsePluginInteractionData(data: unknown): ParsedInteractionData | null {
  if (typeof data !== "string") return null;
  const trimmed = data.trim();
  if (!trimmed.startsWith("wbk:")) return null;
  const splitAt = trimmed.indexOf(":", 4);
  if (splitAt === -1) {
    return { namespace: trimmed };
  }
  return {
    namespace: trimmed.slice(0, splitAt),
    payload: trimmed.slice(splitAt + 1),
  };
}

export function decodeCardPayload(payload?: string): DecodedCardPayload | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as DecodedCardPayload;
    if (parsed?.p !== "slack-blockkit-bridge") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function buildReplyText(
  record: CardRecord | undefined,
  parsedPayload: DecodedCardPayload | null,
  fallbackActionId: string,
  options?: { duplicate?: boolean; clickCount?: number; actionLabel?: string },
): Promise<string> {
  const actionName =
    options?.actionLabel ??
    record?.actions.find((x) => x.actionId === fallbackActionId)?.actionName ??
    parsedPayload?.a ??
    fallbackActionId;

  if (!record && parsedPayload?.c) {
    return `已收到 Slack 交互：${actionName}（但对应卡片上下文不存在，可能已过期）`;
  }

  if (options?.duplicate) {
    return `已收到 Slack 交互：${actionName}（重复点击 ${options.clickCount ?? 2} 次）`;
  }

  return `已收到 Slack 交互：${actionName}`;
}

export function buildHandledStateBlocks(actionLabel: string): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ 已处理：${actionLabel}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "原操作已完成，按钮已收起。",
        },
      ],
    },
  ];
}

function normalizeReplyChannel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "slack") return undefined;
  return trimmed;
}

async function findRecordByInteractionMessage(services: RuntimeServices, args: any): Promise<CardRecord | undefined> {
  const messageTs = typeof args?.interaction?.messageTs === "string" ? args.interaction.messageTs : undefined;
  if (!messageTs) return undefined;

  const threadTs = typeof args?.interaction?.threadTs === "string" ? args.interaction.threadTs : undefined;
  const records = await services.store.list();
  const matches = records.filter((item) => {
    if (item.messageTs !== messageTs) return false;
    if (!threadTs) return true;
    return !item.threadTs || item.threadTs === threadTs;
  });

  return matches.at(-1);
}

function getReplyTarget(args: any, record?: CardRecord): { channel?: string; threadTs?: string } {
  const interactionChannel =
    normalizeReplyChannel(args?.interaction?.channel)
      ?? normalizeReplyChannel(args?.conversationId)
      ?? normalizeReplyChannel(args?.parentConversationId)
      ?? normalizeReplyChannel(args?.channel);

  const interactionThreadTs =
    typeof args?.interaction?.threadTs === "string"
      ? args.interaction.threadTs
      : typeof args?.threadTs === "string"
        ? args.threadTs
        : undefined;

  const interactionMessageTs =
    typeof args?.interaction?.messageTs === "string"
      ? args.interaction.messageTs
      : typeof args?.messageTs === "string"
        ? args.messageTs
        : undefined;

  const storedThreadTs = record?.threadTs;
  const storedMessageTs = record?.messageTs;
  const replyThreadTs = storedThreadTs ?? interactionThreadTs ?? storedMessageTs ?? interactionMessageTs;

  return {
    channel: record?.channel ?? interactionChannel,
    threadTs: replyThreadTs,
  };
}

function markSelectedLabel(text: string | undefined, actionLabel: string, handled: boolean): string | undefined {
  if (!text) return text;
  if (!handled) return text;
  return text === actionLabel ? `✅ ${text}` : text;
}

function preserveHandledElement(element: unknown, actionId: string, actionLabel: string): unknown {
  if (!element || typeof element !== "object") return element;
  const record = element as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  const elementActionId = typeof record.action_id === "string" ? record.action_id : typeof record.actionId === "string" ? record.actionId : undefined;

  if (typeof next.text === "object" && next.text && !Array.isArray(next.text)) {
    const textRecord = next.text as Record<string, unknown>;
    const rawText = typeof textRecord.text === "string" ? textRecord.text : undefined;
    next.text = {
      ...textRecord,
      text: markSelectedLabel(rawText, actionLabel, elementActionId === actionId),
    };
  }

  if (elementActionId?.startsWith("wbk:")) {
    next.style = elementActionId === actionId ? "primary" : undefined;
    next.disabled = true;
    if ("value" in next) {
      delete next.value;
    }
  }

  return next;
}

export function buildPreservedHandledBlocks(record: CardRecord, actionId: string, actionLabel: string): unknown[] {
  const sourceBlocks = Array.isArray(record.blocks) ? record.blocks : [];
  return sourceBlocks.map((block) => {
    if (!block || typeof block !== "object") return block;
    const blockRecord = block as Record<string, unknown>;
    const next: Record<string, unknown> = { ...blockRecord };

    if (Array.isArray(blockRecord.elements)) {
      next.elements = blockRecord.elements.map((element) => preserveHandledElement(element, actionId, actionLabel));
    }

    if (blockRecord.accessory && typeof blockRecord.accessory === "object") {
      next.accessory = preserveHandledElement(blockRecord.accessory, actionId, actionLabel);
    }

    if (blockRecord.type === "actions") {
      next.block_id = typeof blockRecord.block_id === "string" ? blockRecord.block_id : `handled:${record.cardId}`;
    }

    return next;
  }).concat({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `✅ 已处理：${actionLabel}`,
      },
    ],
  });
}

async function maybeUpdateHandledCard(
  services: RuntimeServices,
  record: CardRecord | undefined,
  actionId: string,
  actionLabel: string,
  duplicate: boolean | undefined,
  resolution: InteractionResolution | undefined,
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
): Promise<boolean> {
  if (!record || duplicate) return false;
  if (!record.messageTs) return false;
  if (resolution?.suppressDefaultUpdate) return false;

  const renderMode = resolution?.update?.postActionRenderModePatch ?? record.postActionRenderMode ?? "replace";
  const updateText = resolution?.update?.text ?? `Handled: ${actionLabel}`;
  const updateBlocks = resolution?.update?.blocks
    ?? (renderMode === "preserve"
      ? buildPreservedHandledBlocks(record, actionId, actionLabel)
      : buildHandledStateBlocks(actionLabel));

  try {
    await updateSlackBlockKit(services, {
      cardId: record.cardId,
      text: updateText,
      blocks: updateBlocks,
      statePatch: {
        status: "handled",
        handledAt: new Date().toISOString(),
        handledActionId: actionId,
        handledActionLabel: actionLabel,
        ...(resolution?.update?.statePatch ?? {}),
      },
      metadataPatch: {
        handledByBridge: true,
        ...(resolution?.update?.metadataPatch ?? {}),
      },
      postActionRenderModePatch: renderMode,
    });
    return true;
  } catch (error) {
    logger?.warn?.("[slack-blockkit-bridge] failed to update handled card", {
      cardId: record.cardId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function handleSlackInteraction(
  args: any,
  services: RuntimeServices,
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
): Promise<{ handled: boolean; replyMode?: "backend-thread" | "respond-reply" | "none"; updatedCard?: boolean }> {
  const data = args?.interaction?.data ?? args?.data;
  const parsed = parsePluginInteractionData(data);
  if (!parsed) {
    return { handled: false };
  }

  const parsedPayload = decodeCardPayload(args?.interaction?.value ?? parsed.payload);
  const cardId = parsedPayload?.c;
  const fallbackActionId = args?.interaction?.actionId ?? parsed.namespace;
  const initialRecord = cardId
    ? await services.store.getCard(cardId)
    : await findRecordByInteractionMessage(services, args);

  const actionResult = cardId ? await services.store.recordAction(cardId, fallbackActionId) : undefined;
  const record = actionResult?.record ?? initialRecord;

  if (services.config.debug) {
    logger?.info?.("[slack-blockkit-bridge] matched interactive payload", {
      namespace: parsed.namespace,
      actionId: args?.interaction?.actionId,
      cardId,
      interactionId: args?.interactionId,
      duplicate: actionResult?.duplicate ?? false,
      clickCount: actionResult?.state.clickCount,
    });
  }

  const defaultActionLabel =
    record?.actions.find((x) => x.actionId === fallbackActionId)?.actionName ??
    parsedPayload?.a ??
    fallbackActionId;

  const resolution = await services.resolveInteraction?.({
    args,
    cardId,
    record,
    actionId: fallbackActionId,
    actionLabel: defaultActionLabel,
    actionState: actionResult?.state,
    duplicate: actionResult?.duplicate ?? false,
    parsedPayload,
  });

  const actionLabel = resolution?.actionLabel ?? defaultActionLabel;
  const updatedCard = await maybeUpdateHandledCard(
    services,
    record,
    fallbackActionId,
    actionLabel,
    actionResult?.duplicate,
    resolution,
    logger,
  );

  const replyText = resolution?.replyText ?? await buildReplyText(record, parsedPayload, fallbackActionId, {
    duplicate: actionResult?.duplicate,
    clickCount: actionResult?.state.clickCount,
    actionLabel,
  });

  const replyMode = resolution?.suppressDefaultReply ? "none" : (resolution?.replyMode ?? services.config.defaultReplyMode);
  if (replyMode === "none") {
    return { handled: true, replyMode: "none", updatedCard };
  }

  const target = getReplyTarget(args, record);
  if ((replyMode === "backend-thread" || replyMode === "in_channel" || replyMode === "ephemeral") && target.channel && target.threadTs) {
    await services.backend.postThreadReply(
      {
        channel: target.channel,
        threadTs: target.threadTs,
        text: replyText,
      },
      services.config,
    );
    return { handled: true, replyMode: "backend-thread", updatedCard };
  }

  await args?.respond?.reply?.({
    text: replyText,
    responseType: replyMode,
  });

  return { handled: true, replyMode: "respond-reply", updatedCard };
}

export function registerInteractiveHandler(api: any, services: RuntimeServices): void {
  if (!api.registerInteractiveHandler) {
    api.logger.warn("[slack-blockkit-bridge] registerInteractiveHandler not available in this runtime");
    return;
  }

  api.registerInteractiveHandler({
    channel: "slack",
    namespace: "wbk",
    async handler(args: any) {
      return handleSlackInteraction(args, services, api.logger);
    },
  });
}
