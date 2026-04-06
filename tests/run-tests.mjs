import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distRoot = new URL("../.test-dist/", import.meta.url);
const interactive = await import(pathToFileURL(path.resolve(new URL("../.test-dist/src/interactive.js", import.meta.url).pathname)).href);
const runtime = await import(pathToFileURL(path.resolve(new URL("../.test-dist/src/runtime.js", import.meta.url).pathname)).href);
const slackApi = await import(pathToFileURL(path.resolve(new URL("../.test-dist/src/slack-api.js", import.meta.url).pathname)).href);
const storeModule = await import(pathToFileURL(path.resolve(new URL("../.test-dist/src/store.js", import.meta.url).pathname)).href);
const configModule = await import(pathToFileURL(path.resolve(new URL("../.test-dist/src/config.js", import.meta.url).pathname)).href);

const {
  parsePluginInteractionData,
  decodeCardPayload,
  buildReplyText,
  buildHandledStateBlocks,
  buildPreservedHandledBlocks,
  handleSlackInteraction,
} = interactive;
const { createRuntimeServices, mergeCardState, prepareSlackMessageInput, prepareSlackUpdateInput, sendSlackBlockKit, updateSlackBlockKit } = runtime;
const { injectCardContextIntoBlocks, createSlackCardBackend, buildCardRecord } = slackApi;
const { JsonCardStore } = storeModule;
const { normalizePluginConfig } = configModule;
const templates = await import(pathToFileURL(path.resolve(new URL("../.test-dist/src/templates.js", import.meta.url).pathname)).href);
const { buildTemplateCard } = templates;

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    allowChannels: [],
    defaultReplyMode: "in_channel",
    storePath: undefined,
    fallbackToText: true,
    backend: "direct-slack-api",
    debug: false,
    ...overrides,
  };
}

function makeServices(store, configOverrides = {}, backendOverrides = {}) {
  const config = makeConfig(configOverrides);
  const baseBackend = createSlackCardBackend(config);
  const backend = Object.assign(Object.create(Object.getPrototypeOf(baseBackend)), baseBackend, backendOverrides);
  const runtimeServices = createRuntimeServices({
    api: {
      resolvePath(input) {
        return input;
      },
    },
    config,
  });
  return {
    config,
    store,
    backend,
    resolveInteraction: runtimeServices.resolveInteraction,
  };
}
void distRoot;


async function testBuildTemplateCardApproval() {
  const card = buildTemplateCard({
    kind: "approval",
    title: "是否发布？",
    body: "请确认是否发送这条内容。",
    channel: "C123",
  });

  assert.equal(card.channel, "C123");
  assert.equal(card.actions.length, 2);
  assert.equal(card.actions[0].actionId, "wbk:approval:approve");
  assert.equal(card.actions[1].actionId, "wbk:approval:reject");
  assert.equal(card.metadata?.templateKind, "approval");
}

async function testBuildTemplateCardPickOneRequiresOptions() {
  assert.throws(
    () => buildTemplateCard({
      kind: "pick-one",
      title: "今天先做什么？",
      channel: "C123",
    }),
    /at least 2 options/,
  );
}

async function testNormalizePluginConfigSupportsLiveFields() {
  const config = normalizePluginConfig({
    deliveryMode: "live",
    tokenFile: "~/token.txt",
    requestTimeoutMs: 15000,
  });
  assert.equal(config.deliveryMode, "live");
  assert.equal(config.tokenFile, "~/token.txt");
  assert.equal(config.requestTimeoutMs, 15000);
}

async function testDirectSlackApiBackendUsesMockUnlessLive() {
  const backend = createSlackCardBackend({
    enabled: true,
    allowChannels: ["C1"],
    defaultReplyMode: "in_channel",
    storePath: undefined,
    fallbackToText: true,
    backend: "direct-slack-api",
    deliveryMode: "mock",
    botToken: undefined,
    tokenFile: undefined,
    requestTimeoutMs: 1000,
    storeMode: "json",
    debug: false,
  });
  const result = await backend.postBlockMessage({ channel: "C1", text: "x", blocks: [], cardId: "card-1", contentMode: "text" }, {
    enabled: true,
    allowChannels: ["C1"],
    defaultReplyMode: "in_channel",
    storePath: undefined,
    fallbackToText: true,
    backend: "direct-slack-api",
    deliveryMode: "mock",
    botToken: undefined,
    tokenFile: undefined,
    requestTimeoutMs: 1000,
    storeMode: "json",
    debug: false,
  });
  assert.equal(result.mode, "mock");
}

async function testDirectSlackApiBackendRequiresTokenInLiveMode() {
  const backend = createSlackCardBackend({
    enabled: true,
    allowChannels: ["C1"],
    defaultReplyMode: "in_channel",
    storePath: undefined,
    fallbackToText: true,
    backend: "direct-slack-api",
    deliveryMode: "live",
    botToken: undefined,
    tokenFile: undefined,
    requestTimeoutMs: 1000,
    storeMode: "json",
    debug: false,
  });
  await assert.rejects(
    () => backend.postBlockMessage({ channel: "C1", text: "x", blocks: [], cardId: "card-1", contentMode: "text" }, {
      enabled: true,
      allowChannels: ["C1"],
      defaultReplyMode: "in_channel",
      storePath: undefined,
      fallbackToText: true,
      backend: "direct-slack-api",
      deliveryMode: "live",
      botToken: undefined,
      tokenFile: undefined,
      requestTimeoutMs: 1000,
      storeMode: "json",
      debug: false,
    }),
    /slack bot token is required/,
  );
}

async function testParsePluginInteractionData() {
  assert.equal(parsePluginInteractionData(null), null);
  assert.equal(parsePluginInteractionData("hello"), null);
  assert.deepEqual(parsePluginInteractionData("wbk:review:approve"), {
    namespace: "wbk:review",
    payload: "approve",
  });
  assert.deepEqual(parsePluginInteractionData("wbk:review"), {
    namespace: "wbk:review",
  });
}

async function testDecodeCardPayload() {
  assert.equal(decodeCardPayload(undefined), null);
  assert.equal(decodeCardPayload("not-json"), null);
  assert.deepEqual(
    decodeCardPayload(JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" })),
    { p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" },
  );
}

async function testJsonCardStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-store-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);

  assert.deepEqual(await store.list(), []);

  const record = {
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "test",
    blocks: [],
    contentMode: "text",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: { foo: "bar" },
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "replace",
  };

  await store.upsertCard(record);
  assert.equal((await store.getCard("card-1"))?.messageTs, "123.5");
  assert.equal((await store.list()).length, 1);

  await store.upsertCard({ ...record, messageTs: "123.6" });
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.getCard("card-1"))?.messageTs, "123.6");
}



async function testJsonCardStoreNormalizesLegacyMetadataState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-store-legacy-"));
  const file = path.join(dir, "cards.json");
  await fs.writeFile(
    file,
    JSON.stringify([
      {
        cardId: "card-legacy-1",
        channel: "C123",
        threadTs: "123.4",
        messageTs: "123.5",
        sessionKey: "session-1",
        createdAt: "2026-03-26T00:00:00.000Z",
        text: "legacy",
        blocks: [],
        contentMode: "text",
        postActionRenderMode: "replace",
        actions: [{ actionId: "wbk:review", actionName: "approve" }],
        metadata: {
          handled: true,
          handledAction: "approve",
        },
      },
    ], null, 2),
    "utf8",
  );

  const store = new JsonCardStore(file);
  const saved = await store.getCard("card-legacy-1");
  assert.equal(saved?.state.status, "handled");
  assert.equal(saved?.state.handledActionLabel, "approve");
  assert.equal(typeof saved?.state.lastUpdatedAt, "string");
}

async function testJsonCardStoreRecordAction() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-store-action-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);

  await store.upsertCard({
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "test",
    blocks: [],
    contentMode: "text",
    actions: [],
    metadata: {},
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "replace",
  });

  const first = await store.recordAction("card-1", "wbk:review");
  const second = await store.recordAction("card-1", "wbk:review");

  assert.equal(first?.duplicate, false);
  assert.equal(first?.state.clickCount, 1);
  assert.equal(second?.duplicate, true);
  assert.equal(second?.state.clickCount, 2);

  const saved = await store.getCard("card-1");
  assert.equal(saved?.actionStates?.length, 1);
  assert.equal(saved?.actionStates?.[0]?.clickCount, 2);
}

async function testHandleSlackInteractionPrefersBackendThreadReply() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-handler-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);

  await store.upsertCard({
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "test",
    blocks: [],
    contentMode: "text",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: {},
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "replace",
  });

  const replies = [];
  const backendCalls = [];
  const services = makeServices(
    store,
    { storePath: file },
    {
      postThreadReply: async (input, config) => {
        backendCalls.push({ input, config });
        return {
          ok: true,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
        };
      },
    },
  );

  const updateCalls = [];
  services.backend.updateMessage = async (input, config) => {
    updateCalls.push({ input, config });
    return {
      ok: true,
      cardId: input.cardId,
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: "123.777",
      backend: config.backend,
      mode: "mock",
      contentMode: input.contentMode,
    };
  };

  const handled = await handleSlackInteraction(
    {
      interactionId: "it-1",
      interaction: {
        data: 'wbk:review:' + JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
        value: JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
        actionId: "wbk:review",
        channel: "C123",
        threadTs: "123.4",
      },
      respond: {
        reply: async (params) => {
          replies.push(params);
        },
      },
    },
    services,
  );

  assert.deepEqual(handled, { handled: true, replyMode: "backend-thread", updatedCard: true });
  assert.equal(replies.length, 0);
  assert.equal(backendCalls.length, 1);
  assert.equal(backendCalls[0].input.channel, "C123");
  assert.equal(backendCalls[0].input.threadTs, "123.4");
  assert.equal(backendCalls[0].input.text, "已收到 Slack 交互：approve");
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].input.cardId, "card-1");
  assert.equal(updateCalls[0].input.state.status, "handled");
  assert.equal(updateCalls[0].input.state.handledActionLabel, "approve");
  assert.equal(updateCalls[0].input.metadata.handledByBridge, true);
}



async function testHandleSlackInteractionUsesPreserveRenderMode() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-handler-preserve-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);

  await store.upsertCard({
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "review request",
    blocks: [{ type: "actions", elements: [{ type: "button", action_id: "wbk:review", text: { type: "plain_text", text: "approve" }, value: "x" }] }],
    contentMode: "blocks",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: {},
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "preserve",
  });

  const backendCalls = [];
  const services = makeServices(
    store,
    { storePath: file },
    {
      postThreadReply: async (input, config) => {
        backendCalls.push({ input, config });
        return {
          ok: true,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
          contentMode: "text",
        };
      },
    },
  );

  const updateCalls = [];
  services.backend.updateMessage = async (input, config) => {
    updateCalls.push({ input, config });
    return {
      ok: true,
      cardId: input.cardId,
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: "123.777",
      backend: config.backend,
      mode: "mock",
      contentMode: input.contentMode,
    };
  };

  const handled = await handleSlackInteraction(
    {
      interactionId: "it-preserve-1",
      interaction: {
        data: 'wbk:review:' + JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
        value: JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
        actionId: "wbk:review",
        channel: "C123",
        threadTs: "123.4",
      },
    },
    services,
  );

  assert.deepEqual(handled, { handled: true, replyMode: "backend-thread", updatedCard: true });
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].input.postActionRenderMode, "preserve");
  assert.equal(updateCalls[0].input.blocks[0].elements[0].disabled, true);
  assert.match(updateCalls[0].input.blocks[0].elements[0].text.text, /^✅ approve$/);
  assert.equal(updateCalls[0].input.blocks.at(-1).type, "context");
}

async function testHandleSlackInteractionUsesResolverExtension() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-handler-resolver-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);

  await store.upsertCard({
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "review request",
    blocks: [{ type: "actions", elements: [{ type: "button", action_id: "wbk:review", text: { type: "plain_text", text: "approve" }, value: "x" }] }],
    contentMode: "blocks",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: {},
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "replace",
  });

  const backendCalls = [];
  const services = makeServices(
    store,
    { storePath: file },
    {
      postThreadReply: async (input, config) => {
        backendCalls.push({ input, config });
        return {
          ok: true,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
          contentMode: "text",
        };
      },
    },
  );

  services.resolveInteraction = async ({ actionLabel, duplicate, actionState }) => ({
    actionLabel: `${actionLabel}!`,
    replyText: `custom reply ${actionState?.clickCount ?? 0}`,
    update: {
      text: "custom handled",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `custom block ${duplicate}` } }],
      metadataPatch: { resolver: true },
      postActionRenderModePatch: "preserve",
    },
  });

  const updateCalls = [];
  services.backend.updateMessage = async (input, config) => {
    updateCalls.push({ input, config });
    return {
      ok: true,
      cardId: input.cardId,
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: "123.777",
      backend: config.backend,
      mode: "mock",
      contentMode: input.contentMode,
    };
  };

  const handled = await handleSlackInteraction(
    {
      interactionId: "it-resolver-1",
      interaction: {
        data: 'wbk:review:' + JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
        value: JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
        actionId: "wbk:review",
        channel: "C123",
        threadTs: "123.4",
      },
    },
    services,
  );

  assert.deepEqual(handled, { handled: true, replyMode: "backend-thread", updatedCard: true });
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].input.text, "custom handled");
  assert.equal(updateCalls[0].input.blocks[0].text.text, "custom block false");
  assert.equal(updateCalls[0].input.metadata.resolver, true);
  assert.equal(updateCalls[0].input.postActionRenderMode, "preserve");
  assert.equal(backendCalls[0].input.text, "custom reply 1");
}

async function testHandleSlackInteractionMarksDuplicateClicks() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-handler-dup-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);

  await store.upsertCard({
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "test",
    blocks: [],
    contentMode: "text",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: {},
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "replace",
  });

  const backendCalls = [];
  const services = makeServices(
    store,
    { storePath: file },
    {
      postThreadReply: async (input, config) => {
        backendCalls.push({ input, config });
        return {
          ok: true,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
          contentMode: "text",
        };
      },
    },
  );

  const updateCalls = [];
  services.backend.updateMessage = async (input, config) => {
    updateCalls.push({ input, config });
    return {
      ok: true,
      cardId: input.cardId,
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: "123.777",
      backend: config.backend,
      mode: "mock",
      contentMode: input.contentMode,
    };
  };

  const args = {
    interactionId: "it-dup",
    interaction: {
      data: 'wbk:review:' + JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
      value: JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-1", a: "approve" }),
      actionId: "wbk:review",
      channel: "C123",
      messageTs: "123.5",
    },
  };

  await handleSlackInteraction(args, services);
  const second = await handleSlackInteraction(args, services);

  assert.deepEqual(second, { handled: true, replyMode: "backend-thread", updatedCard: false });
  assert.equal(backendCalls.length, 2);
  assert.equal(backendCalls[1].input.text, "已收到 Slack 交互：approve（重复点击 2 次）");
  assert.equal(updateCalls.length, 1);
}

async function testHandleSlackInteractionFallsBackToRespondReply() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-handler-fallback-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  const replies = [];
  const backendCalls = [];
  const services = makeServices(
    store,
    { storePath: file },
    {
      postThreadReply: async (input, config) => {
        backendCalls.push({ input, config });
        return {
          ok: true,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
        };
      },
    },
  );

  const handled = await handleSlackInteraction(
    {
      interactionId: "it-2",
      interaction: {
        data: 'wbk:review:' + JSON.stringify({ p: "slack-blockkit-bridge", v: 1, a: "approve" }),
        value: JSON.stringify({ p: "slack-blockkit-bridge", v: 1, a: "approve" }),
        actionId: "wbk:review",
      },
      respond: {
        reply: async (params) => {
          replies.push(params);
        },
      },
    },
    services,
  );

  assert.deepEqual(handled, { handled: true, replyMode: "respond-reply", updatedCard: false });
  assert.equal(backendCalls.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "已收到 Slack 交互：approve");
  assert.equal(replies[0].responseType, "in_channel");
}

async function testHandleSlackInteractionSkipsReplyWhenModeNone() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-handler-none-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  const replies = [];
  const backendCalls = [];
  const services = makeServices(
    store,
    { storePath: file, defaultReplyMode: "none" },
    {
      postThreadReply: async (input, config) => {
        backendCalls.push({ input, config });
        return {
          ok: true,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
        };
      },
    },
  );

  const handled = await handleSlackInteraction(
    {
      interactionId: "it-3",
      interaction: {
        data: 'wbk:review:' + JSON.stringify({ p: "slack-blockkit-bridge", v: 1, a: "approve" }),
        value: JSON.stringify({ p: "slack-blockkit-bridge", v: 1, a: "approve" }),
        actionId: "wbk:review",
      },
      respond: {
        reply: async (params) => {
          replies.push(params);
        },
      },
    },
    services,
  );

  assert.deepEqual(handled, { handled: true, replyMode: "none", updatedCard: false });
  assert.equal(backendCalls.length, 0);
  assert.equal(replies.length, 0);
}

async function testBuildReplyTextMissingCard() {
  const text = await buildReplyText(undefined, { c: "missing-card", a: "approve", p: "slack-blockkit-bridge", v: 1 }, "wbk:review");
  assert.match(text, /对应卡片上下文不存在/);
}


async function testBuildHandledStateBlocks() {
  const blocks = buildHandledStateBlocks("approve");
  assert.equal(Array.isArray(blocks), true);
  assert.equal(blocks[0].type, "section");
  assert.match(blocks[0].text.text, /已处理.*approve/);
  assert.equal(blocks[1].type, "context");
}

async function testBuildPreservedHandledBlocks() {
  const blocks = buildPreservedHandledBlocks(
    {
      cardId: "card-1",
      channel: "C123",
      threadTs: "123.4",
      messageTs: "123.5",
      sessionKey: "session-1",
      createdAt: "2026-03-26T00:00:00.000Z",
      text: "review request",
      blocks: [
        {
          type: "actions",
          elements: [
            { type: "button", action_id: "wbk:review:approve", text: { type: "plain_text", text: "Approve" }, value: "x" },
            { type: "button", action_id: "wbk:review:reject", text: { type: "plain_text", text: "Reject" }, value: "y" },
          ],
        },
      ],
      contentMode: "blocks",
      actions: [
        { actionId: "wbk:review:approve", actionName: "Approve" },
        { actionId: "wbk:review:reject", actionName: "Reject" },
      ],
      metadata: {},
      state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
      postActionRenderMode: "preserve",
    },
    "wbk:review:approve",
    "Approve",
  );

  assert.equal(Array.isArray(blocks), true);
  assert.equal(blocks[0].type, "actions");
  assert.equal(blocks[0].elements[0].disabled, true);
  assert.equal(blocks[0].elements[1].disabled, true);
  assert.equal(blocks[0].elements[0].value, undefined);
  assert.match(blocks[0].elements[0].text.text, /^✅ Approve$/);
  assert.equal(blocks.at(-1).type, "context");
}

async function testInjectCardContextIntoBlocks() {
  const cardId = "card-test-1";
  const blocks = [
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "wbk:approve", text: { type: "plain_text", text: "Approve" } },
        { type: "button", action_id: "other:noop", text: { type: "plain_text", text: "Ignore" } },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "hello" },
      accessory: { type: "button", action_id: "wbk:reject", text: { type: "plain_text", text: "Reject" } },
    },
  ];

  const next = injectCardContextIntoBlocks(blocks, cardId);
  const approvePayload = JSON.parse(next[0].elements[0].value);
  const rejectPayload = JSON.parse(next[1].accessory.value);

  assert.equal(approvePayload.c, cardId);
  assert.equal(approvePayload.a, "wbk:approve");
  assert.equal(next[0].elements[1].value, undefined);
  assert.equal(rejectPayload.a, "wbk:reject");
}



async function testMergeCardState() {
  const state = mergeCardState(
    { status: "open" },
    { status: "handled", handledActionLabel: "approve" },
  );
  assert.equal(state.status, "handled");
  assert.equal(state.handledActionLabel, "approve");
  assert.equal(typeof state.lastUpdatedAt, "string");
}

async function testPrepareSlackMessageInputUsesTextFallback() {
  const prepared = prepareSlackMessageInput(
    {
      channel: "C123",
      text: "fallback text",
      blocks: [],
    },
    makeConfig({ fallbackToText: true }),
  );

  assert.equal(prepared.contentMode, "text");
  assert.deepEqual(prepared.blocks, []);
  assert.match(prepared.cardId, /^card_/);
}

async function testPrepareSlackMessageInputRejectsEmptyBlocksWhenFallbackDisabled() {
  assert.throws(
    () =>
      prepareSlackMessageInput(
        {
          channel: "C123",
          text: "fallback text",
          blocks: [],
        },
        makeConfig({ fallbackToText: false }),
      ),
    /blocks are required when fallbackToText is disabled/,
  );
}


async function testPrepareSlackUpdateInputUsesRecordAndInjectsBlocks() {
  const record = {
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "test",
    blocks: [],
    contentMode: "text",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: { state: "open" },
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "replace",
  };

  const prepared = prepareSlackUpdateInput(
    record,
    {
      cardId: "card-1",
      text: "updated",
      blocks: [{ type: "actions", elements: [{ type: "button", action_id: "wbk:review" }] }],
      metadataPatch: { state: "closed" },
    },
    makeConfig({ fallbackToText: true }),
  );

  assert.equal(prepared.channel, "C123");
  assert.equal(prepared.messageTs, "123.5");
  assert.equal(prepared.contentMode, "blocks");
  assert.equal(prepared.metadata.state, "closed");
  assert.equal(prepared.state.status, "open");
  const payload = JSON.parse(prepared.blocks[0].elements[0].value);
  assert.equal(payload.c, "card-1");
}

async function testPrepareSlackUpdateInputRejectsEmptyUpdate() {
  const record = {
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    actions: [],
    metadata: {},
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
  };

  assert.throws(
    () => prepareSlackUpdateInput(record, { cardId: "card-1" }, makeConfig({ fallbackToText: true })),
    /text or blocks are required for updateMessage/,
  );
}

async function testSendSlackBlockKitPersistsCardAndInjectedPayload() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-send-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  const services = makeServices(store, { storePath: file, allowChannels: ["C123"] });

  const result = await sendSlackBlockKit(services, {
    channel: "C123",
    threadTs: "111.222",
    text: "test",
    blocks: [{ type: "actions", elements: [{ type: "button", action_id: "wbk:review" }] }],
    sessionKey: "session-1",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: { source: "test" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "mock");
  assert.equal(result.contentMode, "blocks");
  assert.match(result.cardId, /^card_/);
  const saved = await store.getCard(result.cardId);
  assert.equal(saved?.channel, "C123");
  assert.equal(saved?.threadTs, "111.222");
  assert.equal(saved?.actions.length, 1);
}


async function testBuildCardRecordUsesRootMessageTsAsThreadRoot() {
  const record = buildCardRecord(
    {
      channel: "C123",
      text: "test",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
      cardId: "card-root-1",
      actions: [{ actionId: "wbk:review", actionName: "approve" }],
    },
    {
      ok: true,
      channel: "C123",
      messageTs: "999.111",
      backend: "direct-slack-api",
      mode: "mock",
      contentMode: "blocks",
    },
  );

  assert.equal(record.threadTs, "999.111");
  assert.equal(record.messageTs, "999.111");
}

async function testSendSlackBlockKitUsesTextFallbackMode() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-send-text-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  const services = makeServices(store, { storePath: file, allowChannels: ["C123"], fallbackToText: true });

  const result = await sendSlackBlockKit(services, {
    channel: "C123",
    text: "text-only fallback",
    blocks: [],
    sessionKey: "session-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "mock");
  assert.equal(result.contentMode, "text");
  const saved = await store.getCard(result.cardId);
  assert.equal(saved?.channel, "C123");
}


async function testUpdateSlackBlockKitPersistsUpdatedMessageState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-update-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  await store.upsertCard({
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: { state: "open" },
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
  });

  const updateCalls = [];
  const services = makeServices(
    store,
    { storePath: file, allowChannels: ["C123"] },
    {
      updateMessage: async (input, config) => {
        updateCalls.push({ input, config });
        return {
          ok: true,
          cardId: input.cardId,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
          contentMode: input.contentMode,
        };
      },
    },
  );

  const result = await updateSlackBlockKit(services, {
    cardId: "card-1",
    text: "updated",
    blocks: [{ type: "actions", elements: [{ type: "button", action_id: "wbk:review" }] }],
    metadataPatch: { state: "closed" },
    statePatch: { status: "handled", handledActionLabel: "approve" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.contentMode, "blocks");
  assert.equal(updateCalls.length, 1);
  const saved = await store.getCard("card-1");
  assert.equal(saved?.messageTs, "123.999");
  assert.equal(saved?.metadata?.state, "closed");
  assert.equal(saved?.state.status, "handled");
  assert.equal(saved?.state.handledActionLabel, "approve");
}

async function testBuildReplyTextPrefersProvidedActionLabel() {
  const text = await buildReplyText(
    undefined,
    { c: "missing-card", a: "wbk:review:approve", p: "slack-blockkit-bridge", v: 1 },
    "wbk:review",
    { actionLabel: "approve" },
  );
  assert.match(text, /已收到 Slack 交互：approve/);
}

async function testUpdateSlackBlockKitRejectsMissingCard() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-update-missing-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  const services = makeServices(store, { storePath: file, allowChannels: ["C123"] });

  await assert.rejects(
    () => updateSlackBlockKit(services, { cardId: "missing", text: "updated" }),
    /card not found: missing/,
  );
}

async function testUpdateGatewayPassesStatePatchShapeViaRuntimePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-update-statepatch-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  await store.upsertCard({
    cardId: "card-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "test",
    blocks: [],
    contentMode: "text",
    actions: [{ actionId: "wbk:review", actionName: "approve" }],
    metadata: {},
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "replace",
  });

  const updateCalls = [];
  const services = makeServices(
    store,
    { storePath: file, allowChannels: ["C123"] },
    {
      updateMessage: async (input, config) => {
        updateCalls.push({ input, config });
        return {
          ok: true,
          cardId: input.cardId,
          channel: input.channel,
          threadTs: input.threadTs,
          messageTs: "123.999",
          backend: config.backend,
          mode: "mock",
          contentMode: input.contentMode,
        };
      },
    },
  );

  const result = await updateSlackBlockKit(services, {
    cardId: "card-1",
    text: "updated",
    statePatch: { status: "handled", handledActionId: "wbk:review" },
  });

  assert.equal(result.ok, true);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].input.state.status, "handled");
  assert.equal(updateCalls[0].input.state.handledActionId, "wbk:review");
}

async function testCreateRuntimeServicesResolvesStorePath() {
  const resolvedPaths = [];
  const services = createRuntimeServices({
    api: {
      resolvePath(input) {
        resolvedPaths.push(input);
        return input;
      },
    },
    config: {
      enabled: true,
      allowChannels: [],
      defaultReplyMode: "in_channel",
      storePath: "~/custom/cards.json",
      fallbackToText: true,
      backend: "direct-slack-api",
      debug: false,
    },
  });

  assert.ok(services.store);
  assert.equal(resolvedPaths.length, 1);
  assert.match(resolvedPaths[0], /custom\/cards\.json$/);
}

async function testSendSlackBlockKitRejectsDisallowedChannel() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-send-deny-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  const services = makeServices(store, { storePath: file, allowChannels: ["C123"] });

  await assert.rejects(
    () =>
      sendSlackBlockKit(services, {
        channel: "C999",
        text: "test",
        blocks: [{ type: "section" }],
      }),
    /channel not allowed/,
  );
}

async function testSendSlackBlockKitRejectsWhenDisabled() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-send-disabled-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);
  const services = makeServices(store, { storePath: file, enabled: false });

  await assert.rejects(
    () =>
      sendSlackBlockKit(services, {
        channel: "C123",
        text: "test",
        blocks: [{ type: "section" }],
      }),
    /disabled by config/,
  );
}


async function testHandleSlackInteractionGradesPickManyFromStateValues() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbk-handler-pick-many-"));
  const file = path.join(dir, "cards.json");
  const store = new JsonCardStore(file);

  await store.upsertCard({
    cardId: "card-pick-many-1",
    channel: "C123",
    threadTs: "123.4",
    messageTs: "123.5",
    sessionKey: "session-1",
    createdAt: "2026-03-26T00:00:00.000Z",
    text: "pick many",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*Quiz Question*\nWhich are prime numbers?" } },
      {
        type: "input",
        block_id: "wbk:quiz:pick-many",
        label: { type: "plain_text", text: "Select one or more answers" },
        element: {
          type: "checkboxes",
          action_id: "wbk:quiz:pick-many:select",
          options: [
            { text: { type: "plain_text", text: "A. 2" }, value: "A" },
            { text: { type: "plain_text", text: "B. 3" }, value: "B" },
            { text: { type: "plain_text", text: "C. 4" }, value: "C" },
          ],
        },
      },
      {
        type: "actions",
        elements: [{ type: "button", action_id: "wbk:quiz:submit", text: { type: "plain_text", text: "Submit answer" }, value: "x" }],
      },
    ],
    contentMode: "blocks",
    actions: [{ actionId: "wbk:quiz:submit", actionName: "Submit answer" }],
    metadata: {
      interactionResolver: "skill",
      interactionKind: "quiz-answer",
      questionType: "pick-many",
      questionId: "q_pick_many_1",
      answer: ["A", "B"],
      explanation: "2 and 3 are prime; 4 is composite.",
    },
    state: { status: "open", lastUpdatedAt: "2026-03-26T00:00:00.000Z" },
    postActionRenderMode: "preserve",
  });

  const services = makeServices(store, { storePath: file }, {
    postThreadReply: async (input, config) => ({
      ok: true,
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: "123.999",
      backend: config.backend,
      mode: "mock",
      contentMode: "text",
    }),
  });

  const updateCalls = [];
  services.backend.updateMessage = async (input, config) => {
    updateCalls.push({ input, config });
    return {
      ok: true,
      cardId: input.cardId,
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: "123.777",
      backend: config.backend,
      mode: "mock",
      contentMode: input.contentMode,
    };
  };

  const handled = await handleSlackInteraction(
    {
      interactionId: "it-pick-many-1",
      interaction: {
        data: 'wbk:quiz:submit:' + JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-pick-many-1", a: "Submit answer" }),
        value: JSON.stringify({ p: "slack-blockkit-bridge", v: 1, c: "card-pick-many-1", a: "Submit answer" }),
        actionId: "wbk:quiz:submit",
        channel: "C123",
        threadTs: "123.4",
        state: {
          values: {
            "wbk:quiz:pick-many": {
              "wbk:quiz:pick-many:select": {
                selected_options: [
                  { text: { type: "plain_text", text: "A. 2" }, value: "A" },
                  { text: { type: "plain_text", text: "B. 3" }, value: "B" },
                ],
              },
            },
          },
        },
      },
    },
    services,
  );

  assert.deepEqual(handled, { handled: true, replyMode: "none", updatedCard: true });
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].input.text, "✅ Correct");
  assert.equal(updateCalls[0].input.state.handledActionLabel, "A,B");
  assert.deepEqual(updateCalls[0].input.metadata.selected, ["A", "B"]);
  assert.equal(updateCalls[0].input.blocks[1].type, "section");
  assert.match(updateCalls[0].input.blocks[1].text.text, /👉✅ \*A\./);
  assert.match(updateCalls[0].input.blocks[1].text.text, /👉✅ \*B\./);
  assert.match(updateCalls[0].input.blocks[2].text.text, /Your answers: A\. 2, B\. 3/);
}

async function testCreateSlackCardBackend() {
  const direct = createSlackCardBackend({
    enabled: true,
    allowChannels: [],
    defaultReplyMode: "in_channel",
    storePath: undefined,
    fallbackToText: true,
    backend: "direct-slack-api",
    debug: false,
  });
  const native = createSlackCardBackend({
    enabled: true,
    allowChannels: [],
    defaultReplyMode: "in_channel",
    storePath: undefined,
    fallbackToText: true,
    backend: "native-openclaw",
    debug: false,
  });

  assert.equal(typeof direct.postBlockMessage, "function");
  assert.equal(typeof native.postThreadReply, "function");

  await assert.rejects(
    () => native.postBlockMessage({ channel: "C1", text: "x", blocks: [] }, {
      enabled: true,
      allowChannels: [],
      defaultReplyMode: "in_channel",
      storePath: undefined,
      fallbackToText: true,
      backend: "native-openclaw",
      debug: false,
    }),
    /not implemented yet/,
  );
}



const tests = [
  testBuildTemplateCardApproval,
  testBuildTemplateCardPickOneRequiresOptions,
  testNormalizePluginConfigSupportsLiveFields,
  testDirectSlackApiBackendUsesMockUnlessLive,
  testDirectSlackApiBackendRequiresTokenInLiveMode,
  testParsePluginInteractionData,
  testDecodeCardPayload,
  testJsonCardStore,
  testJsonCardStoreNormalizesLegacyMetadataState,
  testJsonCardStoreRecordAction,
  testHandleSlackInteractionPrefersBackendThreadReply,
  testHandleSlackInteractionUsesPreserveRenderMode,
  testHandleSlackInteractionUsesResolverExtension,
  testHandleSlackInteractionMarksDuplicateClicks,
  testHandleSlackInteractionGradesPickManyFromStateValues,
  testHandleSlackInteractionFallsBackToRespondReply,
  testHandleSlackInteractionSkipsReplyWhenModeNone,
  testBuildReplyTextMissingCard,
  testBuildReplyTextPrefersProvidedActionLabel,
  testBuildHandledStateBlocks,
  testBuildPreservedHandledBlocks,
  testInjectCardContextIntoBlocks,
  testMergeCardState,
  testPrepareSlackMessageInputUsesTextFallback,
  testPrepareSlackUpdateInputUsesRecordAndInjectsBlocks,
  testPrepareSlackUpdateInputRejectsEmptyUpdate,
  testPrepareSlackMessageInputRejectsEmptyBlocksWhenFallbackDisabled,
  testSendSlackBlockKitPersistsCardAndInjectedPayload,
  testSendSlackBlockKitUsesTextFallbackMode,
  testUpdateSlackBlockKitPersistsUpdatedMessageState,
  testUpdateSlackBlockKitRejectsMissingCard,
  testUpdateGatewayPassesStatePatchShapeViaRuntimePath,
  testCreateRuntimeServicesResolvesStorePath,
  testSendSlackBlockKitRejectsDisallowedChannel,
  testSendSlackBlockKitRejectsWhenDisabled,
  testCreateSlackCardBackend,
];

for (const test of tests) {
  await test();
  console.log(`ok - ${test.name}`);
}

console.log(`passed ${tests.length} tests`);
