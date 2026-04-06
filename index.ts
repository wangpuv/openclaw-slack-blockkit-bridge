import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createRuntimeServices, sendSlackBlockKit, updateSlackBlockKit } from "./src/runtime.js";
import { normalizePluginConfig } from "./src/config.js";
import { registerInteractiveHandler } from "./src/interactive.js";
import { buildTemplateCard, TEMPLATE_KINDS } from "./src/templates.js";

function parseActions(params: any): { actionId: string; actionName: string }[] {
  return Array.isArray(params?.actions)
    ? params.actions.filter(
        (item: unknown): item is { actionId: string; actionName: string } =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as { actionId?: unknown }).actionId === "string" &&
          typeof (item as { actionName?: unknown }).actionName === "string",
      )
    : [];
}

function parseMetadata(params: any): Record<string, unknown> | undefined {
  return params?.metadata && typeof params.metadata === "object"
    ? (params.metadata as Record<string, unknown>)
    : undefined;
}

function parsePostActionRenderMode(value: unknown): "replace" | "preserve" | undefined {
  return value === "replace" || value === "preserve" ? value : undefined;
}

export default definePluginEntry({
  id: "slack-blockkit-bridge",
  name: "Slack Block Kit Bridge",
  description:
    "Adds native Slack Block Kit delivery and custom interaction routing on top of the existing Slack channel.",
  register(api: any) {
    const config = normalizePluginConfig(api.pluginConfig ?? {});
    const services = createRuntimeServices({ api, config });

    api.logger.info(
      `[slack-blockkit-bridge] loaded backend=${config.backend} allowChannels=${config.allowChannels.join(",")} defaultReplyMode=${config.defaultReplyMode} enabled=${config.enabled} fallbackToText=${config.fallbackToText}`,
    );

    if (config.deliveryMode === "live" && !config.botToken && !config.tokenFile) {
      api.logger.warn("[slack-blockkit-bridge] WARNING: deliveryMode is \"live\" but no token configured (set botToken or tokenFile) — sends will fail");
    }

    if (config.backend === "native-openclaw") {
      api.logger.warn("[slack-blockkit-bridge] WARNING: backend \"native-openclaw\" is not implemented — requests will fail at runtime");
    }

    if (!config.enabled) {
      api.logger.info("[slack-blockkit-bridge] disabled by config; skipping handler and gateway registration");
      return;
    }

    registerInteractiveHandler(api, services);

    api.registerGatewayMethod("slack-blockkit-bridge.health", async ({ respond }: { respond: any }) => {
      respond(true, {
        plugin: "slack-blockkit-bridge",
        status: "ok",
        activePath: "slack-blockkit-bridge",
        backend: config.backend,
        deliveryMode: config.deliveryMode,
        tokenConfigured: !!(config.botToken || config.tokenFile),
        allowChannels: config.allowChannels,
        templates: [...TEMPLATE_KINDS],
      });
    });

    api.registerGatewayMethod("slack-blockkit-bridge.send", async ({ params, respond }: { params: any; respond: any }) => {
      try {
        const channel = typeof params?.channel === "string" ? params.channel : "";
        const threadTs = typeof params?.threadTs === "string" ? params.threadTs : undefined;
        const text = typeof params?.text === "string" ? params.text : "";
        const blocks = Array.isArray(params?.blocks) ? params.blocks : [];
        const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
        const actions = parseActions(params);
        const metadata = parseMetadata(params);
        const postActionRenderMode = parsePostActionRenderMode(params?.postActionRenderMode);

        if (!channel || !text) {
          respond(false, undefined, {
            code: "invalid_params",
            message: "channel and text are required",
          });
          return;
        }

        if (blocks.length === 0 && !config.fallbackToText) {
          respond(false, undefined, {
            code: "invalid_params",
            message: "blocks are required when fallbackToText is disabled",
          });
          return;
        }

        const result = await sendSlackBlockKit(services, {
          channel,
          threadTs,
          text,
          blocks,
          sessionKey,
          actions,
          metadata,
          postActionRenderMode,
        });

        respond(true, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(false, undefined, {
          code: "send_failed",
          message,
        });
      }
    });

    api.registerGatewayMethod("slack-blockkit-bridge.update", async ({ params, respond }: { params: any; respond: any }) => {
      try {
        const cardId = typeof params?.cardId === "string" ? params.cardId : "";
        const channel = typeof params?.channel === "string" ? params.channel : undefined;
        const threadTs = typeof params?.threadTs === "string" ? params.threadTs : undefined;
        const messageTs = typeof params?.messageTs === "string" ? params.messageTs : undefined;
        const text = typeof params?.text === "string" ? params.text : undefined;
        const blocks = Array.isArray(params?.blocks) ? params.blocks : undefined;
        const metadataPatch = params?.metadataPatch && typeof params.metadataPatch === "object"
          ? (params.metadataPatch as Record<string, unknown>)
          : undefined;
        const statePatch = params?.statePatch && typeof params.statePatch === "object"
          ? (params.statePatch as Record<string, unknown>)
          : undefined;
        const postActionRenderModePatch = parsePostActionRenderMode(params?.postActionRenderModePatch);

        if (!cardId) {
          respond(false, undefined, {
            code: "invalid_params",
            message: "cardId is required",
          });
          return;
        }

        if ((!text || text.length === 0) && (!Array.isArray(blocks) || blocks.length === 0)) {
          respond(false, undefined, {
            code: "invalid_params",
            message: "text or blocks are required",
          });
          return;
        }

        const result = await updateSlackBlockKit(services, {
          cardId,
          channel,
          threadTs,
          messageTs,
          text,
          blocks,
          metadataPatch,
          statePatch,
          postActionRenderModePatch,
        });

        respond(true, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(false, undefined, {
          code: "update_failed",
          message,
        });
      }
    });

    api.registerGatewayMethod("slack-blockkit-bridge.send-template", async ({ params, respond }: { params: any; respond: any }) => {
      try {
        const kind = typeof params?.kind === "string" ? params.kind : "";
        const title = typeof params?.title === "string" ? params.title : "";
        const body = typeof params?.body === "string" ? params.body : undefined;
        const channel = typeof params?.channel === "string" ? params.channel : "";
        const threadTs = typeof params?.threadTs === "string" ? params.threadTs : undefined;
        const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
        const metadata = parseMetadata(params);
        const postActionRenderMode = parsePostActionRenderMode(params?.postActionRenderMode);
        const options = Array.isArray(params?.options)
          ? params.options.filter((item: unknown) => Boolean(item) && typeof item === "object")
            .map((item: any) => ({
              value: String((item as { value?: unknown }).value ?? ""),
              label: String((item as { label?: unknown }).label ?? ""),
              style: (item as { style?: "primary" | "danger" }).style,
            }))
            .filter((item: { value: string; label: string }) => item.value && item.label)
          : undefined;

        const dryRun = params?.dryRun === true;

        if (!channel || !title || (kind !== "approval" && kind !== "task-progress" && kind !== "pick-one")) {
          respond(false, undefined, {
            code: "invalid_params",
            message: "kind, channel, and title are required; kind must be approval | task-progress | pick-one",
          });
          return;
        }

        const templateInput = buildTemplateCard({
          kind,
          title,
          body,
          channel,
          threadTs,
          sessionKey,
          metadata,
          options,
          postActionRenderMode,
        });

        if (dryRun) {
          respond(true, { dryRun: true, payload: templateInput });
          return;
        }

        const result = await sendSlackBlockKit(services, templateInput);
        respond(true, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(false, undefined, {
          code: "send_template_failed",
          message,
        });
      }
    });
  },
});
