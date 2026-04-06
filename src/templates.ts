import type {
  CardActionDefinition,
  SendSlackBlockKitInput,
  SlackCardTemplateInput,
  SlackCardTemplateOption,
} from "./types.js";

function buildActionId(kind: SlackCardTemplateInput["kind"], value: string): string {
  return `wbk:${kind}:${value}`;
}

function normalizeOptions(input: SlackCardTemplateInput): SlackCardTemplateOption[] {
  if (Array.isArray(input.options) && input.options.length > 0) {
    return input.options;
  }

  switch (input.kind) {
    case "approval":
      return [
        { value: "approve", label: "Approve", style: "primary" },
        { value: "reject", label: "Reject", style: "danger" },
      ];
    case "task-progress":
      return [
        { value: "start", label: "开始", style: "primary" },
        { value: "done", label: "完成" },
      ];
    case "pick-one":
      return [];
    default:
      return [];
  }
}

export const TEMPLATE_KINDS = ["approval", "task-progress", "pick-one"] as const;

export function buildTemplateCard(input: SlackCardTemplateInput): SendSlackBlockKitInput {
  const options = normalizeOptions(input);

  if (input.kind === "pick-one" && options.length < 2) {
    throw new Error("pick-one template requires at least 2 options");
  }

  if (options.length === 0) {
    throw new Error(`template options are required for kind: ${input.kind}`);
  }

  const actions: CardActionDefinition[] = options.map((option) => ({
    actionId: buildActionId(input.kind, option.value),
    actionName: option.label,
  }));

  return {
    channel: input.channel,
    threadTs: input.threadTs,
    text: input.body ?? input.title,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: input.body ? `*${input.title}*\n${input.body}` : `*${input.title}*`,
        },
      },
      {
        type: "actions",
        elements: options.map((option) => ({
          type: "button",
          action_id: buildActionId(input.kind, option.value),
          text: {
            type: "plain_text",
            text: option.label,
          },
          ...(option.style ? { style: option.style } : {}),
        })),
      },
    ],
    sessionKey: input.sessionKey,
    actions,
    metadata: {
      templateKind: input.kind,
      ...(input.metadata ?? {}),
    },
    postActionRenderMode: input.postActionRenderMode,
  };
}
