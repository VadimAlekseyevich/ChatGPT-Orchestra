const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/message-types.js");
const { TabRegistry } = require("../background/tab-registry.js");
const { ServiceWorkerOrchestrator } = require("../background/orchestrator.js");

function fakeStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

function createFakeChrome() {
  const tabs = new Map([[1, { id: 1, url: "https://chatgpt.com/c/lead", active: true }]]);
  const sent = [];
  let nextId = 10;

  return {
    sent,
    tabStore: tabs,
    tabs: {
      async query() { return [tabs.get(1)]; },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("No tab");
        return { ...tab };
      },
      async create(options) {
        const tab = { id: nextId++, url: options.url, active: Boolean(options.active) };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(tabId, changes) {
        const tab = tabs.get(tabId);
        Object.assign(tab, changes);
        return { ...tab };
      },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
        if (!tabs.has(tabId)) throw new Error("No receiver");
        if (message.type === globalThis.ChatGPTOrchestra.MESSAGE_TYPES.PING) {
          return { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.PONG, payload: { availability: "ready", generating: false } };
        }
        return { ok: true };
      }
    }
  };
}

function makeOrchestrator() {
  let id = 0;
  const chromeApi = createFakeChrome();
  const registry = new TabRegistry({
    storageArea: fakeStorage(),
    idFactory: () => `agent-${++id}`
  });
  const orchestrator = new ServiceWorkerOrchestrator({ chromeApi, registry, logger: { warn() {} } });
  return { orchestrator, registry, chromeApi };
}

test("normal ChatGPT tab is ignored until explicitly registered", async () => {
  const { orchestrator, registry } = makeOrchestrator();
  await orchestrator.init();
  const response = await orchestrator.handleContentMessage(
    { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.CONTENT_READY, payload: { availability: "ready" } },
    { tab: { id: 77, url: "https://chatgpt.com/c/random" } }
  );
  assert.equal(response.ignored, true);
  assert.equal(registry.getAgentByTabId(77), null);
});

test("active ChatGPT tab becomes Lead only through explicit registration", async () => {
  const { orchestrator, registry } = makeOrchestrator();
  await orchestrator.init();
  const response = await orchestrator.registerActiveLead();
  assert.equal(response.ok, true);
  assert.equal(response.agent.role, "lead");
  assert.equal(registry.getAgentByTabId(1).status, "IDLE");
});

test("workers are bound to tab ids before navigation to ChatGPT", async () => {
  const { orchestrator, registry, chromeApi } = makeOrchestrator();
  await orchestrator.init();
  const response = await orchestrator.createWorkers(3);
  assert.equal(response.ok, true);
  assert.equal(response.created.length, 3);
  const workers = registry.listAgents().filter((agent) => agent.role === "worker");
  assert.equal(workers.length, 3);
  for (const worker of workers) {
    assert.equal(chromeApi.tabStore.get(worker.tabId).url, "https://chatgpt.com/");
    assert.equal(worker.status, "CONNECTING");
  }
});

test("heartbeat after reload keeps same agent id", async () => {
  const { orchestrator, registry } = makeOrchestrator();
  await orchestrator.init();
  const created = await orchestrator.createWorkers(1);
  const agentId = created.created[0];
  const tabId = registry.getAgent(agentId).tabId;

  await orchestrator.handleContentMessage(
    { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.CONTENT_READY, payload: { availability: "ready", generating: false } },
    { tab: { id: tabId, url: "https://chatgpt.com/" } }
  );
  assert.equal(registry.getAgent(agentId).status, "IDLE");

  await orchestrator.handleContentMessage(
    { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.CONTENT_HEARTBEAT, payload: { availability: "generating", generating: true } },
    { tab: { id: tabId, url: "https://chatgpt.com/c/new" } }
  );
  assert.equal(registry.getAgent(agentId).agentId, agentId);
  assert.equal(registry.getAgent(agentId).status, "BUSY");
});

test("prompt routing targets only the selected agent tab", async () => {
  const { orchestrator, registry, chromeApi } = makeOrchestrator();
  await orchestrator.init();
  const created = await orchestrator.createWorkers(2);
  const targetId = created.created[1];
  const targetTabId = registry.getAgent(targetId).tabId;

  const result = await orchestrator.sendPromptToAgent(targetId, "task B");
  assert.equal(result.ok, true);
  const promptMessages = chromeApi.sent.filter((entry) => entry.message.type === globalThis.ChatGPTOrchestra.MESSAGE_TYPES.SEND_PROMPT);
  assert.equal(promptMessages.length, 1);
  assert.equal(promptMessages[0].tabId, targetTabId);
  assert.equal(promptMessages[0].message.payload.prompt, "task B");
});

test("closing a registered tab marks its agent offline", async () => {
  const { orchestrator, registry } = makeOrchestrator();
  await orchestrator.init();
  const created = await orchestrator.createWorkers(1);
  const agentId = created.created[0];
  const tabId = registry.getAgent(agentId).tabId;
  await orchestrator.handleTabRemoved(tabId);
  assert.equal(registry.getAgent(agentId).status, "OFFLINE");
  assert.equal(registry.getAgent(agentId).tabId, null);
});

test("orchestrator control commands are rejected from tab senders", async () => {
  const { orchestrator } = makeOrchestrator();
  await orchestrator.init();
  const response = await orchestrator.handleRuntimeMessage(
    { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS, payload: { count: 4 } },
    { tab: { id: 99, url: "https://chatgpt.com/c/random" } }
  );
  assert.equal(response.ok, false);
  assert.equal(response.reason, "orchestrator_command_forbidden_from_tab");
});

test("explicit createWorkers reuses an offline worker identity", async () => {
  const { orchestrator, registry } = makeOrchestrator();
  await orchestrator.init();
  const first = await orchestrator.createWorkers(1);
  const agentId = first.created[0];
  const oldTabId = registry.getAgent(agentId).tabId;
  await orchestrator.handleTabRemoved(oldTabId);

  const second = await orchestrator.createWorkers(1);
  assert.equal(second.ok, true);
  assert.equal(second.created[0], agentId);
  assert.notEqual(registry.getAgent(agentId).tabId, oldTabId);
  assert.equal(registry.getAgent(agentId).status, "CONNECTING");
});
