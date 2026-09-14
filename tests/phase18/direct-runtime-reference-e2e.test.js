const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../../content/message-types.js");
const { DeterministicTimerRuntime } = require("../../platform/fake-runtime.js");
const { ManagedBrowserAgentRuntime } = require("../../apps/desktop/main/managed-browser-agent-runtime.js");
const { ManagedBrowserProtocolAdapter } = require("../../apps/desktop/main/managed-browser-protocol-adapter.js");
const { createManagedBrowserDesktopHost } = require("../../apps/desktop/main/managed-browser-desktop-host.js");

const BASE = "a".repeat(40);
const TASK_COMMITS = Object.freeze({ T1: "b".repeat(40), T2: "c".repeat(40), T3: "d".repeat(40) });
const INTEGRATION_HEAD = "e".repeat(40);
const MERGE_T1 = "f".repeat(40);
const MERGE_T2 = "1".repeat(40);
const TASK_FILES = Object.freeze({ T1: "src/core/contract.js", T2: "src/worker/feature.js", T3: "tests/integration.test.js" });

function silentLogger() { return { info() {}, warn() {}, error() {}, log() {}, debug() {} }; }

class DirectReferenceDriver {
  constructor() {
    this.sessions = new Map();
    this.nextSession = 1;
    this.prompts = [];
    this.stops = [];
    this.availability = "ready";
  }
  async start({ profileDirectory } = {}) { this.profileDirectory = profileDirectory; return { ok: true }; }
  async close() {}
  async getActiveSession() { return [...this.sessions.values()].find((item) => item.active) || null; }
  async getSession(id) { const item = this.sessions.get(String(id)); return item ? { ...item } : null; }
  async createSession({ url = "about:blank", active = false } = {}) {
    if (active) for (const item of this.sessions.values()) item.active = false;
    const session = { id: `page-${this.nextSession++}`, url, active };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async navigateSession(id, url) { const item = this.sessions.get(String(id)); if (!item) throw new Error("session_missing"); item.url = url; return { ...item }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const item = this.sessions.get(String(id)); if (!item) throw new Error("session_missing"); for (const value of this.sessions.values()) value.active = false; item.active = true; return { ...item }; }
  async pingSession(id) { const item = this.sessions.get(String(id)); return item ? { ok: true, availability: this.availability, generating: false, url: item.url } : { ok: false, reason: "session_unavailable" }; }
  async sendPrompt(id, prompt) { if (!this.sessions.has(String(id))) return { ok: false, reason: "session_unavailable" }; this.prompts.push({ sessionId: String(id), prompt: String(prompt || "") }); return { ok: true, accepted: true }; }
  async stopGeneration(id) { this.stops.push(String(id)); return this.sessions.has(String(id)) ? { ok: true, stopped: true } : { ok: false, reason: "session_unavailable" }; }
}

class SyntheticGitProvider {
  branchName(projectId, taskId, runId) { return `orchestra/${projectId}/${taskId}/${runId}`; }
  async captureBase(project) {
    return { ok: true, snapshot: { provider: "phase18-direct-fixture", repositoryFullName: project.repository.fullName, defaultBranch: "main", baseSha: BASE, capturedAt: 1, cleanupPolicy: "retain_until_review_or_manual_cleanup", lastCheckedAt: 1, currentTargetSha: BASE, lastFreshnessStatus: "fresh" } };
  }
  async checkBaseFresh() { return { ok: true, currentTargetSha: BASE, checkedAt: Date.now() }; }
  async validateArtifact({ run }) {
    const commit = TASK_COMMITS[run.taskId];
    const changedFile = TASK_FILES[run.taskId];
    if (!commit || !changedFile) return { ok: false, reason: "fixture_unknown_task" };
    return { ok: true, artifact: { provider: "phase18-direct-fixture", branch: run.git.branch, commit, baseSha: BASE, targetBranch: "main", changedFiles: [changedFile], verifiedAt: Date.now() }, freshness: { ok: true, currentTargetSha: BASE, checkedAt: Date.now() } };
  }
  async compare(_project, base, head) {
    const taskId = Object.keys(TASK_COMMITS).find((id) => TASK_COMMITS[id] === head);
    if (base === BASE && taskId) {
      const filename = TASK_FILES[taskId];
      return { ok: true, comparison: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_commit: { sha: BASE }, files: [{ filename, status: "modified", additions: 2, deletions: 1, changes: 3, patch: `@@ -1 +1,2 @@\n-old\n+${taskId}\n+direct-runtime` }] } };
    }
    if (base === BASE && head === INTEGRATION_HEAD) {
      return { ok: true, comparison: { status: "ahead", ahead_by: 3, behind_by: 0, total_commits: 6, merge_base_commit: { sha: BASE }, files: Object.values(TASK_FILES).map((filename) => ({ filename, status: "modified", additions: 2, deletions: 0, changes: 2 })) } };
    }
    if (Object.values(TASK_COMMITS).includes(base) && head === INTEGRATION_HEAD) {
      return { ok: true, comparison: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_commit: { sha: base }, files: [] } };
    }
    return { ok: false, reason: "fixture_compare_unexpected", base, head };
  }
  async getBranchHead(_project, branch) {
    if (String(branch).includes("/integration/")) return { ok: true, branch, sha: INTEGRATION_HEAD };
    const taskId = Object.keys(TASK_COMMITS).find((id) => String(branch).includes(`/${id}/`));
    return taskId ? { ok: true, branch, sha: TASK_COMMITS[taskId] } : { ok: false, reason: "git_repository_or_ref_unavailable", branch };
  }
  async request(resourcePath) {
    const suffix = String(resourcePath);
    if (suffix.endsWith(`/git/commits/${INTEGRATION_HEAD}`)) return { ok: true, data: { sha: INTEGRATION_HEAD, parents: [{ sha: MERGE_T2 }, { sha: TASK_COMMITS.T3 }] } };
    if (suffix.endsWith(`/git/commits/${MERGE_T2}`)) return { ok: true, data: { sha: MERGE_T2, parents: [{ sha: MERGE_T1 }, { sha: TASK_COMMITS.T2 }] } };
    if (suffix.endsWith(`/git/commits/${MERGE_T1}`)) return { ok: true, data: { sha: MERGE_T1, parents: [{ sha: BASE }, { sha: TASK_COMMITS.T1 }] } };
    return { ok: false, reason: "fixture_commit_not_found" };
  }
}

function taskGraph() {
  return {
    objectiveCoveredBy: ["T3"],
    tasks: [
      { id: "T1", title: "Core contract", objective: "Implement the core contract independently.", kind: "code", dependencies: [], scope: { allow: ["src/core/**"] }, acceptanceCriteria: ["core contract accepted"], verification: ["npm test"], priority: 90, risk: "low", estimatedComplexity: "S" },
      { id: "T2", title: "Worker feature", objective: "Implement the worker feature independently.", kind: "code", dependencies: [], scope: { allow: ["src/worker/**"] }, acceptanceCriteria: ["worker feature accepted"], verification: ["npm test"], priority: 80, risk: "low", estimatedComplexity: "S" },
      { id: "T3", title: "Integration tests", objective: "Verify the two independent changes together.", kind: "code", dependencies: ["T1", "T2"], scope: { allow: ["tests/**"] }, acceptanceCriteria: ["integrated behavior accepted"], verification: ["npm test"], priority: 70, risk: "low", estimatedComplexity: "S" }
    ]
  };
}

function planningArtifacts() {
  const graph = taskGraph();
  return {
    DISCOVERY: { repositoryAccess: { status: "ok", inspectedPaths: ["package.json", "src/index.js"], gaps: [] }, stack: ["JavaScript"], entrypoints: ["src/index.js"], commands: { build: [], test: ["npm test"], lint: [], typecheck: [] }, testCommands: ["npm test"], modules: ["src", "tests"], persistence: [], ci: ["GitHub Actions"], instructions: { agentsMd: "absent", paths: [] }, sensitiveAreas: [], constraints: [] },
    PLAN_V1: { milestones: [{ id: "M1", objective: "parallel implementation and integration", dependencies: [] }], risks: [], verificationStrategy: ["npm test"], completionDefinition: "All direct-runtime fixture tasks are reviewed and integrated." },
    CRITIQUE: { findings: [{ severity: "low", issue: "retain deterministic evidence", correction: "use fixture Git provenance" }], blockingIssues: [] },
    PLAN_V2: { milestones: [{ id: "M1", objective: "parallel implementation and integration", dependencies: [] }], risks: [], verificationStrategy: ["npm test"], completionDefinition: "All direct-runtime fixture tasks are reviewed and integrated.", agentsMdProposal: { action: "no_change" } },
    DECOMPOSE: graph,
    DAG_CRITIC: graph
  };
}

function approvalPayload(task) {
  return { summary: `${task.id} satisfies the reference acceptance criteria`, criteria: task.acceptanceCriteria.map((criterion) => ({ criterion, status: "PASS", evidence: "direct-runtime synthetic diff evidence" })), scopeCheck: { status: "PASS", evidence: "changed files stay inside task scope" }, testsAssessment: { status: "PASS", evidence: "npm test passed in deterministic fixture" }, issues: [], requiredChanges: [] };
}

function snapshot(text, index = 1) {
  return { text, fingerprint: `direct-fp-${index}`, messageCount: index, pathname: "/c/direct-reference", url: "https://chatgpt.com/c/direct-reference", availability: "ready", generating: false };
}

function eventLine(event) { return `@@ORCH ${JSON.stringify(event)}`; }
function planningText(artifact, event) { return `@@ORCH_ARTIFACT_BEGIN\n${JSON.stringify(artifact)}\n@@ORCH_ARTIFACT_END\n${eventLine(event)}`; }

async function publishReady(runtime, agent) {
  const sessionId = runtime.sessionIdForAgent(agent);
  return runtime.publishRuntimeMessage({ type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.CONTENT_HEARTBEAT, payload: { availability: "ready", generating: false } }, { agentId: agent.agentId, sessionId, url: agent.chatUrl || "https://chatgpt.com/" });
}

async function completePlanningThroughDirectRuntime(host, adapter) {
  const artifacts = planningArtifacts();
  const order = ["DISCOVERY", "PLAN_V1", "CRITIQUE", "PLAN_V2", "DECOMPOSE", "DAG_CRITIC"];
  const lead = host.agentRuntime.listAgents().find((agent) => agent.role === "lead");
  let index = 1;
  for (const stage of order) {
    const project = host.projectStore.getActiveProject();
    assert.equal(project.stage, stage);
    const context = host.agentRuntime.getAgent(lead.agentId).protocolContext;
    assert.equal(context.taskId, `planning:${stage.toLowerCase()}`);
    const event = { v: 1, event: "DONE", projectId: project.projectId, taskId: context.taskId, runId: context.runId, agentId: lead.agentId, eventId: `direct-planning-${stage.toLowerCase()}`, sequence: 1, payload: { stage } };
    const published = await adapter.publishCompletion(host.agentRuntime, lead.agentId, snapshot(planningText(artifacts[stage], event), index++));
    assert.equal(published.ok, true, `planning stage ${stage} must pass through direct runtime protocol boundary`);
  }
}

async function approveQueuedReviewsThroughDirectRuntime(host, adapter, projectId, counter) {
  let guard = 0;
  while (host.reviewStore.pending().length || host.reviewStore.active().length) {
    guard += 1;
    assert.ok(guard < 10, "direct-runtime reviews must converge");
    await host.reviewEngine.tick({ reason: "phase18_direct_reference_review" });
    const active = host.reviewStore.active();
    assert.ok(active.length > 0, "pending reviews must assign to a direct runtime agent");
    for (const review of active) {
      const reviewer = host.agentRuntime.getAgent(review.reviewerAgentId);
      await publishReady(host.agentRuntime, reviewer);
      const task = host.schedulerStore.getTask(review.taskId);
      const event = { v: 1, event: "REVIEW_APPROVED", projectId, taskId: review.taskId, runId: review.reviewId, agentId: review.reviewerAgentId, eventId: `direct-review-${review.reviewId}`, sequence: 1, payload: approvalPayload(task) };
      const published = await adapter.publishCompletion(host.agentRuntime, review.reviewerAgentId, snapshot(eventLine(event), counter.value++));
      assert.equal(published.ok, true);
    }
  }
}

test("managed desktop runtime executes a full synthetic reference project without extension or companion", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-phase18-reference-"));
  const profileDirectory = path.join(dataDirectory, "browser-profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const driver = new DirectReferenceDriver();
  const runtime = new ManagedBrowserAgentRuntime({ driver, profileDirectory, agentIdPrefix: "direct-agent" });
  const adapter = new ManagedBrowserProtocolAdapter({ logger: silentLogger() });
  const host = await createManagedBrowserDesktopHost({ dataDirectory, agentRuntime: runtime, gitProvider: new SyntheticGitProvider(), timerRuntime: new DeterministicTimerRuntime(), logger: silentLogger(), openLoginWindow: true });
  const counter = { value: 20 };

  try {
    assert.equal(host.agentRuntime.constructor.name, "ManagedBrowserAgentRuntime");
    assert.equal(driver.profileDirectory, path.resolve(profileDirectory));
    assert.equal(host.companionUnbind, undefined);

    const registered = await host.execute("registerManagedBrowserLead");
    assert.equal(registered.ok, true);
    const lead = runtime.listAgents().find((agent) => agent.role === "lead");
    assert.ok(lead?.agentId);
    assert.equal(lead.tabId, null);
    assert.ok(lead.sessionId);

    const started = await host.execute("startProject", { goal: "Run the Phase 18 direct-runtime reference project without extension.", repositoryUrl: "https://github.com/acme/widget" });
    assert.equal(started.ok, true);
    await completePlanningThroughDirectRuntime(host, adapter);
    const readyProject = host.projectStore.getActiveProject();
    assert.equal(readyProject.status, "READY");
    assert.equal(readyProject.taskGraph.tasks.length, 3);

    const execution = await host.execute("startExecution", { maxWorkers: 2, maxRetries: 1, maxReviewIterations: 2 });
    assert.equal(execution.ok, true);
    for (const worker of runtime.listAgents().filter((agent) => agent.role === "worker")) await publishReady(runtime, worker);
    await host.schedulerEngine.tick({ reason: "phase18_direct_workers_ready" });

    const firstRuns = host.schedulerStore.activeRuns();
    assert.equal(firstRuns.length, 2);
    assert.deepEqual(new Set(firstRuns.map((run) => run.taskId)), new Set(["T1", "T2"]));
    const projectId = readyProject.projectId;

    for (const run of firstRuns) {
      const event = { v: 1, event: "DONE", projectId, taskId: run.taskId, runId: run.runId, agentId: run.agentId, eventId: `direct-worker-${run.runId}`, sequence: 1, payload: { summary: `${run.taskId} completed`, testsPerformed: ["npm test"], knownLimitations: [] } };
      const published = await adapter.publishCompletion(runtime, run.agentId, snapshot(eventLine(event), counter.value++));
      assert.equal(published.ok, true);
    }

    await approveQueuedReviewsThroughDirectRuntime(host, adapter, projectId, counter);
    assert.equal(host.schedulerStore.getTask("T1").status, "APPROVED");
    assert.equal(host.schedulerStore.getTask("T2").status, "APPROVED");

    let finalRun = host.schedulerStore.activeRuns().find((run) => run.taskId === "T3");
    if (!finalRun) {
      await host.schedulerEngine.tick({ reason: "phase18_direct_dependency_unlocked" });
      finalRun = host.schedulerStore.activeRuns().find((run) => run.taskId === "T3");
    }
    assert.ok(finalRun);
    const finalEvent = { v: 1, event: "DONE", projectId, taskId: finalRun.taskId, runId: finalRun.runId, agentId: finalRun.agentId, eventId: `direct-worker-${finalRun.runId}`, sequence: 1, payload: { summary: "T3 completed", testsPerformed: ["npm test"], knownLimitations: [] } };
    assert.equal((await adapter.publishCompletion(runtime, finalRun.agentId, snapshot(eventLine(finalEvent), counter.value++))).ok, true);
    await approveQueuedReviewsThroughDirectRuntime(host, adapter, projectId, counter);
    assert.equal(host.schedulerStore.getTask("T3").status, "APPROVED");

    const afterReviews = host.schedulerStore.summary().status;
    assert.equal(["READY_FOR_INTEGRATION", "INTEGRATING"].includes(afterReviews), true);
    if (afterReviews === "READY_FOR_INTEGRATION") await host.integrationEngine.tick({ reason: "phase18_direct_integration" });
    const integrationRun = host.integrationStore.currentRun();
    assert.ok(integrationRun);
    const integrationEvent = {
      v: 1, event: "DONE", projectId, taskId: "integration", runId: integrationRun.runId, agentId: integrationRun.agentId, eventId: `direct-integration-${integrationRun.runId}`, sequence: 1,
      payload: { integration: { branch: integrationRun.branch, commit: INTEGRATION_HEAD, baseSha: BASE, targetBranch: "main", mergedTaskIds: integrationRun.mergeTaskIds, changedFiles: Object.values(TASK_FILES), checks: integrationRun.verificationCommands.map((command) => ({ command, status: "PASS", evidence: "direct-runtime deterministic verification passed" })), summary: "direct desktop synthetic integration verified" } }
    };
    assert.equal((await adapter.publishCompletion(runtime, integrationRun.agentId, snapshot(eventLine(integrationEvent), counter.value++))).ok, true);

    assert.equal(host.integrationStore.summary().status, "INTEGRATION_VERIFIED");
    assert.equal(host.schedulerStore.summary().status, "INTEGRATION_VERIFIED");
    assert.equal(host.projectStore.getActiveProject().status, "INTEGRATION_VERIFIED");
    assert.ok(driver.prompts.length >= 10, "planning, workers, reviewers and integrator must all receive prompts through the managed driver");

    const exported = await host.execute("exportProjectBundle", {});
    assert.equal(exported.ok, true);
    assert.equal(exported.serialized.includes("\"tabId\""), false);
    assert.equal(exported.serialized.includes("\"sessionId\""), false);
    assert.equal(exported.serialized.includes(profileDirectory), false);
  } finally {
    await host.close();
  }
});
