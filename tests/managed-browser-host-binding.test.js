const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bindManagedBrowserAgentRuntime,
  handleManagedApiMessage
} = require("../apps/desktop/main/managed-browser-host-binding.js");

function harness() {
  const calls = [];
  let handlers = null;
  const agent = { agentId: "A1", sessionId: "S1", status: "IDLE" };
  const host = {
    root: {
      ORCHESTRATOR_API_VERSION: 4,
      MESSAGE_TYPES: { ORCHESTRATOR_API_QUERY: "API_QUERY", ORCHESTRATOR_API_EXECUTE: "API_EXECUTE" }
    },
    agentRuntime: {
      bindHostHandlers(value) { handlers = value; return () => { handlers = null; }; },
      getAgent(agentId) { return agentId === "A1" ? { ...agent } : null; },
      getAgentBySessionId(sessionId) { return sessionId === "S1" ? { ...agent } : null; }
    },
    orchestrator: {
      async handleRuntimeMessage(message, sender) { calls.push(["runtime", message, sender]); return { ok: true, accepted: true }; },
      async handleSessionRemoved(sessionId) { calls.push(["removed", sessionId]); },
      async handleSessionUpdated(sessionId, changeInfo, session) { calls.push(["updated", sessionId, changeInfo, session]); }
    },
    integrationEngine: {
      async handleAgentStateChanged(value) { calls.push(["integration-state", value.agentId]); },
      async handleAgentUnavailable(agentId, reason) { calls.push(["integration-unavailable", agentId, reason]); }
    },
    recoveryController: {
      async tick(options) { calls.push(["recovery", options.reason]); }
    },
    async query(name, payload) { calls.push(["query", name, payload]); return { ok: true, query: name }; },
    async execute(name, payload) { calls.push(["execute", name, payload]); return { ok: true, command: name }; },
    orchestratorApi: {
      async handleLegacyMessage(message, sender) { calls.push(["legacy", message, sender]); return { ok: true }; }
    }
  };
  return { host, calls, getHandlers: () => handlers };
}

test("managed browser host binding routes runtime messages through the existing orchestrator boundary", async () => {
  const { host, calls, getHandlers } = harness();
  const unbind = bindManagedBrowserAgentRuntime(host);
  const handlers = getHandlers();
  assert.ok(handlers);
  const result = await handlers.onRuntimeMessage({ type: "ORCHESTRA_EVENT", payload: { event: { eventId: "E1" } } }, { kind: "agent-session", sessionId: "S1", agentId: "A1", url: "https://chatgpt.com/" });
  assert.equal(result.accepted, true);
  assert.equal(calls[0][0], "runtime");
  assert.ok(calls.some((entry) => entry[0] === "integration-state" && entry[1] === "A1"));
  assert.ok(calls.some((entry) => entry[0] === "recovery" && entry[1] === "direct-browser:ORCHESTRA_EVENT"));
  unbind();
  assert.equal(getHandlers(), null);
});

test("managed browser host binding forwards session close/navigation into existing recovery hooks", async () => {
  const { host, calls, getHandlers } = harness();
  bindManagedBrowserAgentRuntime(host);
  const handlers = getHandlers();
  await handlers.onSessionUpdated("S1", { url: "https://chatgpt.com/c/next" }, { id: "S1", url: "https://chatgpt.com/c/next" });
  await handlers.onSessionRemoved("S1");
  assert.ok(calls.some((entry) => entry[0] === "updated" && entry[1] === "S1"));
  assert.ok(calls.some((entry) => entry[0] === "removed" && entry[1] === "S1"));
  assert.ok(calls.some((entry) => entry[0] === "integration-unavailable" && entry[1] === "A1"));
  assert.ok(calls.some((entry) => entry[0] === "recovery" && entry[1] === "direct-browser:session_updated"));
  assert.ok(calls.some((entry) => entry[0] === "recovery" && entry[1] === "direct-browser:session_removed"));
});

test("agent browser sessions cannot call desktop Orchestrator API commands", async () => {
  const { host } = harness();
  const blocked = await handleManagedApiMessage(host, { type: "API_EXECUTE", payload: { name: "stopNow" } }, { sessionId: "S1", agentId: "A1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "orchestrator_command_forbidden_from_agent_session");
});

test("non-agent desktop browser UI messages may use the normal API boundary", async () => {
  const { host, calls } = harness();
  const queried = await handleManagedApiMessage(host, { type: "API_QUERY", payload: { name: "state", payload: { x: 1 } } }, { kind: "desktop-browser-ui", sessionId: null });
  const executed = await handleManagedApiMessage(host, { type: "API_EXECUTE", payload: { name: "pause", payload: {} } }, { kind: "desktop-browser-ui", sessionId: null });
  assert.equal(queried.ok, true);
  assert.equal(executed.ok, true);
  assert.ok(calls.some((entry) => entry[0] === "query" && entry[1] === "state"));
  assert.ok(calls.some((entry) => entry[0] === "execute" && entry[1] === "pause"));
});
