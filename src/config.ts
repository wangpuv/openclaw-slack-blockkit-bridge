import type { PluginConfig } from "./types.js";

export function normalizePluginConfig(input: Record<string, unknown>): PluginConfig {
  return {
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    allowChannels: Array.isArray(input.allowChannels)
      ? input.allowChannels.filter((v): v is string => typeof v === "string")
      : [],
    defaultReplyMode:
      input.defaultReplyMode === "ephemeral" ||
      input.defaultReplyMode === "none" ||
      input.defaultReplyMode === "in_channel"
        ? input.defaultReplyMode
        : "in_channel",
    storePath: typeof input.storePath === "string" ? input.storePath : undefined,
    fallbackToText:
      input.fallbackToText === undefined ? true : Boolean(input.fallbackToText),
    backend: input.backend === "native-openclaw" ? "native-openclaw" : "direct-slack-api",
    deliveryMode: input.deliveryMode === "live" ? "live" : "mock",
    botToken: typeof input.botToken === "string" ? input.botToken : undefined,
    tokenFile: typeof input.tokenFile === "string" ? input.tokenFile : undefined,
    requestTimeoutMs:
      typeof input.requestTimeoutMs === "number" && Number.isFinite(input.requestTimeoutMs) && input.requestTimeoutMs > 0
        ? Math.floor(input.requestTimeoutMs)
        : 10000,
    storeMode: "json",
    debug: input.debug === undefined ? false : Boolean(input.debug),
  };
}
