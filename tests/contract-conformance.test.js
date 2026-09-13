const test = require("node:test");
const Contracts = require("../platform/contracts.js");
const { MemoryStateStore, FakeAgentRuntime, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");
const { FakeGitWorkspace } = require("../platform/fake-git-workspace.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { OrchestratorApi } = require("../background/orchestrator-api.js");
const {
  agentRuntimeConformance,
  stateStoreConformance,
  transactionalStateStoreConformance,
  timerRuntimeConformance,
  gitWorkspaceConformance,
  orchestratorApiConformance
} = require("./contracts/conformance.js");

test("Platform contract version exposes Phase 14 parity surfaces", () => {
  if (Contracts.CONTRACT_VERSION < 4) throw new Error("platform_contract_version_not_phase14");
  for (const query of ["contextSummary", "contextPacket"]) {
    if (!Contracts.API_QUERIES.includes(query)) throw new Error(`api_contract_missing:${query}`);
  }
  if (!Contracts.GIT_WORKSPACE_METHODS.length) throw new Error("git_workspace_contract_missing");
});

test("FakeAgentRuntime passes reusable AgentRuntime conformance", async () => {
  await agentRuntimeConformance(new FakeAgentRuntime());
});

test("MemoryStateStore passes reusable StateStore conformance", async () => {
  await stateStoreConformance(new MemoryStateStore());
});

test("Transactional MemoryStateStore passes reusable transactional conformance", async () => {
  await transactionalStateStoreConformance(new TransactionalStateStore({ store: new MemoryStateStore() }));
});

test("DeterministicTimerRuntime passes reusable TimerRuntime conformance", async () => {
  await timerRuntimeConformance(new DeterministicTimerRuntime());
});

test("FakeGitWorkspace passes reusable GitWorkspace conformance", async () => {
  await gitWorkspaceConformance(new FakeGitWorkspace());
});

test("OrchestratorApi recognizes every declared platform command/query", async () => {
  await orchestratorApiConformance(new OrchestratorApi({}));
});

test("contract assertions fail closed for partial GitWorkspace implementations", () => {
  if (!Contracts.assertGitWorkspace) throw new Error("assert_git_workspace_missing");
  require("node:assert/strict").throws(() => Contracts.assertGitWorkspace({ status() {} }), /git_workspace_contract_missing/);
});
