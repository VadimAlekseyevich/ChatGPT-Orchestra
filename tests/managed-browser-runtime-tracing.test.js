const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../prompts/planning-prompts.js");
require("../background/dag-validator.js");
require("../protocol/orchestra-protocol.js");

const MESSAGE_TYPES = require("../content/message-types.js");
const { MemoryStateStore } = require("../platform/fake-runtime.js");
const { EventStore } = require("../background/event-store.js");
const { EventBus } = require("../background/event-bus.js");
const { ProjectStore } = require("../background/project-store.js");
const { PlanningEngine } = require("../background/planning-engine.js");
const { ManagedBrowserAgentRuntime } = require("../apps/desktop/main/managed-browser-agent-runtime.js");
const { CompletionAwareManagedBrowserRuntime } = require("../apps/desktop/main/completion-aware-managed-browser-runtime.js");
const { ManagedBrowserCompletionMonitor } = require("../apps/desktop/main/managed-browser-completion-monitor.js");
const { ManagedBrowserProtocolAdapter } = require("../apps/desktop/main/managed-browser-protocol-adapter.js");
const { StructuredLogger } = require("../apps/desktop/main/structured-logger.js");

function silentConsole() {
  return { log() {}, debug() {}, info() {}, warn() {}, error() {} };
}

function collectingLogger() {
  const records = [];
  const logger = { records };
  for (const level of ["debug", "info", "warn", "error", "log"]) {
    logger[level] = (event, details = {}) => records.push({ level, event, details });
  }
  return logger;
}

function fakeStorage() {
  const data = {};
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return {
    data,
    async get(key) {
      if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, clone(data[item])]));
      if (key && typeof key === "object") {
        return Object.fromEntries(Object.keys(key).map((item) => [item, clone(data[item] ?? key[item])]));
      }
      return { [key]: clone(data[key]) };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values || {})) data[key] = clone(value);
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    }
  };
}

function discoveryArtifact(overrides = {}) {
  return {
    repositoryAccess: { status: "ok", inspectedPaths: ["README.md", "package.json"], gaps: [] },
    stack: ["JavaScript"],
    entrypoints: ["apps/desktop/main/desktop-host.js"],
    commands: { build: [], test: ["npm test"], lint: [], typecheck: [] },
    modules: ["apps/desktop", "background"],
    persistence: [],
    ci: [],
    instructions: { agentsMd: "absent", paths: [] },
    sensitiveAreas: [],
    constraints: [],
    ...overrides
  };
}

function trace(id = "trace-test") {
  return {
    traceId: id,
    projectId: "P1",
    taskId: "planning:discovery",
    runId: "R1",
    agentId: "A1",
    stage: "DISCOVERY",
    sessionId: "S1",
    dispatchKind: "normal",
    startedAt: 1000
  };
}

function runtimeDriver({ sendResult = { ok: true, accepted: true, confirmed: true, method: "test" } } = {}) {
  const session = { id: "S1", url: "https://chatgpt.com/", active: true, title: "ChatGPT" };
  return {
    async start() { return { ok: true }; },
    async close() {},
    async getActiveSession() { return session; },
    async getSession(id) { return String(id) === "S1" ? session : null; },
    async createSession() { return session; },
    async navigateSession() { return session; },
    async removeSession() { return true; },
    async activateSession() { return session; },
    async pingSession() { return { ok: true, availability: "ready", generating: false, composerOccupied: false, url: session.url }; },
    async sendPrompt() { return sendResult; },
    async stopGeneration() { return { ok: true, availability: "ready", generating: false, url: session.url }; }
  };
}

async function runtimeWithMonitor(monitor, logger, driver = runtimeDriver()) {
  const runtime = new CompletionAwareManagedBrowserRuntime({
    driver,
    completionMonitor: monitor,
    profileDirectory: process.cwd(),
    logger
  });
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/", active: true });
  const agent = await runtime.createAgentForSession({ role: "lead", session, status: "IDLE" });
  return { runtime, agent };
}

function terminal(records, traceId) {
  const terminalEvents = new Set(["runtime_trace_completed", "runtime_trace_failed", "runtime_trace_cancelled", "runtime_trace_timed_out"]);
  return records.filter((record) => terminalEvents.has(record.event) && record.details?.traceId === traceId);
}

test("runtime trace localizes baseline, prompt-send and monitor-start failures", async () => {
  const scenarios = [
    {
      name: "baseline",
      monitor: {
        async prepare() { return { ok: false, reason: "agent_preload_timeout" }; },
        start() { throw new Error("must_not_start"); },
        cancel() {}, cancelSession() {}, close() {}
      },
      driver: runtimeDriver(),
      expectedReason: "agent_preload_timeout",
      expectedStage: "planning_dispatch"
    },
    {
      name: "prompt",
      monitor: {
        async prepare(_runtime, _agentId, traceValue) { return { ok: true, agentId: "desktop-agent-1", sessionId: "S1", baseline: {}, trace: traceValue }; },
        start() { throw new Error("must_not_start"); },
        cancel() {}, cancelSession() {}, close() {}
      },
      driver: runtimeDriver({ sendResult: { ok: false, reason: "send_not_confirmed" } }),
      expectedReason: "send_not_confirmed",
      expectedStage: "completion_prepare"
    },
    {
      name: "start",
      monitor: {
        async prepare(_runtime, _agentId, traceValue) { return { ok: true, agentId: "desktop-agent-1", sessionId: "S1", baseline: {}, trace: traceValue }; },
        start() { return { ok: false, reason: "monitor_start_refused" }; },
        cancel() {}, cancelSession() {}, close() {}
      },
      driver: runtimeDriver(),
      expectedReason: "monitor_start_refused",
      expectedStage: "prompt_send"
    }
  ];

  for (const scenario of scenarios) {
    const logger = collectingLogger();
    const { runtime, agent } = await runtimeWithMonitor(scenario.monitor, logger, scenario.driver);
    const traceValue = { ...trace(`trace-${scenario.name}`), agentId: agent.agentId };
    const result = await runtime.sendPrompt(agent.agentId, "TRACE_PROMPT_SENTINEL", { trace: traceValue });
    assert.equal(result.ok, false, scenario.name);
    const failed = terminal(logger.records, traceValue.traceId);
    assert.equal(failed.length, 1, scenario.name);
    assert.equal(failed[0].details.reason, scenario.expectedReason, scenario.name);
    assert.equal(failed[0].details.lastSuccessfulStage, scenario.expectedStage, scenario.name);
    assert.equal(JSON.stringify(logger.records).includes("TRACE_PROMPT_SENTINEL"), false);
    await runtime.close();
  }
});


test("structured JSONL trace omits prompt, assistant and parser sentinel content", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-runtime-trace-"));
  const filename = path.join(directory, "orchestra.jsonl");
  const logger = new StructuredLogger({
    filename,
    consoleTarget: silentConsole(),
    instanceId: "trace-privacy-test",
    component: "desktop"
  });
  const promptSentinel = "TRACE_JSONL_PROMPT_SENTINEL";
  const assistantSentinel = "TRACE_JSONL_ASSISTANT_SENTINEL";
  const parserSentinel = "TRACE_JSONL_PARSER_SENTINEL";

  const runtime = new ManagedBrowserAgentRuntime({
    driver: runtimeDriver(),
    profileDirectory: process.cwd(),
    logger
  });
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/", active: true });
  const agent = await runtime.createAgentForSession({ role: "lead", session, status: "IDLE" });
  await runtime.sendPrompt(agent.agentId, promptSentinel, {
    trace: { ...trace("trace-jsonl-prompt"), agentId: agent.agentId, sessionId: session.id }
  });
  await runtime.close();

  const adapter = new ManagedBrowserProtocolAdapter({ logger });
  const protocolAgent = {
    agentId: "A1",
    sessionId: "S1",
    chatUrl: "https://chatgpt.com/c/privacy",
    protocolContext: { projectId: "P1", taskId: "T1", runId: "R1" }
  };
  const protocolRuntime = {
    getAgent(id) { return id === "A1" ? { ...protocolAgent } : null; },
    sessionIdForAgent(value) { return value?.sessionId || null; },
    async publishRuntimeMessage() { return { ok: true }; }
  };

  await adapter.publishCompletion(protocolRuntime, "A1", {
    text: assistantSentinel,
    fingerprint: "fp-assistant-privacy",
    messageCount: 1,
    pathname: "/c/privacy",
    url: "https://chatgpt.com/c/privacy?token=must-not-log#fragment",
    availability: "ready",
    generating: false
  }, trace("trace-jsonl-assistant"));

  await adapter.publishCompletion(protocolRuntime, "A1", {
    text: `@@ORCH {"broken":"${parserSentinel}"`,
    fingerprint: "fp-parser-privacy",
    messageCount: 2,
    pathname: "/c/privacy",
    url: "https://chatgpt.com/c/privacy",
    availability: "ready",
    generating: false
  }, trace("trace-jsonl-parser"));

  const serialized = fs.readFileSync(filename, "utf8");
  assert.equal(serialized.includes(promptSentinel), false);
  assert.equal(serialized.includes(assistantSentinel), false);
  assert.equal(serialized.includes(parserSentinel), false);
  assert.equal(serialized.includes("must-not-log"), false);
  assert.match(serialized, /trace-jsonl-prompt/);
  assert.match(serialized, /trace-jsonl-assistant/);
  assert.match(serialized, /trace-jsonl-parser/);
});

test("completion monitor emits bounded transition logs and terminal timeout/failure records", async () => {
  const agent = { agentId: "A1", sessionId: "S1" };
  const runtime = {
    getAgent(id) { return id === "A1" ? { ...agent } : null; },
    sessionIdForAgent(value) { return value?.sessionId || null; }
  };

  {
    const logger = collectingLogger();
    let reads = 0;
    const monitor = new ManagedBrowserCompletionMonitor({
      driver: {
        async readAssistantSnapshot() {
          reads += 1;
          return { ok: false, reason: "agent_preload_timeout" };
        }
      },
      protocolAdapter: {
        async publishCompletion() { throw new Error("unexpected_completion"); },
        async publishProtocolError() { return { ok: false, reason: "agent_preload_timeout" }; }
      },
      maxSnapshotErrors: 2,
      pollMs: 100,
      quietMs: 100,
      timeoutMs: 1000,
      sleep: async () => {},
      clock: (() => { let now = 1000; return () => now += 100; })(),
      logger
    });
    const traceValue = trace("trace-snapshot-errors");
    monitor.start(runtime, "A1", {
      ok: true,
      agentId: "A1",
      sessionId: "S1",
      baseline: { ok: true, text: "", fingerprint: "", messageCount: 0, availability: "ready", generating: false },
      trace: traceValue
    });
    const result = await monitor.waitFor("A1");
    assert.equal(result.reason, "agent_preload_timeout");
    const failed = terminal(logger.records, traceValue.traceId);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].event, "runtime_trace_failed");
    assert.equal(failed[0].details.snapshotErrors, 2);
  }

  {
    const logger = collectingLogger();
    const monitor = new ManagedBrowserCompletionMonitor({
      driver: {
        async readAssistantSnapshot() {
          return { ok: true, text: "", fingerprint: "", messageCount: 0, pathname: "/c/x", availability: "ready", generating: false };
        }
      },
      protocolAdapter: {
        async publishCompletion() { throw new Error("unexpected_completion"); },
        async publishProtocolError() { return { ok: false, reason: "managed_browser_completion_timeout" }; }
      },
      pollMs: 100,
      quietMs: 100,
      timeoutMs: 300,
      sleep: async () => {},
      clock: (() => { let now = 2000; return () => now += 100; })(),
      logger
    });
    const traceValue = trace("trace-timeout");
    monitor.start(runtime, "A1", {
      ok: true,
      agentId: "A1",
      sessionId: "S1",
      baseline: { ok: true, text: "", fingerprint: "", messageCount: 0, availability: "ready", generating: false },
      trace: traceValue
    });
    const result = await monitor.waitFor("A1");
    assert.equal(result.reason, "managed_browser_completion_timeout");
    const timedOut = terminal(logger.records, traceValue.traceId);
    assert.equal(timedOut.length, 1);
    assert.equal(timedOut[0].event, "runtime_trace_timed_out");
    assert.equal(logger.records.length, 1, "unchanged polling must not emit one log record per poll");
  }
});

test("protocol and EventBus rejection paths keep trace correlation without raw parser content", async () => {
  const logger = collectingLogger();
  const adapter = new ManagedBrowserProtocolAdapter({ logger });
  const messages = [];
  const agent = {
    agentId: "A1",
    sessionId: "S1",
    chatUrl: "https://chatgpt.com/c/x",
    protocolContext: { projectId: "P1", taskId: "planning:discovery", runId: "R1" }
  };
  const runtime = {
    getAgent(id) { return id === "A1" ? { ...agent } : null; },
    sessionIdForAgent(value) { return value?.sessionId || null; },
    async publishRuntimeMessage(message) { messages.push(message); return { ok: true }; }
  };
  const missingTrace = trace("trace-protocol-missing");
  const missing = await adapter.publishCompletion(runtime, "A1", {
    text: "Finished without an Orchestra envelope.",
    fingerprint: "fp-missing",
    messageCount: 1,
    pathname: "/c/x",
    url: "https://chatgpt.com/c/x",
    availability: "ready",
    generating: false
  }, missingTrace);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "protocol_event_missing");
  assert.equal(logger.records.some((record) => (
    record.event === "managed_browser_protocol_parse_failed"
    && record.details.traceId === missingTrace.traceId
    && record.details.reason === "protocol_event_missing"
  )), true);

  const parserSentinel = "TRACE_PARSER_SENTINEL";
  const parseTrace = trace("trace-parser-reject");
  const parsed = await adapter.publishCompletion(runtime, "A1", {
    text: `@@ORCH {"broken":"${parserSentinel}"`,
    fingerprint: "fp-parser",
    messageCount: 1,
    pathname: "/c/x",
    url: "https://chatgpt.com/c/x",
    availability: "ready",
    generating: false
  }, parseTrace);
  assert.equal(parsed.ok, false);
  assert.equal(logger.records.some((record) => record.event === "managed_browser_protocol_parse_failed" && record.details.traceId === parseTrace.traceId), true);
  assert.equal(JSON.stringify(logger.records).includes(parserSentinel), false);
  assert.equal(JSON.stringify(messages).includes(parserSentinel), false);

  const stateStore = new MemoryStateStore();
  const eventStore = new EventStore({ stateStore });
  const busLogger = collectingLogger();
  const registry = {
    getAgent(id) {
      return id === "A1"
        ? { agentId: "A1", protocolContext: { projectId: "P1", taskId: "planning:other", runId: "R1" } }
        : null;
    }
  };
  const bus = new EventBus({ registry, store: eventStore, logger: busLogger });
  await bus.load();
  const event = {
    v: 1,
    event: "DONE",
    projectId: "P1",
    taskId: "planning:discovery",
    runId: "R1",
    agentId: "A1",
    eventId: "E-context-reject",
    sequence: 1,
    payload: { stage: "DISCOVERY" }
  };
  const rejectedTrace = trace("trace-context-reject");
  const rejected = await bus.handleEvent(event, { kind: "agent-session", sessionId: "S1", agentId: "A1" }, { trace: rejectedTrace });
  assert.equal(rejected.reason, "taskId_mismatch");
  const rejectionLog = busLogger.records.find((record) => record.event === "orchestra_event_rejected");
  assert.equal(rejectionLog.details.traceId, rejectedTrace.traceId);

  const failingStore = new EventStore({ stateStore: new MemoryStateStore() });
  const failingRegistry = {
    getAgent(id) {
      return id === "A1"
        ? { agentId: "A1", protocolContext: { projectId: "P1", taskId: "planning:discovery", runId: "R1" } }
        : null;
    }
  };
  const failureLogger = collectingLogger();
  const failingBus = new EventBus({ registry: failingRegistry, store: failingStore, logger: failureLogger });
  await failingBus.load();
  failingBus.subscribe("completion", async () => { throw new Error("listener exploded"); });
  const failedTrace = trace("trace-listener-fail");
  const failed = await failingBus.handleEvent(
    { ...event, eventId: "E-listener-fail" },
    { kind: "agent-session", sessionId: "S1", agentId: "A1" },
    { trace: failedTrace }
  );
  assert.equal(failed.reason, "event_listener_failed");
  assert.equal(failureLogger.records.some((record) => record.event === "orchestra_event_apply_failed" && record.details.traceId === failedTrace.traceId), true);
});


test("protocol and EventBus failures end with deterministic terminal trace reasons", async () => {
  async function runCase({ name, text, expectedReason, agentContext, eventBusSetup = null }) {
    const logger = collectingLogger();
    const agent = {
      agentId: "A1",
      sessionId: "S1",
      chatUrl: "https://chatgpt.com/c/failure",
      protocolContext: agentContext
    };
    let bus = null;
    if (eventBusSetup) {
      const registry = { getAgent(id) { return id === "A1" ? agent : null; } };
      bus = new EventBus({ registry, store: new EventStore({ stateStore: new MemoryStateStore() }), logger });
      await bus.load();
      eventBusSetup(bus);
    }
    const runtime = {
      getAgent(id) { return id === "A1" ? agent : null; },
      sessionIdForAgent(value) { return value?.sessionId || null; },
      async publishRuntimeMessage(message, sender) {
        if (message.type === MESSAGE_TYPES.ORCHESTRA_EVENT && bus) {
          const payload = message.payload || {};
          return bus.handleEvent(payload.event, sender, {
            responseFingerprint: payload.responseFingerprint || "",
            pathname: payload.pathname || "",
            messageCount: payload.messageCount || 0,
            planningArtifact: payload.planningArtifact || null,
            workerArtifact: payload.workerArtifact || null,
            trace: payload.trace || null
          });
        }
        return { ok: true };
      }
    };
    const adapter = new ManagedBrowserProtocolAdapter({ logger });
    const monitor = new ManagedBrowserCompletionMonitor({
      driver: {
        async readAssistantSnapshot() {
          return {
            ok: true,
            text,
            fingerprint: `fp-${name}`,
            messageCount: 1,
            pathname: "/c/failure",
            url: "https://chatgpt.com/c/failure",
            availability: "ready",
            generating: false
          };
        }
      },
      protocolAdapter: adapter,
      pollMs: 100,
      quietMs: 100,
      timeoutMs: 1000,
      sleep: async () => {},
      logger
    });
    const traceValue = {
      ...trace(`trace-${name}`),
      taskId: agentContext?.taskId || "T1",
      runId: agentContext?.runId || "R1"
    };
    monitor.start(runtime, "A1", {
      ok: true,
      agentId: "A1",
      sessionId: "S1",
      baseline: { ok: true, text: "", fingerprint: "", messageCount: 0, availability: "ready", generating: false },
      trace: traceValue
    });
    const result = await monitor.waitFor("A1");
    assert.equal(result.reason, expectedReason, name);
    const outcomes = terminal(logger.records, traceValue.traceId);
    assert.equal(outcomes.length, 1, name);
    assert.equal(outcomes[0].event, "runtime_trace_failed", name);
    assert.equal(outcomes[0].details.reason, expectedReason, name);
  }

  await runCase({
    name: "protocol-missing-terminal",
    text: "response without protocol envelope",
    expectedReason: "protocol_event_missing",
    agentContext: { projectId: "P1", taskId: "T1", runId: "R1" }
  });
  await runCase({
    name: "parser-reject-terminal",
    text: '@@ORCH {"broken":',
    expectedReason: "invalid_json",
    agentContext: { projectId: "P1", taskId: "T1", runId: "R1" }
  });
  await runCase({
    name: "context-reject-terminal",
    text: `@@ORCH ${JSON.stringify({
      v: 1, event: "DONE", projectId: "P1", taskId: "T-other", runId: "R1",
      agentId: "A1", eventId: "E-context-terminal", sequence: 1, payload: {}
    })}`,
    expectedReason: "taskId_mismatch",
    agentContext: { projectId: "P1", taskId: "T-bound", runId: "R1" },
    eventBusSetup() {}
  });
  await runCase({
    name: "listener-fail-terminal",
    text: `@@ORCH ${JSON.stringify({
      v: 1, event: "DONE", projectId: "P1", taskId: "T1", runId: "R1",
      agentId: "A1", eventId: "E-listener-terminal", sequence: 1, payload: {}
    })}`,
    expectedReason: "event_listener_failed",
    agentContext: { projectId: "P1", taskId: "T1", runId: "R1" },
    eventBusSetup(bus) {
      bus.subscribe("completion", async () => { throw new Error("synthetic listener failure"); });
    }
  });
});

test("same-run planning delivery retries use a fresh traceId without changing runId", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P-retry-trace" });
  await store.load();
  await store.createProject({ goal: "trace same-run retries", repositoryUrl: "https://github.com/acme/widget" });
  await store.beginStage("P-retry-trace", { stage: "DISCOVERY", runId: "R-existing" });
  await store.fail("P-retry-trace", "lead_prompt_failed", { retryMode: "same_run" }, "PLANNING");

  const lead = { agentId: "A1", role: "lead", status: "IDLE", sessionId: "S1" };
  const traces = [];
  const registry = {
    listAgents() { return [{ ...lead }]; },
    isAgentConnected() { return true; },
    sessionIdForAgent() { return "S1"; },
    async pingAgent() {
      return {
        ok: true,
        availability: "ready",
        generating: false,
        composerOccupied: false,
        agent: { ...lead, status: "IDLE", chatState: { availability: "ready", generating: false, composerOccupied: false } }
      };
    },
    async setProtocolContext(_agentId, context) { lead.protocolContext = { ...context }; return { ...lead }; },
    async clearProtocolContext() { lead.protocolContext = null; }
  };
  const traceIds = ["retry-a", "retry-b"];
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: { subscribe() { return () => {}; }, allEvents() { return []; }, recent() { return { events: [] }; } },
    traceIdFactory: () => traceIds.shift(),
    sendPrompt: async (_agentId, _prompt, options) => {
      traces.push(options.trace);
      return { ok: true, accepted: true };
    },
    logger: collectingLogger()
  });

  const first = await engine.resumeCurrentStage({ reason: "first_same_run_retry" });
  assert.equal(first.ok, true);
  assert.equal(first.runId, "R-existing");
  await store.fail("P-retry-trace", "lead_prompt_failed", { retryMode: "same_run" }, "PLANNING");
  const second = await engine.resumeCurrentStage({ reason: "second_same_run_retry" });
  assert.equal(second.ok, true);
  assert.equal(second.runId, "R-existing");

  assert.equal(traces.length, 2);
  assert.equal(traces[0].runId, "R-existing");
  assert.equal(traces[1].runId, "R-existing");
  assert.equal(traces[0].dispatchKind, "same_run_retry");
  assert.equal(traces[1].dispatchKind, "same_run_retry");
  assert.notEqual(traces[0].traceId, traces[1].traceId);
});

test("stale planning completion is explicitly ignored without advancing", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P1" });
  await store.load();
  await store.createProject({ goal: "trace stale completion", repositoryUrl: "https://github.com/acme/widget" });
  await store.beginStage("P1", { stage: "DISCOVERY", runId: "R-current" });
  const logger = collectingLogger();
  const registry = {
    listAgents() { return [{ agentId: "A1", role: "lead", status: "IDLE" }]; },
    isAgentConnected() { return true; }
  };
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: { subscribe() { return () => {}; }, allEvents() { return []; }, recent() { return { events: [] }; } },
    sendPrompt: async () => ({ ok: true }),
    logger
  });
  const staleTrace = { ...trace("trace-stale"), runId: "R-stale" };
  const result = await engine.handleCompletion({
    event: {
      v: 1,
      event: "DONE",
      projectId: "P1",
      taskId: "planning:discovery",
      runId: "R-stale",
      agentId: "A1",
      eventId: "E-stale",
      sequence: 1,
      payload: { stage: "DISCOVERY" }
    },
    source: { trace: staleTrace, planningArtifact: discoveryArtifact() }
  });
  assert.equal(result.ignored, true);
  assert.equal(result.planningConsumed, false);
  assert.equal(store.getActiveProject().stage, "DISCOVERY");
  const ignored = logger.records.find((record) => record.event === "planning_completion_ignored");
  assert.equal(ignored.details.traceId, staleTrace.traceId);
  assert.equal(ignored.details.reason, "run_id_mismatch");
});


test("accepted stale planning completion terminates as not consumed", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P-stale-terminal" });
  await store.load();
  await store.createProject({ goal: "trace stale completion terminal", repositoryUrl: "https://github.com/acme/widget" });
  await store.beginStage("P-stale-terminal", { stage: "DISCOVERY", runId: "R-current" });

  const logger = collectingLogger();
  const agent = { agentId: "A1", role: "lead", status: "IDLE", sessionId: "S1", protocolContext: null };
  const registry = {
    getAgent(id) { return id === "A1" ? agent : null; },
    listAgents() { return [agent]; },
    isAgentConnected() { return true; },
    sessionIdForAgent(value) { return value?.sessionId || null; },
    async setProtocolContext(_agentId, context) { agent.protocolContext = { ...context }; return agent; },
    async clearProtocolContext() { agent.protocolContext = null; }
  };
  const bus = new EventBus({ registry, store: new EventStore({ stateStore: new MemoryStateStore() }), logger });
  await bus.load();
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: bus,
    sendPrompt: async () => ({ ok: true }),
    logger
  });
  await engine.init();

  const staleEvent = {
    v: 1,
    event: "DONE",
    projectId: "P-stale-terminal",
    taskId: "planning:discovery",
    runId: "R-stale",
    agentId: "A1",
    eventId: "E-stale-terminal",
    sequence: 1,
    payload: { stage: "DISCOVERY" }
  };
  const response = [
    "@@ORCH_ARTIFACT_BEGIN",
    JSON.stringify(discoveryArtifact()),
    "@@ORCH_ARTIFACT_END",
    `@@ORCH ${JSON.stringify(staleEvent)}`
  ].join("\n");
  const adapter = new ManagedBrowserProtocolAdapter({ logger });
  const runtime = {
    getAgent(id) { return registry.getAgent(id); },
    sessionIdForAgent(value) { return value?.sessionId || null; },
    async publishRuntimeMessage(message, sender) {
      if (message.type === MESSAGE_TYPES.ORCHESTRA_EVENT) {
        const payload = message.payload || {};
        return bus.handleEvent(payload.event, sender, {
          responseFingerprint: payload.responseFingerprint || "",
          pathname: payload.pathname || "",
          messageCount: payload.messageCount || 0,
          planningArtifact: payload.planningArtifact || null,
          trace: payload.trace || null
        });
      }
      return { ok: true };
    }
  };
  const monitor = new ManagedBrowserCompletionMonitor({
    driver: {
      async readAssistantSnapshot() {
        return {
          ok: true, text: response, fingerprint: "fp-stale-terminal", messageCount: 1,
          pathname: "/c/stale", url: "https://chatgpt.com/c/stale", availability: "ready", generating: false
        };
      }
    },
    protocolAdapter: adapter,
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 1000,
    sleep: async () => {},
    logger
  });
  const traceValue = {
    traceId: "trace-stale-terminal",
    projectId: staleEvent.projectId,
    taskId: staleEvent.taskId,
    runId: staleEvent.runId,
    agentId: staleEvent.agentId,
    stage: "DISCOVERY",
    sessionId: "S1",
    dispatchKind: "normal",
    startedAt: Date.now()
  };
  monitor.start(runtime, "A1", {
    ok: true,
    agentId: "A1",
    sessionId: "S1",
    baseline: { ok: true, text: "", fingerprint: "", messageCount: 0, availability: "ready", generating: false },
    trace: traceValue
  });
  const result = await monitor.waitFor("A1");
  assert.equal(result.ok, true, "EventBus application remains behaviorally successful");
  const outcomes = terminal(logger.records, traceValue.traceId);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].event, "runtime_trace_failed");
  assert.equal(outcomes[0].details.reason, "planning_completion_not_consumed");
  assert.equal(outcomes[0].details.protocolApplied, true);
  assert.equal(outcomes[0].details.planningConsumed, false);
  assert.equal(store.getActiveProject().stage, "DISCOVERY");
});

test("one managed-browser trace correlates dispatch through EventBus application and planning advancement", async () => {
  const promptSentinel = "TRACE_PROMPT_CONTENT_SENTINEL";
  const assistantSentinel = "TRACE_ASSISTANT_CONTENT_SENTINEL";
  const logger = collectingLogger();
  const projectStore = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P1" });
  const eventStore = new EventStore({ stateStore: new MemoryStateStore() });

  let runtime = null;
  let sendCount = 0;
  let completionReads = 0;
  const session = { id: "S1", url: "https://chatgpt.com/", active: true, title: "ChatGPT" };
  const driver = {
    async start() { return { ok: true }; },
    async close() {},
    async getActiveSession() { return session; },
    async getSession(id) { return String(id) === "S1" ? session : null; },
    async createSession() { return session; },
    async navigateSession() { return session; },
    async removeSession() { return true; },
    async activateSession() { return session; },
    async pingSession() {
      return { ok: true, availability: "ready", generating: false, composerOccupied: false, url: session.url };
    },
    async sendPrompt(_sessionId, _prompt, options = {}) {
      sendCount += 1;
      this.lastTrace = options.trace;
      return { ok: true, accepted: true, confirmed: true, method: "test-confirmed", url: session.url };
    },
    async stopGeneration() { return { ok: true, availability: "ready", generating: false, url: session.url }; },
    async readAssistantSnapshot() {
      if (sendCount === 0) {
        return { ok: true, text: "", fingerprint: "", messageCount: 0, pathname: "/", url: session.url, availability: "ready", generating: false };
      }
      const agent = runtime?.getAgent?.("desktop-agent-1");
      const context = agent?.protocolContext || {};
      const artifact = discoveryArtifact({ constraints: [assistantSentinel] });
      const response = [
        "@@ORCH_ARTIFACT_BEGIN",
        JSON.stringify(artifact),
        "@@ORCH_ARTIFACT_END",
        `@@ORCH ${JSON.stringify({
          v: 1,
          event: "DONE",
          projectId: context.projectId,
          taskId: context.taskId,
          runId: context.runId,
          agentId: "desktop-agent-1",
          eventId: `${context.runId}-final`,
          sequence: 1,
          payload: { stage: "DISCOVERY" }
        })}`
      ].join("\n");

      if (sendCount === 1) {
        completionReads += 1;
        if (completionReads === 1) {
          return {
            ok: true,
            text: `partial ${assistantSentinel}`,
            fingerprint: "fp-partial",
            messageCount: 1,
            pathname: "/c/trace",
            url: session.url,
            availability: "generating",
            generating: true
          };
        }
        return {
          ok: true,
          text: response,
          fingerprint: "fp-final",
          messageCount: 1,
          pathname: "/c/trace",
          url: session.url,
          availability: "ready",
          generating: false
        };
      }

      return {
        ok: true,
        text: response,
        fingerprint: "fp-final",
        messageCount: 1,
        pathname: "/c/trace",
        url: session.url,
        availability: "ready",
        generating: false
      };
    }
  };

  const protocolAdapter = new ManagedBrowserProtocolAdapter({ logger });
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter,
    pollMs: 100,
    quietMs: 100,
    timeoutMs: 1000,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    logger
  });
  runtime = new CompletionAwareManagedBrowserRuntime({
    driver,
    completionMonitor: monitor,
    profileDirectory: process.cwd(),
    logger
  });
  await runtime.load();
  const createdSession = await runtime.createSession({ url: session.url, active: true });
  const lead = await runtime.createAgentForSession({ role: "lead", session: createdSession, status: "IDLE" });

  const bus = new EventBus({ registry: runtime, store: eventStore, logger });
  await bus.load();
  let traceNumber = 0;
  let runNumber = 0;
  const engine = new PlanningEngine({
    projectStore,
    registry: runtime,
    eventBus: bus,
    idFactory: () => `run-${++runNumber}`,
    traceIdFactory: () => `id-${++traceNumber}`,
    sendPrompt: (agentId, prompt, options) => runtime.sendPrompt(agentId, prompt, options),
    logger
  });

  runtime.bindHostHandlers({
    onRuntimeMessage: async (message, sender) => {
      if (message.type === MESSAGE_TYPES.ORCHESTRA_EVENT) {
        const payload = message.payload || {};
        return bus.handleEvent(payload.event, sender, {
          responseFingerprint: payload.responseFingerprint || "",
          pathname: payload.pathname || "",
          messageCount: payload.messageCount || 0,
          planningArtifact: payload.planningArtifact || null,
          workerArtifact: payload.workerArtifact || null,
          trace: payload.trace || null
        });
      }
      if (message.type === MESSAGE_TYPES.PROTOCOL_ERROR) return bus.handleProtocolError(message.payload || {}, sender);
      return { ok: true };
    }
  });

  await engine.init();
  const started = await engine.startProject({
    goal: `Trace the managed-browser planning path without logging ${promptSentinel}.`,
    repositoryUrl: "https://github.com/acme/widget"
  });
  assert.equal(started.ok, true);
  const firstTraceId = driver.lastTrace.traceId;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (logger.records.some((record) => record.event === "runtime_trace_completed" && record.details.traceId === firstTraceId)) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const firstTraceRecords = logger.records.filter((record) => record.details?.traceId === firstTraceId);
  const names = new Set(firstTraceRecords.map((record) => record.event));
  for (const expected of [
    "planning_stage_dispatch_started",
    "managed_browser_completion_prepare_started",
    "managed_browser_completion_prepare_completed",
    "managed_browser_prompt_send_started",
    "managed_browser_prompt_send_completed",
    "managed_browser_generation_started",
    "managed_browser_assistant_change_detected",
    "managed_browser_generation_stopped",
    "managed_browser_completion_candidate",
    "managed_browser_completion_stable",
    "managed_browser_protocol_parsed",
    "orchestra_event_accepted",
    "orchestra_event_apply_started",
    "planning_completion_consumed",
    "planning_stage_completed",
    "planning_stage_advancing",
    "orchestra_event_applied",
    "managed_browser_protocol_event_submitted",
    "runtime_trace_completed"
  ]) {
    assert.equal(names.has(expected), true, `missing trace event ${expected}`);
  }

  const terminals = terminal(logger.records, firstTraceId);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].event, "runtime_trace_completed");
  assert.equal(terminals[0].details.protocolAccepted, true);
  assert.equal(terminals[0].details.protocolApplied, true);
  assert.equal(terminals[0].details.planningConsumed, true);
  assert.equal(terminals[0].details.planningAdvanced, true);

  const dispatches = logger.records.filter((record) => record.event === "planning_stage_dispatch_started");
  assert.ok(dispatches.length >= 2);
  assert.notEqual(dispatches[0].details.traceId, dispatches[1].details.traceId);
  assert.equal(projectStore.getActiveProject().stage, "PLAN_V1");

  const serializedLogs = JSON.stringify(logger.records);
  assert.equal(serializedLogs.includes(promptSentinel), false);
  assert.equal(serializedLogs.includes(assistantSentinel), false);

  monitor.close();
  await runtime.close();
});
