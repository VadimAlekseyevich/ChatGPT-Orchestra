const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DeterministicTimerRuntime } = require("../../platform/fake-runtime.js");
const { DesktopHost } = require("../../apps/desktop/main/desktop-host.js");

const BASE = "a".repeat(40);
const TASK_COMMITS = Object.freeze({
  T1: "b".repeat(40),
  T2: "c".repeat(40),
  T3: "d".repeat(40)
});
const INTEGRATION_HEAD = "e".repeat(40);
const MERGE_T1 = "f".repeat(40);
const MERGE_T2 = "1".repeat(40);
const TASK_FILES = Object.freeze({
  T1: "src/core/contract.js",
  T2: "src/worker/feature.js",
  T3: "tests/integration.test.js"
});

function silentLogger() {
  return { info() {}, warn() {}, error() {}, log() {} };
}

class SyntheticGitProvider {
  branchName(projectId, taskId, runId) {
    return `orchestra/${projectId}/${taskId}/${runId}`;
  }

  async captureBase(project) {
    return {
      ok: true,
      snapshot: {
        provider: "phase15-fixture",
        repositoryFullName: project.repository.fullName,
        defaultBranch: "main",
        baseSha: BASE,
        capturedAt: 1,
        cleanupPolicy: "retain_until_review_or_manual_cleanup",
        lastCheckedAt: 1,
        currentTargetSha: BASE,
        lastFreshnessStatus: "fresh"
      }
    };
  }

  async checkBaseFresh() {
    return { ok: true, currentTargetSha: BASE, checkedAt: Date.now() };
  }

  async validateArtifact({ run }) {
    const commit = TASK_COMMITS[run.taskId];
    const changedFile = TASK_FILES[run.taskId];
    if (!commit || !changedFile) return { ok: false, reason: "fixture_unknown_task" };
    return {
      ok: true,
      artifact: {
        provider: "phase15-fixture",
        branch: run.git.branch,
        commit,
        baseSha: BASE,
        targetBranch: "main",
        changedFiles: [changedFile],
        verifiedAt: Date.now()
      },
      freshness: { ok: true, currentTargetSha: BASE, checkedAt: Date.now() }
    };
  }

  async compare(_project, base, head) {
    const taskId = Object.keys(TASK_COMMITS).find((id) => TASK_COMMITS[id] === head);
    if (base === BASE && taskId) {
      const filename = TASK_FILES[taskId];
      return {
        ok: true,
        comparison: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          merge_base_commit: { sha: BASE },
          files: [{ filename, status: "modified", additions: 2, deletions: 1, changes: 3, patch: `@@ -1 +1,2 @@\n-old\n+${taskId}\n+fixture` }]
        }
      };
    }
    if (base === BASE && head === INTEGRATION_HEAD) {
      return {
        ok: true,
        comparison: {
          status: "ahead",
          ahead_by: 3,
          behind_by: 0,
          total_commits: 6,
          merge_base_commit: { sha: BASE },
          files: Object.values(TASK_FILES).map((filename) => ({ filename, status: "modified", additions: 2, deletions: 0, changes: 2 }))
        }
      };
    }
    if (Object.values(TASK_COMMITS).includes(base) && head === INTEGRATION_HEAD) {
      return {
        ok: true,
        comparison: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          merge_base_commit: { sha: base },
          files: []
        }
      };
    }
    return { ok: false, reason: "fixture_compare_unexpected", base, head };
  }

  async getBranchHead(_project, branch) {
    if (String(branch).includes("/integration/")) return { ok: true, branch, sha: INTEGRATION_HEAD };
    const taskId = Object.keys(TASK_COMMITS).find((id) => String(branch).includes(`/${id}/`));
    return taskId
      ? { ok: true, branch, sha: TASK_COMMITS[taskId] }
      : { ok: false, reason: "git_repository_or_ref_unavailable", branch };
  }

  async request(resourcePath) {
    const suffix = String(resourcePath);
    if (suffix.endsWith(`/git/commits/${INTEGRATION_HEAD}`)) {
      return { ok: true, data: { sha: INTEGRATION_HEAD, parents: [{ sha: MERGE_T2 }, { sha: TASK_COMMITS.T3 }] } };
    }
    if (suffix.endsWith(`/git/commits/${MERGE_T2}`)) {
      return { ok: true, data: { sha: MERGE_T2, parents: [{ sha: MERGE_T1 }, { sha: TASK_COMMITS.T2 }] } };
    }
    if (suffix.endsWith(`/git/commits/${MERGE_T1}`)) {
      return { ok: true, data: { sha: MERGE_T1, parents: [{ sha: BASE }, { sha: TASK_COMMITS.T1 }] } };
    }
    return { ok: false, reason: "fixture_commit_not_found" };
  }
}

function taskGraph() {
  return {
    objectiveCoveredBy: ["T3"],
    tasks: [
      {
        id: "T1",
        title: "Core contract",
        objective: "Implement the core contract independently.",
        kind: "code",
        dependencies: [],
        scope: { allow: ["src/core/**"] },
        acceptanceCriteria: ["core contract accepted"],
        verification: ["npm test"],
        priority: 90,
        risk: "low",
        estimatedComplexity: "S"
      },
      {
        id: "T2",
        title: "Worker feature",
        objective: "Implement the worker feature independently.",
        kind: "code",
        dependencies: [],
        scope: { allow: ["src/worker/**"] },
        acceptanceCriteria: ["worker feature accepted"],
        verification: ["npm test"],
        priority: 80,
        risk: "low",
        estimatedComplexity: "S"
      },
      {
        id: "T3",
        title: "Integration tests",
        objective: "Verify the two independent changes together.",
        kind: "code",
        dependencies: ["T1", "T2"],
        scope: { allow: ["tests/**"] },
        acceptanceCriteria: ["integrated behavior accepted"],
        verification: ["npm test"],
        priority: 70,
        risk: "low",
        estimatedComplexity: "S"
      }
    ]
  };
}

function planningArtifacts() {
  const graph = taskGraph();
  return {
    DISCOVERY: {
      repositoryAccess: { status: "ok", inspectedPaths: ["package.json", "src/index.js"], gaps: [] },
      stack: ["JavaScript"],
      entrypoints: ["src/index.js"],
      commands: { build: [], test: ["npm test"], lint: [], typecheck: [] },
      testCommands: ["npm test"],
      modules: ["src", "tests"],
      persistence: ["SQLite"],
      ci: ["GitHub Actions"],
      instructions: { agentsMd: "absent", paths: [] },
      sensitiveAreas: [],
      constraints: []
    },
    PLAN_V1: {
      milestones: [{ id: "M1", objective: "parallel implementation and integration", dependencies: [] }],
      risks: [],
      verificationStrategy: ["npm test"],
      completionDefinition: "All fixture tasks are reviewed and integrated."
    },
    CRITIQUE: {
      findings: [{ severity: "low", issue: "retain deterministic evidence", correction: "use fixture Git provenance" }],
      blockingIssues: []
    },
    PLAN_V2: {
      milestones: [{ id: "M1", objective: "parallel implementation and integration", dependencies: [] }],
      risks: [],
      verificationStrategy: ["npm test"],
      completionDefinition: "All fixture tasks are reviewed and integrated.",
      agentsMdProposal: { action: "no_change" }
    },
    DECOMPOSE: graph,
    DAG_CRITIC: graph
  };
}

function workerDone(projectId, run) {
  return {
    event: {
      v: 1,
      event: "DONE",
      projectId,
      taskId: run.taskId,
      runId: run.runId,
      agentId: run.agentId,
      eventId: `fixture-${run.runId}-done`,
      sequence: 1,
      payload: { summary: `${run.taskId} completed`, testsPerformed: ["npm test"], knownLimitations: [] }
    }
  };
}

function approvalPayload(task) {
  return {
    summary: `${task.id} satisfies the fixture acceptance criteria`,
    criteria: task.acceptanceCriteria.map((criterion) => ({ criterion, status: "PASS", evidence: "synthetic diff and npm test evidence" })),
    scopeCheck: { status: "PASS", evidence: "changed files are inside the task allow-list" },
    testsAssessment: { status: "PASS", evidence: "npm test passed in the deterministic fixture" },
    issues: [],
    requiredChanges: []
  };
}

async function approveQueuedReviews(host, projectId) {
  let iterations = 0;
  while (host.reviewStore.pending().length || host.reviewStore.active().length) {
    iterations += 1;
    assert.ok(iterations < 10, "review fixture must converge");
    await host.reviewEngine.tick({ reason: "phase15_fixture_review" });
    const active = host.reviewStore.active();
    assert.ok(active.length > 0, "pending fixture reviews must be assignable after resume");
    for (const review of active) {
      const task = host.schedulerStore.getTask(review.taskId);
      await host.reviewEngine.handleReviewEvent({
        event: {
          event: "REVIEW_APPROVED",
          projectId,
          taskId: review.taskId,
          runId: review.reviewId,
          agentId: review.reviewerAgentId,
          payload: approvalPayload(task)
        }
      });
    }
  }
}

async function completePlanning(host) {
  const artifacts = planningArtifacts();
  const order = ["DISCOVERY", "PLAN_V1", "CRITIQUE", "PLAN_V2", "DECOMPOSE", "DAG_CRITIC"];
  for (const stage of order) {
    const project = host.projectStore.getActiveProject();
    assert.equal(project.stage, stage);
    await host.planningEngine.handleCompletion({
      event: {
        agentId: host.agentRuntime.listAgents().find((agent) => agent.role === "lead").agentId,
        projectId: project.projectId,
        event: "DONE",
        payload: { stage }
      },
      source: { planningArtifact: artifacts[stage] }
    });
  }
}

test("desktop SQLite host pauses at a safe point, restarts, resumes reviews and integrates deterministically", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-phase15-e2e-"));
  const gitProvider = new SyntheticGitProvider();
  let host = new DesktopHost({
    dataDirectory,
    gitProvider,
    timerRuntime: new DeterministicTimerRuntime(),
    logger: silentLogger()
  });

  try {
    await host.init();
    const started = await host.execute("startProject", {
      goal: "Exercise planning, parallel fake workers, review, restart recovery and integration.",
      repositoryUrl: "https://github.com/acme/widget"
    });
    assert.equal(started.ok, true);
    await completePlanning(host);

    const readyProject = host.projectStore.getActiveProject();
    assert.equal(readyProject.status, "READY");
    assert.equal(readyProject.taskGraph.tasks.length, 3);

    const execution = await host.execute("startExecution", { maxWorkers: 2, maxRetries: 1, maxReviewIterations: 2 });
    assert.equal(execution.ok, true);
    const firstRuns = host.schedulerStore.activeRuns();
    assert.equal(firstRuns.length, 2);
    assert.deepEqual(new Set(firstRuns.map((run) => run.taskId)), new Set(["T1", "T2"]));
    assert.equal(host.schedulerStore.getTask("T3").status, "READY");

    const pause = await host.execute("pause");
    assert.equal(pause.ok, true);
    assert.equal(host.recoveryStore.summary().status, "PAUSING");

    const projectId = readyProject.projectId;
    for (const run of firstRuns) await host.schedulerEngine.handleCompletion(workerDone(projectId, run));
    assert.equal(host.schedulerStore.activeRuns().length, 0);
    assert.equal(host.reviewStore.pending().length, 2);
    assert.equal(host.schedulerStore.getTask("T3").status, "READY");

    await host.recoveryController.tick({ reason: "phase15_fixture_safe_point" });
    assert.equal(host.recoveryStore.summary().status, "PAUSED");
    assert.equal(host.recoveryController.safePointSummary().reached, true);
    assert.equal(fs.existsSync(host.paths.stateDatabase), true);

    await host.close();

    host = new DesktopHost({
      dataDirectory,
      gitProvider,
      timerRuntime: new DeterministicTimerRuntime(),
      logger: silentLogger()
    });
    await host.init();

    const reopened = await host.query("recovery");
    assert.equal(reopened.ok, true);
    assert.equal(reopened.recovery.status, "PAUSED");
    assert.equal(host.reviewStore.pending().length, 2);
    assert.equal(host.schedulerStore.getTask("T1").status, "REVIEW_PENDING");
    assert.equal(host.schedulerStore.getTask("T2").status, "REVIEW_PENDING");

    const resumed = await host.execute("resume");
    assert.equal(resumed.ok, true);
    assert.equal(host.recoveryStore.summary().status, "RUNNING");
    assert.equal(host.agentRuntime.listAgents().filter((agent) => agent.role === "worker" && agent.status === "IDLE").length, 2);

    await approveQueuedReviews(host, projectId);
    assert.equal(host.schedulerStore.getTask("T1").status, "APPROVED");
    assert.equal(host.schedulerStore.getTask("T2").status, "APPROVED");

    let finalRun = host.schedulerStore.activeRuns().find((run) => run.taskId === "T3");
    if (!finalRun) {
      await host.schedulerEngine.tick({ reason: "phase15_fixture_dependency_unlocked" });
      finalRun = host.schedulerStore.activeRuns().find((run) => run.taskId === "T3");
    }
    assert.ok(finalRun, "dependent task must dispatch only after resumed reviews approve its prerequisites");

    await host.schedulerEngine.handleCompletion(workerDone(projectId, finalRun));
    await approveQueuedReviews(host, projectId);
    assert.equal(host.schedulerStore.getTask("T3").status, "APPROVED");
    assert.equal(host.schedulerStore.summary().status, "READY_FOR_INTEGRATION");

    await host.integrationEngine.tick({ reason: "phase15_fixture_integration" });
    const integrationRun = host.integrationStore.currentRun();
    assert.ok(integrationRun);
    assert.deepEqual(integrationRun.mergeTaskIds, ["T1", "T2", "T3"]);

    await host.integrationEngine.handleCompletion({
      event: {
        v: 1,
        event: "DONE",
        projectId,
        taskId: "integration",
        runId: integrationRun.runId,
        agentId: integrationRun.agentId,
        eventId: `${integrationRun.runId}-fixture-done`,
        sequence: 1,
        payload: {
          integration: {
            branch: integrationRun.branch,
            commit: INTEGRATION_HEAD,
            baseSha: BASE,
            targetBranch: "main",
            mergedTaskIds: integrationRun.mergeTaskIds,
            changedFiles: Object.values(TASK_FILES),
            checks: integrationRun.verificationCommands.map((command) => ({ command, status: "PASS", evidence: "deterministic fixture verification passed" })),
            summary: "synthetic desktop integration verified"
          }
        }
      }
    });

    assert.equal(host.integrationStore.summary().status, "INTEGRATION_VERIFIED");
    assert.equal(host.schedulerStore.summary().status, "INTEGRATION_VERIFIED");
    assert.equal(host.projectStore.getActiveProject().status, "INTEGRATION_VERIFIED");

    const dashboard = await host.query("dashboard");
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.dashboard.persistence.backend, "sqlite");
    assert.equal(dashboard.dashboard.integration.status, "INTEGRATION_VERIFIED");

    const exported = await host.execute("exportProjectBundle", {});
    assert.equal(exported.ok, true);
    assert.match(exported.filename, /\.bundle\.json$/);
    assert.equal(exported.serialized.includes("\"tabId\""), false);
    assert.equal(exported.serialized.includes("\"sessionId\""), false);
  } finally {
    await host?.close();
  }
});
