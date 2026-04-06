import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type {
  CardPayload,
  CardRecord,
  PluginConfig,
  PostBlockMessageResult,
  PreparedSlackMessageInput,
  PreparedSlackUpdateInput,
  SendSlackBlockKitInput,
  SlackCardBackend,
  ThreadReplyInput,
  UpdateMessageResult,
} from "./types.js";

function ensureChannelAllowed(config: PluginConfig, channel: string): void {
  if (config.allowChannels.length > 0 && !config.allowChannels.includes(channel)) {
    throw new Error(`channel not allowed by slack-blockkit-bridge config: ${channel}`);
  }
}

export function makeCardId(): string {
  return `card_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function makeMockMessageTs(): string {
  const nowMs = Date.now();
  const sec = Math.floor(nowMs / 1000);
  const micros = String((nowMs % 1000) * 1000).padStart(6, "0");
  return `${sec}.${micros}`;
}

export function encodeCardPayload(payload: CardPayload): string {
  return JSON.stringify(payload);
}

export function injectCardContextIntoBlocks(blocks: unknown[], cardId: string): unknown[] {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block;
    const blockRecord = block as Record<string, unknown>;
    const elements = Array.isArray(blockRecord.elements) ? blockRecord.elements : undefined;
    const accessory = blockRecord.accessory && typeof blockRecord.accessory === "object" ? (blockRecord.accessory as Record<string, unknown>) : undefined;

    const next: Record<string, unknown> = { ...blockRecord };

    if (elements) {
      next.elements = elements.map((element) => injectCardContextIntoElement(element, cardId));
    }

    if (accessory) {
      next.accessory = injectCardContextIntoElement(accessory, cardId);
    }

    return next;
  });
}

function injectCardContextIntoElement(element: unknown, cardId: string): unknown {
  if (!element || typeof element !== "object") return element;
  const record = element as Record<string, unknown>;
  const actionId = typeof record.action_id === "string" ? record.action_id : typeof record.actionId === "string" ? record.actionId : undefined;

  if (!actionId || !actionId.startsWith("wbk:")) {
    return { ...record };
  }

  const originalValue = typeof record.value === "string" ? record.value : undefined;

  return {
    ...record,
    value: encodeCardPayload({
      p: "slack-blockkit-bridge",
      v: 1,
      c: cardId,
      a: actionId,
      ...(originalValue ? { x: originalValue } : {}),
    }),
  };
}

export function buildCardRecord(input: SendSlackBlockKitInput, result: PostBlockMessageResult): CardRecord {
  if (!input.cardId) {
    throw new Error("cardId is required before building a card record");
  }

  const rootThreadTs = input.threadTs ?? result.threadTs ?? result.messageTs;

  return {
    cardId: input.cardId,
    channel: input.channel,
    threadTs: rootThreadTs,
    messageTs: result.messageTs,
    sessionKey: input.sessionKey,
    createdAt: new Date().toISOString(),
    text: input.text,
    blocks: input.blocks,
    contentMode: result.contentMode ?? (Array.isArray(input.blocks) && input.blocks.length > 0 ? "blocks" : "text"),
    actions: input.actions ?? [],
    metadata: input.metadata,
    state: {
      status: input.state?.status ?? "open",
      handledAt: input.state?.handledAt,
      handledActionId: input.state?.handledActionId,
      handledActionLabel: input.state?.handledActionLabel,
      lastUpdatedAt: new Date().toISOString(),
    },
    postActionRenderMode: input.postActionRenderMode ?? "replace",
  };
}

function makeMockPostResult(
  channel: string,
  threadTs: string | undefined,
  config: PluginConfig,
  contentMode?: "blocks" | "text",
): PostBlockMessageResult {
  return {
    ok: true,
    channel,
    threadTs,
    messageTs: makeMockMessageTs(),
    backend: config.backend,
    mode: "mock",
    contentMode,
  };
}

function makeMockUpdateResult(
  input: PreparedSlackUpdateInput,
  config: PluginConfig,
): UpdateMessageResult {
  return {
    ok: true,
    cardId: input.cardId,
    channel: input.channel,
    threadTs: input.threadTs,
    messageTs: input.messageTs ?? makeMockMessageTs(),
    backend: config.backend,
    mode: "mock",
    contentMode: input.contentMode,
  };
}

async function loadBotToken(config: PluginConfig): Promise<string> {
  if (config.botToken && config.botToken.trim()) {
    return config.botToken.trim();
  }
  if (config.tokenFile && config.tokenFile.trim()) {
    const raw = await fs.readFile(config.tokenFile, "utf8");
    const token = raw.trim();
    if (token) return token;
  }
  throw new Error("slack bot token is required for live delivery (set botToken or tokenFile)");
}

function normalizeSlackApiError(message: string, status?: number): Error {
  if (/invalid_auth/i.test(message)) return new Error("slack auth failed: invalid_auth");
  if (/channel_not_found/i.test(message)) return new Error("slack request failed: channel_not_found");
  if (/not_in_channel/i.test(message)) return new Error("slack request failed: not_in_channel");
  if (/message_not_found/i.test(message)) return new Error("slack request failed: message_not_found");
  if (/rate[_ -]?limited/i.test(message) || status === 429) return new Error("slack request failed: rate_limited");
  return new Error(`slack request failed${status ? ` (${status})` : ""}: ${message}`);
}

async function slackApiCall<T>(
  method: "chat.postMessage" | "chat.update",
  body: Record<string, unknown>,
  config: PluginConfig,
): Promise<T & { ok: boolean; error?: string; ts?: string; message?: { ts?: string } }> {
  const token = await loadBotToken(config);
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  let json: any;
  try {
    json = await response.json();
  } catch {
    throw normalizeSlackApiError(`non-json response from ${method}`, response.status);
  }

  if (!response.ok || !json?.ok) {
    throw normalizeSlackApiError(typeof json?.error === "string" ? json.error : `http_${response.status}`, response.status);
  }

  return json;
}

function toSlackMessageBody(input: { channel: string; threadTs?: string; text: string; blocks?: unknown[] }) {
  const body: Record<string, unknown> = {
    channel: input.channel,
    text: input.text,
  };
  if (input.threadTs) body.thread_ts = input.threadTs;
  if (Array.isArray(input.blocks) && input.blocks.length > 0) body.blocks = input.blocks;
  return body;
}

export class DirectSlackApiBackend implements SlackCardBackend {
  async postBlockMessage(
    input: PreparedSlackMessageInput,
    config: PluginConfig,
  ): Promise<PostBlockMessageResult> {
    ensureChannelAllowed(config, input.channel);
    if (config.deliveryMode !== "live") {
      return makeMockPostResult(input.channel, input.threadTs, config, input.contentMode);
    }

    const response = await slackApiCall<{ channel?: string }>(
      "chat.postMessage",
      toSlackMessageBody({
        channel: input.channel,
        threadTs: input.threadTs,
        text: input.text,
        blocks: input.blocks,
      }),
      config,
    );

    return {
      ok: true,
      channel: typeof response.channel === "string" ? response.channel : input.channel,
      threadTs: input.threadTs,
      messageTs: response.ts,
      backend: config.backend,
      mode: "live",
      contentMode: input.contentMode,
    };
  }

  async postThreadReply(
    input: ThreadReplyInput,
    config: PluginConfig,
  ): Promise<PostBlockMessageResult> {
    ensureChannelAllowed(config, input.channel);
    if (config.deliveryMode !== "live") {
      return makeMockPostResult(input.channel, input.threadTs, config, "text");
    }

    const response = await slackApiCall<{ channel?: string }>(
      "chat.postMessage",
      toSlackMessageBody({
        channel: input.channel,
        threadTs: input.threadTs,
        text: input.text,
      }),
      config,
    );

    return {
      ok: true,
      channel: typeof response.channel === "string" ? response.channel : input.channel,
      threadTs: input.threadTs,
      messageTs: response.ts,
      backend: config.backend,
      mode: "live",
      contentMode: "text",
    };
  }

  async updateMessage(
    input: PreparedSlackUpdateInput,
    config: PluginConfig,
  ): Promise<UpdateMessageResult> {
    ensureChannelAllowed(config, input.channel);
    if (config.deliveryMode !== "live") {
      return makeMockUpdateResult(input, config);
    }

    if (!input.messageTs) {
      throw new Error(`slack update requires messageTs for live delivery: ${input.cardId}`);
    }

    const response = await slackApiCall<{ channel?: string }>(
      "chat.update",
      {
        channel: input.channel,
        ts: input.messageTs,
        text: input.text,
        ...(input.blocks.length > 0 ? { blocks: input.blocks } : {}),
      },
      config,
    );

    return {
      ok: true,
      cardId: input.cardId,
      channel: typeof response.channel === "string" ? response.channel : input.channel,
      threadTs: input.threadTs,
      messageTs: response.ts ?? input.messageTs,
      backend: config.backend,
      mode: "live",
      contentMode: input.contentMode,
    };
  }
}

export class NativeOpenClawBackend implements SlackCardBackend {
  async postBlockMessage(
    input: PreparedSlackMessageInput,
    config: PluginConfig,
  ): Promise<PostBlockMessageResult> {
    ensureChannelAllowed(config, input.channel);
    throw new Error("native-openclaw backend is not implemented yet");
  }

  async postThreadReply(
    input: ThreadReplyInput,
    config: PluginConfig,
  ): Promise<PostBlockMessageResult> {
    ensureChannelAllowed(config, input.channel);
    throw new Error("native-openclaw backend is not implemented yet");
  }

  async updateMessage(
    input: PreparedSlackUpdateInput,
    config: PluginConfig,
  ): Promise<UpdateMessageResult> {
    ensureChannelAllowed(config, input.channel);
    throw new Error("native-openclaw backend is not implemented yet");
  }
}

export function createSlackCardBackend(config: PluginConfig): SlackCardBackend {
  if (config.backend === "native-openclaw") {
    return new NativeOpenClawBackend();
  }
  return new DirectSlackApiBackend();
}
