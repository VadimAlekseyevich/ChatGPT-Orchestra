const test = require("node:test");
const assert = require("node:assert/strict");

const { bindCompanionAgentRuntime } = require("../apps/desktop/main/companion-host-binding.js");

test("desktop companion binding routes runtime and session events through existing Core controllers", async () => {
  let handlers = null;
  let unbound = false;
  const agents = new Map([["A1", { agentId: "A1", sessionId: "S1" }]]);
  const calls = [];
  const host = {
    agentRuntime: {
      bindHostHandlers(value) { handlers = value; return () => { unbound = true; }; },
      getAgent(id) { return agents.get(id) || null; },
      getAgentBySessionId(id) { return [...agents.values()].find((agent) => agent.sessionId === id) || null; }
    },
    orchestrator: {
      async handleRuntimeMessage(message, sender) { calls.push(["runtime", message.type, sender.agentId]); return { ok: true }; },
      async handleSessionRemoved(id) { calls.push(["removed", id]); },
      async handleSessionUpdated(id, changeInfo) { calls.push(["updated", id, changeInfo.status]); }
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

  assert.equal((await handlers.onRuntimeMessage({ type: "CONTENT_HEARTBEAT" }, { agentId: "A1" })).ok, true);
  await handlers.onSessionUpdated("S1", { status: "complete" }, { id: "S1" });
  await handlers.onSessionRemoved("S1");

  assert.deepEqual(calls, [
    ["runtime", "CONTENT_HEARTBEAT", "A1"],
    ["state", "A1"],
    ["recovery", "companion:CONTENT_HEARTBEAT"],
    ["updated", "S1", "complete"],
    ["state", "A1"],
    ["recovery", "companion:session_updated"],
    ["removed", "S1"],
    ["unavailable", "A1", "session_closed"],
    ["recovery", "companion:session_removed"]
  ]);

  unbind();
  assert.equal(unbound, true);
});
