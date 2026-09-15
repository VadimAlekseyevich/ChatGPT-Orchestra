"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  prepareA01Evidence,
  prepareA11Evidence
} = require("../scripts/prepare-alpha-manual-evidence.js");
const {
  validateEvidenceCommentBody
} = require("../scripts/validate-alpha-evidence-comments.js");

const COMMIT = "c".repeat(40);

function bundle({ boot, status = "RUNNING" } = {}) {
  return {
    format: "chatgpt-orchestra-debug-bundle",
    version: 1,
    generatedAt: Date.parse("2026-09-15T12:00:00Z"),
    dashboard: {
      persistence: {
        runtimeEvidence: {
          schemaVersion: 2,
          platform: "win32",
          arch: "x64",
          osRelease: "10.0.26100",
          systemBootTimeUtc: boot || "2026-09-15T08:00:00Z",
          buildVersion: "2.0.0-alpha.20",
          buildCommit: COMMIT
        }
      },
      project: {
        projectId: "proj-release",
        status,
        stage: status === "RUNNING" ? "EXECUTION" : status,
        repository: { fullName: "acme/widget", url: "https://github.com/acme/widget" }
      },
      agents: [{ agentId: "lead", role: "lead", connected: true, status: "IDLE" }],
      tasks: [{ taskId: "T1", status: "APPROVED" }],
      activeRuns: []
    }
  };
}

test("generated A01 evidence is accepted unchanged by the final comment validator", () => {
  const prepared = prepareA01Evidence({
    debugBundle: bundle(),
    tester: "Release tester",
    freshProfile: "Disposable clean Windows VM with empty Orchestra app-data",
    timestampUtc: "2026-09-15T12:15:00Z",
    confirmInstallLaunch: true,
    confirmInteractiveLogin: true
  });

  const validated = validateEvidenceCommentBody("A01", prepared.body, { expectedCommit: COMMIT });
  assert.deepEqual(validated, {
    ok: true,
    scenarioId: "A01",
    tester: "Release tester",
    timestampUtc: "2026-09-15T12:15:00.000Z",
    buildCommit: COMMIT
  });
});

test("generated A11 evidence is accepted unchanged by the final comment validator", () => {
  const prepared = prepareA11Evidence({
    beforeBundle: bundle({ boot: "2026-09-15T08:00:00Z" }),
    afterBundle: bundle({ boot: "2026-09-15T11:30:00Z" }),
    tester: "Release tester",
    projectReference: "acme/widget release recovery run",
    timestampUtc: "2026-09-15T12:20:00Z",
    confirmRealReboot: true,
    confirmResume: true,
    confirmNoDuplicates: true,
    confirmWorktreePreservation: true
  });

  const validated = validateEvidenceCommentBody("A11", prepared.body, { expectedCommit: COMMIT });
  assert.deepEqual(validated, {
    ok: true,
    scenarioId: "A11",
    tester: "Release tester",
    timestampUtc: "2026-09-15T12:20:00.000Z",
    buildCommit: COMMIT,
    preRestartSystemBootTimeUtc: "2026-09-15T08:00:00.000Z",
    postRestartSystemBootTimeUtc: "2026-09-15T11:30:00.000Z"
  });
});
