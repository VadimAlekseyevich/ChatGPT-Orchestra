const test = require("node:test");
const assert = require("node:assert/strict");

const { bindCompanionAgentRuntime } = require("../apps/desktop/main/companion-host-binding.js");

test("desktop companion binding translates runtime binding details before Core controllers", async () => {
  let handlers = null;
  let unbound = false;
  const agents = new Map([["A1", { agentId: "A1", sessionId: "S1" }]]);
  const calls = [];
  const host = {
    root: {
      MESSAGE_TYPES: { CONTENT_HEARTBEAT: "CONTENT_HEARTBEAT" },
      ORCHESTRATOR_API_VERSION: 4
    },
    agentRuntime: {
      bindHostHandlers(value) { handlers = value; return () => { unbound = true; }; },
      getAgent(id) { return agents.get(id) || null; },
      getAgentBySessionId(id) { return [...agents.values()].find((agent) => agent.sessionId === id) || null; }
    },
    agentPool: {
      portableSender(sender) { return { agentId: sender.agentId || null, runtimeKind: "companion", bindingPresent: Boolean(sender.sessionId) }; },
      async handleContentMessage(message) { calls.push(["adapter-message", message.type]); return { ok: true, agentId: "A1" }; },
      async handleBindingUpdated(id) { calls.push(["adapter-updated", id]); return { ok: true, agentId: "A1" }; },
      async handleBindingRemoved(id) { calls.push(["adapter-removed", id]); return { ok: true, agentId: "A1" }; }
    },
    orchestrator: {
      async handleRuntimeMessage(message, sender) { calls.push(["runtime", message.type, sender]); return { ok: true }; },
      async handleAgentStateChanged(agentId) { calls.push(["core-state", agentId]); },
      async handleAgentUnavailable(agentId, reason) { calls.push(["core-unavailable", agentId, reason]); }
    },
    integrationEngine: {
      async handleAgentStateChanged(agent) { calls.push(["state", agent.agentId]); },
      async handleAgentUnavailable(agentId, reason) { calls.push(["unavailable", agentId, reason]); }
    },
    recoveryController: {
      async tick({ reason }) { calls.push(["recovery", reason]); }
    }
  };

  const unbind = bindCompanionAgentRuntime(host);
  assert.equal(typeof unbind, "function");
  assert.ok(handlers);

  assert.equal((await handlers.onRuntimeMessage({ type: "CONTENT_HEARTBEAT" }, { agentId: "A1", sessionId: "S1" })).ok, true);
  await handlers.onSessionUpdated("S1", { status: "complete" }, { id: "S1" });
  await handlers.onSessionRemoved("S1");

  assert.ok(calls.some((entry) => entry[0] === "adapter-message"));
  assert.equal(calls.some((entry) => entry[0] === "runtime"), false);
  assert.ok(calls.some((entry) => entry[0] === "core-state" && entry[1] === "A1"));
  assert.ok(calls.some((entry) => entry[0] === "adapter-updated" && entry[1] === "S1"));
  assert.ok(calls.some((entry) => entry[0] === "adapter-removed" && entry[1] === "S1"));
  assert.ok(calls.some((entry) => entry[0] === "core-unavailable" && entry[1] === "A1"));
  assert.ok(calls.some((entry) => entry[0] === "unavailable" && entry[1] === "A1"));
  assert.ok(calls.some((entry) => entry[0] === "recovery" && entry[1] === "companion:binding_updated"));
  assert.ok(calls.some((entry) => entry[0] === "recovery" && entry[1] === "companion:binding_removed"));

  unbind();
  assert.equal(unbound, true);
});
