const test = require("node:test");
const assert = require("node:assert/strict");

const { ManagedBrowserCompletionMonitor } = require("../apps/desktop/main/managed-browser-completion-monitor.js");

function runtimeHarness() {
  const agent = { agentId: "A1", sessionId: "S1", chatUrl: "https://chatgpt.com/c/test" };
  return {
    agent,
    runtime: {
      getAgent(agentId) { return agentId === agent.agentId ? { ...agent } : null; },
      sessionIdForAgent(value) { return value?.sessionId || null; }
    }
  };
}

function snapshot(overrides = {}) {
  return {
    ok: true,
    text: "",
    fingerprint: "",
    messageCount: 0,
    pathname: "/c/test",
    url: "https://chatgpt.com/c/test",
    availability: "ready",
    generating: false,
    ...overrides
  };
}

test("completion monitor waits for changed, non-generating, stable assistant response before publishing once", async () => {
  const { runtime } = runtimeHarness();
  const sequence = [
    snapshot(),
    snapshot({ text: "partial", fingerprint: "p1", messageCount: 1, availability: "generating", generating: true }),
    snapshot({ text: "final\n@@ORCH {\"v\":1}", fingerprint: "f1", messageCount: 1 }),
    snapshot({ text: "final\n@@ORCH {\"v\":1}", fingerprint: "f1", messageCount: 1 }),
    snapshot({ text: "final\n@@ORCH {\"v\":1}", fingerprint: "f1", messageCount: 1 })
  ];
  const driver = {
    async readAssistantSnapshot() { return sequence.shift() || snapshot({ text: "final", fingerprint: "f1", messageCount: 1 }); }
  };
  const completions = [];
  const errors = [];
  const protocolAdapter = {
    async publishCompletion(_runtime, agentId, value) { completions.push({ agentId, value }); return { ok: true }; },
    async publishProtocolError(_runtime, agentId, value, payload) { errors.push({ agentId, value, payload }); return { ok: true }; }
  };
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter,
    pollMs: 100,
    quietMs: 200,
    timeoutMs: 2000,
    sleep: async () => {}
  });

  const prepared = await monitor.prepare(runtime, "A1");
  assert.equal(prepared.ok, true);
  const started = monitor.start(runtime, "A1", prepared);
  assert.equal(started.ok, true);
  const result = await monitor.waitFor("A1");

  assert.equal(result.ok, true);
  assert.equal(result.sawGenerating, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].agentId, "A1");
  assert.equal(completions[0].value.fingerprint, "f1");
  assert.equal(errors.length, 0);
});

test("completion monitor times out without a changed assistant response and publishes protocol error", async () => {
  const { runtime } = runtimeHarness();
  const driver = { async readAssistantSnapshot() { return snapshot(); } };
  const completions = [];
  const errors = [];
  const protocolAdapter = {
    async publishCompletion(...args) { completions.push(args); return { ok: true }; },
    async publishProtocolError(_runtime, agentId, _value, payload) { errors.push({ agentId, payload }); return { ok: true }; }
  };
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter,
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 300,
    sleep: async () => {}
  });

  const prepared = await monitor.prepare(runtime, "A1");
  monitor.start(runtime, "A1", prepared);
  const result = await monitor.waitFor("A1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "managed_browser_completion_timeout");
  assert.equal(completions.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].payload.reason, "managed_browser_completion_timeout");
});

test("completion monitor cancellation suppresses partial assistant publication", async () => {
  const { runtime } = runtimeHarness();
  let reads = 0;
  const driver = {
    async readAssistantSnapshot() {
      reads += 1;
      if (reads === 1) return snapshot();
      return snapshot({ text: "partial", fingerprint: `p${reads}`, messageCount: 1, availability: "generating", generating: true });
    }
  };
  const completions = [];
  const errors = [];
  let monitor;
  let sleeps = 0;
  const protocolAdapter = {
    async publishCompletion(...args) { completions.push(args); return { ok: true }; },
    async publishProtocolError(...args) { errors.push(args); return { ok: true }; }
  };
  monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter,
    pollMs: 100,
    quietMs: 200,
    timeoutMs: 2000,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) monitor.cancel("A1", "generation_stopped");
    }
  });

  const prepared = await monitor.prepare(runtime, "A1");
  monitor.start(runtime, "A1", prepared);
  const result = await monitor.waitFor("A1");

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, "generation_stopped");
  assert.equal(completions.length, 0);
  assert.equal(errors.length, 0);
});

test("completion monitor fails after repeated snapshot bridge errors", async () => {
  const { runtime } = runtimeHarness();
  let calls = 0;
  const driver = {
    async readAssistantSnapshot() {
      calls += 1;
      if (calls === 1) return snapshot();
      return { ok: false, reason: "agent_preload_timeout" };
    }
  };
  const errors = [];
  const protocolAdapter = {
    async publishCompletion() { throw new Error("unexpected_completion"); },
    async publishProtocolError(_runtime, _agentId, _value, payload) { errors.push(payload); return { ok: true }; }
  };
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter,
    maxSnapshotErrors: 2,
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 1000,
    sleep: async () => {}
  });

  const prepared = await monitor.prepare(runtime, "A1");
  monitor.start(runtime, "A1", prepared);
  const result = await monitor.waitFor("A1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "agent_preload_timeout");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, "agent_preload_timeout");
});


test("completion monitor survives transient preload snapshot failures and still publishes final DONE", async () => {
  const { runtime } = runtimeHarness();
  const sequence = [
    snapshot(),
    { ok: false, reason: "agent_preload_timeout" },
    { ok: false, reason: "agent_preload_timeout" },
    { ok: false, reason: "agent_preload_send_failed" },
    snapshot({ text: "partial", fingerprint: "p1", messageCount: 1, availability: "generating", generating: true }),
    snapshot({ text: "final", fingerprint: "f1", messageCount: 1 }),
    snapshot({ text: "final", fingerprint: "f1", messageCount: 1 })
  ];
  const driver = { async readAssistantSnapshot() { return sequence.shift() || snapshot({ text: "final", fingerprint: "f1", messageCount: 1 }); } };
  const completions = [];
  const errors = [];
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter: {
      async publishCompletion(_runtime, agentId, value) { completions.push({ agentId, value }); return { ok: true }; },
      async publishProtocolError(_runtime, agentId, value, payload) { errors.push({ agentId, value, payload }); return { ok: true }; }
    },
    maxSnapshotErrors: 10,
    snapshotErrorGraceMs: 10_000,
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 3000,
    sleep: async () => {}
  });

  const prepared = await monitor.prepare(runtime, "A1");
  assert.equal(prepared.ok, true);
  monitor.start(runtime, "A1", prepared);
  const result = await monitor.waitFor("A1");
  assert.equal(result.ok, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].value.fingerprint, "f1");
  assert.equal(errors.length, 0);
});


test("completion monitor detects a new turn even when mounted message count decreases and text is identical", async () => {
  const { runtime } = runtimeHarness();
  const base = snapshot({
    text: "DONE",
    fingerprint: "response-a",
    textFingerprint: "same-text",
    latestTextFingerprint: "same-text",
    turnId: "turn-a",
    latestTurnId: "turn-a",
    conversationKey: "/c/test",
    messageCount: 5,
    observedTurnCount: 5
  });
  const next = snapshot({
    text: "DONE",
    fingerprint: "response-b",
    textFingerprint: "same-text",
    latestTextFingerprint: "same-text",
    turnId: "turn-b",
    latestTurnId: "turn-b",
    conversationKey: "/c/test",
    messageCount: 3,
    observedTurnCount: 6
  });
  const sequence = [base, next, next, next];
  const completions = [];
  const errors = [];
  const monitor = new ManagedBrowserCompletionMonitor({
    driver: { async readAssistantSnapshot() { return sequence.shift() || next; } },
    protocolAdapter: {
      async publishCompletion(_runtime, agentId, value) { completions.push({ agentId, value }); return { ok: true }; },
      async publishProtocolError(_runtime, agentId, value, payload) { errors.push({ agentId, value, payload }); return { ok: true }; }
    },
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 1000,
    sleep: async () => {}
  });

  const prepared = await monitor.prepare(runtime, "A1");
  assert.equal(prepared.baseline.turnId, "turn-a");
  monitor.start(runtime, "A1", prepared);
  const result = await monitor.waitFor("A1");

  assert.equal(result.ok, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].value.turnId, "turn-b");
  assert.equal(completions[0].value.messageCount, 3);
  assert.equal(errors.length, 0);
});

test("completion monitor does not publish streaming changes from the baseline turn as a new response", async () => {
  const { runtime } = runtimeHarness();
  const base = snapshot({
    text: "PL",
    fingerprint: "response-a-1",
    textFingerprint: "text-a-1",
    latestTextFingerprint: "text-a-1",
    turnId: "turn-a",
    latestTurnId: "turn-a",
    conversationKey: "/c/test",
    messageCount: 4
  });
  let index = 0;
  const driver = {
    async readAssistantSnapshot() {
      index += 1;
      if (index === 1) return base;
      return snapshot({
        text: "PLAN complete",
        fingerprint: "response-a-2",
        textFingerprint: "text-a-2",
        latestTextFingerprint: "text-a-2",
        turnId: "turn-a",
        latestTurnId: "turn-a",
        conversationKey: "/c/test",
        messageCount: 2
      });
    }
  };
  const completions = [];
  const errors = [];
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter: {
      async publishCompletion(...args) { completions.push(args); return { ok: true }; },
      async publishProtocolError(_runtime, _agentId, _value, payload) { errors.push(payload); return { ok: true }; }
    },
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 300,
    sleep: async () => {}
  });

  const prepared = await monitor.prepare(runtime, "A1");
  monitor.start(runtime, "A1", prepared);
  const result = await monitor.waitFor("A1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "managed_browser_completion_timeout");
  assert.equal(completions.length, 0);
  assert.equal(errors.length, 1);
});

test("completion monitor fails closed after repeated ambiguous turn snapshots", async () => {
  const { runtime } = runtimeHarness();
  let calls = 0;
  const driver = {
    async readAssistantSnapshot() {
      calls += 1;
      if (calls === 1) return snapshot({
        turnId: "turn-a",
        latestTurnId: "turn-a",
        textFingerprint: "text-a",
        latestTextFingerprint: "text-a",
        conversationKey: "/c/test"
      });
      return { ok: false, reason: "assistant_turn_identity_ambiguous" };
    }
  };
  const completions = [];
  const errors = [];
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter: {
      async publishCompletion(...args) { completions.push(args); return { ok: true }; },
      async publishProtocolError(_runtime, _agentId, _value, payload) { errors.push(payload); return { ok: true }; }
    },
    maxSnapshotErrors: 2,
    snapshotErrorGraceMs: 1000,
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 1000,
    sleep: async () => {}
  });

  const prepared = await monitor.prepare(runtime, "A1");
  monitor.start(runtime, "A1", prepared);
  const result = await monitor.waitFor("A1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "assistant_turn_identity_ambiguous");
  assert.equal(completions.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, "assistant_turn_identity_ambiguous");
});
