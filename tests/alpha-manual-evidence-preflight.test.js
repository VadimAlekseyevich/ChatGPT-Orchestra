"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scanPrivacy,
  prepareA01Evidence,
  prepareA11Evidence,
  parseArgs
} = require("../scripts/prepare-alpha-manual-evidence.js");

const COMMIT = "a".repeat(40);

function debugBundle({
  commit = COMMIT,
  boot = "2026-09-15T08:00:00.000Z",
  projectId = "proj-alpha",
  projectStatus = "RUNNING",
  projectStage = "EXECUTION",
  leadReady = true,
  extra = null
} = {}) {
  const bundle = {
    format: "chatgpt-orchestra-debug-bundle",
    version: 1,
    generatedAt: Date.parse("2026-09-15T10:00:00.000Z"),
    dashboard: {
      persistence: {
        backend: "sqlite",
        runtimeEvidence: {
          schemaVersion: 2,
          platform: "win32",
          arch: "x64",
          osRelease: "10.0.26100",
          systemBootTimeUtc: boot,
          buildVersion: "2.0.0-alpha.20",
          buildCommit: commit
        }
      },
      project: {
        projectId,
        status: projectStatus,
        stage: projectStage,
        repository: {
          url: "https://github.com/acme/widget",
          fullName: "acme/widget"
        }
      },
      agents: leadReady
        ? [{ agentId: "lead-1", role: "lead", connected: true, status: "IDLE" }]
        : [{ agentId: "lead-1", role: "lead", connected: false, status: "OFFLINE" }],
      tasks: [
        { taskId: "T1", status: "APPROVED" },
        { taskId: "T2", status: "RUNNING" }
      ],
      activeRuns: [{ runId: "R2", taskId: "T2", status: "RUNNING" }]
    }
  };
  if (extra && typeof extra === "object") Object.assign(bundle.dashboard, extra);
  return bundle;
}

test("A01 preflight generates validator-compatible evidence only after explicit human confirmations", () => {
  const result = prepareA01Evidence({
    debugBundle: debugBundle(),
    tester: "Vadim alpha tester",
    freshProfile: "Disposable Windows VM with no prior Orchestra app-data",
    timestampUtc: "2026-09-15T10:15:00Z",
    confirmInstallLaunch: true,
    confirmInteractiveLogin: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime.buildCommit, COMMIT);
  assert.deepEqual(result.privacyFindings, []);
  assert.match(result.body, /^Scenario: A01/m);
  assert.match(result.body, /^Result: PASS/m);
  assert.match(result.body, new RegExp(`^Build commit: ${COMMIT}$`, "m"));
  assert.match(result.body, /^Install\/launch: PASS$/m);
  assert.match(result.body, /^ChatGPT interactive login: PASS$/m);
  assert.match(result.body, /^Lead registration\/readiness: PASS$/m);
  assert.match(result.body, /^Export privacy check: PASS/m);
  assert.match(result.body, /^Timestamp UTC: 2026-09-15T10:15:00\.000Z$/m);
});

test("A01 preflight fails closed on missing confirmation, unavailable Lead or sensitive debug fields", () => {
  assert.throws(() => prepareA01Evidence({
    debugBundle: debugBundle(),
    tester: "Tester",
    freshProfile: "Clean disposable Windows user",
    confirmInstallLaunch: false,
    confirmInteractiveLogin: true
  }), /a01_install_launch_confirmation_required/);

  assert.throws(() => prepareA01Evidence({
    debugBundle: debugBundle({ leadReady: false }),
    tester: "Tester",
    freshProfile: "Clean disposable Windows user",
    confirmInstallLaunch: true,
    confirmInteractiveLogin: true
  }), /a01_lead_not_ready/);

  const leaked = debugBundle({ extra: { accidental: { cookies: "secret" } } });
  const findings = scanPrivacy(leaked);
  assert.ok(findings.some((item) => item.path.endsWith(".cookies")));
  assert.throws(() => prepareA01Evidence({
    debugBundle: leaked,
    tester: "Tester",
    freshProfile: "Clean disposable Windows user",
    confirmInstallLaunch: true,
    confirmInteractiveLogin: true
  }), /a01_privacy_check_failed/);

  const runtimeLeak = debugBundle({ extra: { accidental: { sessionId: "browser-session-1" } } });
  assert.throws(() => prepareA01Evidence({
    debugBundle: runtimeLeak,
    tester: "Tester",
    freshProfile: "Clean disposable Windows user",
    confirmInstallLaunch: true,
    confirmInteractiveLogin: true
  }), /a01_privacy_check_failed/);
});

test("A11 preflight binds one project and build across a later real boot", () => {
  const before = debugBundle({ boot: "2026-09-15T08:00:00Z", projectStatus: "RUNNING" });
  const after = debugBundle({ boot: "2026-09-15T10:30:00Z", projectStatus: "RUNNING", projectStage: "EXECUTION" });

  const result = prepareA11Evidence({
    beforeBundle: before,
    afterBundle: after,
    tester: "Vadim alpha tester",
    projectReference: "acme/widget alpha recovery run",
    timestampUtc: "2026-09-15T11:00:00Z",
    confirmRealReboot: true,
    confirmResume: true,
    confirmNoDuplicates: true,
    confirmWorktreePreservation: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.beforeRuntime.buildCommit, COMMIT);
  assert.equal(result.afterRuntime.buildCommit, COMMIT);
  assert.equal(result.beforeProject.projectId, "proj-alpha");
  assert.equal(result.afterProject.projectId, "proj-alpha");
  assert.match(result.body, /^Scenario: A11/m);
  assert.match(result.body, /^Real OS restart performed: PASS$/m);
  assert.match(result.body, /^Resume result: PASS$/m);
  assert.match(result.body, /^Duplicate irreversible side effects check: PASS$/m);
  assert.match(result.body, /^Worktree\/state preservation: PASS$/m);
  assert.match(result.body, /^Pre-restart systemBootTimeUtc: 2026-09-15T08:00:00\.000Z$/m);
  assert.match(result.body, /^Post-restart systemBootTimeUtc: 2026-09-15T10:30:00\.000Z$/m);
});

test("A11 preflight rejects same-boot relaunch, build drift, project drift and missing human assertions", () => {
  const before = debugBundle({ boot: "2026-09-15T08:00:00Z" });

  assert.throws(() => prepareA11Evidence({
    beforeBundle: before,
    afterBundle: debugBundle({ boot: "2026-09-15T08:00:00Z" }),
    tester: "Tester",
    confirmRealReboot: true,
    confirmResume: true,
    confirmNoDuplicates: true,
    confirmWorktreePreservation: true
  }), /a11_boot_time_not_advanced/);

  assert.throws(() => prepareA11Evidence({
    beforeBundle: before,
    afterBundle: debugBundle({ commit: "b".repeat(40), boot: "2026-09-15T10:00:00Z" }),
    tester: "Tester",
    confirmRealReboot: true,
    confirmResume: true,
    confirmNoDuplicates: true,
    confirmWorktreePreservation: true
  }), /a11_build_commit_changed/);

  assert.throws(() => prepareA11Evidence({
    beforeBundle: before,
    afterBundle: debugBundle({ boot: "2026-09-15T10:00:00Z", projectId: "proj-other" }),
    tester: "Tester",
    confirmRealReboot: true,
    confirmResume: true,
    confirmNoDuplicates: true,
    confirmWorktreePreservation: true
  }), /a11_project_identity_changed/);

  assert.throws(() => prepareA11Evidence({
    beforeBundle: before,
    afterBundle: debugBundle({ boot: "2026-09-15T10:00:00Z" }),
    tester: "Tester",
    confirmRealReboot: true,
    confirmResume: true,
    confirmNoDuplicates: false,
    confirmWorktreePreservation: true
  }), /a11_no_duplicates_confirmation_required/);
});

test("CLI argument parser keeps confirmations boolean and values explicit", () => {
  const parsed = parseArgs([
    "A01",
    "--debug", "debug.json",
    "--tester", "Tester",
    "--fresh-profile", "Clean Windows VM",
    "--confirm-install-launch",
    "--confirm-interactive-login",
    "--out", "a01.txt"
  ]);

  assert.deepEqual(parsed.positionals, ["A01"]);
  assert.equal(parsed.options.debug, "debug.json");
  assert.equal(parsed.options.tester, "Tester");
  assert.equal(parsed.options["confirm-install-launch"], true);
  assert.equal(parsed.options["confirm-interactive-login"], true);
  assert.equal(parsed.options.out, "a01.txt");
});
