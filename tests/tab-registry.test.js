const test = require("node:test");
const assert = require("node:assert/strict");

const { TabRegistry, STORAGE_KEY, deriveAgentStatus, isChatGPTUrl } = require("../background/tab-registry.js");

function fakeStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

test("registry persists agent identity and restores it", async () => {
  let now = 100;
  let id = 0;
  const storage = fakeStorage();
  const registry = new TabRegistry({
    storageArea: storage,
    clock: () => now,
    idFactory: () => `agent-${++id}`
  });

  await registry.load();
  const worker = await registry.createAgent({ role: "worker", tabId: 42, chatUrl: "https://chatgpt.com/" });
  assert.equal(worker.agentId, "agent-1");
  assert.equal(storage.data[STORAGE_KEY].agents["agent-1"].tabId, 42);

  const restored = new TabRegistry({ storageArea: storage, clock: () => now, idFactory: () => "unused" });
  await restored.load();
  assert.equal(restored.getAgent("agent-1").tabId, 42);
  assert.equal(restored.getAgentByTabId(42).agentId, "agent-1");
});

test("heartbeat maps ChatGPT state to agent health", async () => {
  let now = 1000;
  const registry = new TabRegistry({ storageArea: fakeStorage(), clock: () => now, idFactory: () => "agent-1" });
  await registry.load();
  await registry.createAgent({ role: "worker", tabId: 7, chatUrl: "https://chatgpt.com/" });

  now = 1200;
  await registry.updateHeartbeat(7, { availability: "ready", generating: false, pathname: "/c/a" });
  assert.equal(registry.getAgent("agent-1").status, "IDLE");

  now = 1400;
  await registry.updateHeartbeat(7, { availability: "generating", generating: true });
  assert.equal(registry.getAgent("agent-1").status, "BUSY");

  now = 1600;
  await registry.updateHeartbeat(7, { availability: "error", generating: false });
  assert.equal(registry.getAgent("agent-1").status, "ERROR");
});

test("closed tab becomes OFFLINE without deleting agent history", async () => {
  const registry = new TabRegistry({ storageArea: fakeStorage(), idFactory: () => "agent-1" });
  await registry.load();
  await registry.createAgent({ role: "worker", tabId: 9, chatUrl: "https://chatgpt.com/c/test" });
  await registry.markOfflineByTabId(9, "tab_closed");

  const agent = registry.getAgent("agent-1");
  assert.equal(agent.status, "OFFLINE");
  assert.equal(agent.tabId, null);
  assert.equal(agent.lastError, "tab_closed");
});

test("URL and status helpers are strict", () => {
  assert.equal(isChatGPTUrl("https://chatgpt.com/c/1"), true);
  assert.equal(isChatGPTUrl("https://chat.openai.com/c/1"), true);
  assert.equal(isChatGPTUrl("https://example.com/"), false);
  assert.equal(deriveAgentStatus({ availability: "ready" }), "IDLE");
  assert.equal(deriveAgentStatus({ generating: true }), "BUSY");
});
