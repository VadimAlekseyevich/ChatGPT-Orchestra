const assert = require("node:assert/strict");
const Contracts = require("../../platform/contracts.js");

async function agentRuntimeConformance(runtime) {
  Contracts.assertAgentRuntime(runtime);
  await runtime.load();
  const session = await runtime.createSession({ url: "about:blank", active: true });
  assert.ok(session?.id);
  const agent = await runtime.createAgentForSession({ role: "worker", session, label: "contract" });
  assert.ok(agent?.agentId);
  assert.equal(runtime.isAgentConnected(agent.agentId), true);
  await runtime.setProtocolContext(agent.agentId, { projectId: "P1", taskId: "T1", runId: "R1" });
  assert.equal(runtime.getAgent(agent.agentId).protocolContext.runId, "R1");
  const sent = await runtime.sendPrompt(agent.agentId, "contract prompt");
  assert.equal(sent?.ok, true);
  const stopped = await runtime.stopAgent(agent.agentId);
  assert.equal(stopped?.ok, true);
  await runtime.clearProtocolContext(agent.agentId);
  assert.equal(runtime.getAgent(agent.agentId).protocolContext, null);
  await runtime.removeSession(session.id);
}

async function stateStoreConformance(store) {
  Contracts.assertStateStore(store);
  await store.set({ alpha: { value: 1 }, beta: 2 });
  assert.deepEqual((await store.get("alpha")).alpha, { value: 1 });
  assert.equal((await store.get("beta")).beta, 2);
}

async function transactionalStateStoreConformance(store) {
  Contracts.assertTransactionalStateStore(store);
  await store.set({ alpha: 1 });
  await store.transaction(async (tx) => {
    assert.equal((await tx.get("alpha")).alpha, 1);
    await tx.set({ alpha: 2, beta: true });
  });
  assert.equal((await store.get("alpha")).alpha, 2);
  assert.equal((await store.get("beta")).beta, true);
  await store.remove("beta");
  assert.equal((await store.get("beta")).beta, undefined);
}

async function timerRuntimeConformance(timer) {
  Contracts.assertTimerRuntime(timer);
  let count = 0;
  timer.scheduleRecurring("contract", { periodMinutes: 1 }, () => { count += 1; });
  if (typeof timer.fire === "function") {
    assert.equal(await timer.fire("contract"), true);
    assert.equal(count, 1);
  }
  await timer.cancel("contract");
  if (typeof timer.fire === "function") assert.equal(await timer.fire("contract"), false);
}

async function gitWorkspaceConformance(workspace) {
  Contracts.assertGitWorkspace(workspace);
  assert.equal((await workspace.loadRepository({ url: "https://github.com/acme/demo" })).ok, true);
  const base = await workspace.snapshotBase();
  assert.equal(base.ok, true);
  assert.match(base.baseSha, /^[0-9a-f]{40}$/i);
  const task = await workspace.createTaskWorkspace({ projectId: "P1", taskId: "T1", runId: "R1", startSha: base.baseSha });
  assert.ok(task.workspaceId);
  assert.equal((await workspace.status(task.workspaceId)).ok, true);
  assert.equal((await workspace.diff(task.workspaceId)).ok, true);
  assert.equal((await workspace.validateScope(task.workspaceId, { allow: ["src/"] })).ok, true);
  assert.equal((await workspace.runVerification(task.workspaceId, ["npm test"])).ok, true);
  assert.equal((await workspace.commit(task.workspaceId, { message: "contract" })).ok, true);
  assert.equal(await workspace.cleanup(task.workspaceId), true);
}

module.exports = {
  agentRuntimeConformance,
  stateStoreConformance,
  transactionalStateStoreConformance,
  timerRuntimeConformance,
  gitWorkspaceConformance
};
