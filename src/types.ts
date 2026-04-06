export type ReplyMode = "in_channel" | "ephemeral" | "none";
export type BackendMode = "direct-slack-api" | "native-openclaw";
export type DeliveryMode = "mock" | "live";
export type StoreMode = "json";
export type ContentMode = "blocks" | "text";
export type CardLifecycleStatus = "open" | "handled" | "archived";
export type PostActionRenderMode = "replace" | "preserve";

export interface PluginConfig {
  enabled: boolean;
  allowChannels: string[];
  defaultReplyMode: ReplyMode;
  storePath?: string;
  fallbackToText: boolean;
  backend: BackendMode;
  deliveryMode: DeliveryMode;
  botToken?: string;
  tokenFile?: string;
  requestTimeoutMs: number;
  storeMode: StoreMode;
  debug: boolean;
}

export interface CardActionDefinition {
  actionId: string;
  actionName: string;
}

export interface SlackCardTemplateOption {
  value: string;
  label: string;
  style?: "primary" | "danger";
}

export interface SlackCardTemplateInput {
  kind: "approval" | "task-progress" | "pick-one";
  title: string;
  body?: string;
  channel: string;
  threadTs?: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
  options?: SlackCardTemplateOption[];
  postActionRenderMode?: PostActionRenderMode;
}

export interface CardPayload {
  p: "slack-blockkit-bridge";
  v: 1;
  c: string;
  a: string;
  x?: string;
}

export interface CardState {
  status: CardLifecycleStatus;
  handledAt?: string;
  handledActionId?: string;
  handledActionLabel?: string;
  lastUpdatedAt?: string;
}

export interface SendSlackBlockKitInput {
  channel: string;
  threadTs?: string;
  text: string;
  blocks: unknown[];
  cardId?: string;
  sessionKey?: string;
  actions?: CardActionDefinition[];
  metadata?: Record<string, unknown>;
  state?: Partial<CardState>;
  postActionRenderMode?: PostActionRenderMode;
}

export interface UpdateSlackMessageInput {
  cardId: string;
  channel?: string;
  threadTs?: string;
  messageTs?: string;
  text?: string;
  blocks?: unknown[];
  metadataPatch?: Record<string, unknown>;
  statePatch?: Partial<CardState>;
  postActionRenderModePatch?: PostActionRenderMode;
}

export interface PreparedSlackMessageInput extends SendSlackBlockKitInput {
  cardId: string;
  blocks: unknown[];
  contentMode: ContentMode;
}

export interface PreparedSlackUpdateInput {
  cardId: string;
  channel: string;
  threadTs?: string;
  messageTs?: string;
  text: string;
  blocks: unknown[];
  metadata?: Record<string, unknown>;
  state: CardState;
  contentMode: ContentMode;
  postActionRenderMode: PostActionRenderMode;
}

export interface PostBlockMessageResult {
  ok: boolean;
  channel: string;
  threadTs?: string;
  messageTs?: string;
  backend: BackendMode;
  mode: DeliveryMode;
  contentMode?: ContentMode;
}

export interface UpdateMessageResult {
  ok: boolean;
  cardId: string;
  channel: string;
  threadTs?: string;
  messageTs?: string;
  backend: BackendMode;
  mode: DeliveryMode;
  contentMode: ContentMode;
}

export interface ThreadReplyInput {
  channel: string;
  threadTs?: string;
  text: string;
}

export interface CardActionState {
  actionKey: string;
  actionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  clickCount: number;
}

export interface CardRecord {
  cardId: string;
  channel: string;
  threadTs?: string;
  messageTs?: string;
  sessionKey?: string;
  createdAt: string;
  text: string;
  blocks: unknown[];
  contentMode: ContentMode;
  actions: CardActionDefinition[];
  metadata?: Record<string, unknown>;
  state: CardState;
  actionStates?: CardActionState[];
  postActionRenderMode: PostActionRenderMode;
}

export interface InteractionResolverInput {
  args: any;
  cardId?: string;
  record?: CardRecord;
  actionId: string;
  actionLabel: string;
  actionState?: CardActionState;
  duplicate: boolean;
  parsedPayload?: CardPayload | null;
}

export interface InteractionResolution {
  actionLabel?: string;
  replyText?: string;
  replyMode?: ReplyMode | "backend-thread" | "respond-reply" | "none";
  suppressDefaultReply?: boolean;
  suppressDefaultUpdate?: boolean;
  update?: Pick<UpdateSlackMessageInput, "text" | "blocks" | "metadataPatch" | "statePatch" | "postActionRenderModePatch">;
}

export interface RuntimeServices {
  config: PluginConfig;
  store: CardStore;
  backend: SlackCardBackend;
  resolveInteraction?: (input: InteractionResolverInput) => Promise<InteractionResolution | undefined>;
}

export interface RecordActionResult {
  record?: CardRecord;
  state: CardActionState;
  duplicate: boolean;
}

export interface CardStore {
  list(): Promise<CardRecord[]>;
  getCard(cardId: string): Promise<CardRecord | undefined>;
  upsertCard(record: CardRecord): Promise<void>;
  recordAction(cardId: string, actionId: string): Promise<RecordActionResult | undefined>;
}

export interface SlackCardBackend {
  postBlockMessage(input: PreparedSlackMessageInput, config: PluginConfig): Promise<PostBlockMessageResult>;
  postThreadReply(input: ThreadReplyInput, config: PluginConfig): Promise<PostBlockMessageResult>;
  updateMessage(input: PreparedSlackUpdateInput, config: PluginConfig): Promise<UpdateMessageResult>;
}
