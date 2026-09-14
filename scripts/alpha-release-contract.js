"use strict";

const ALPHA_VERSION = "2.0.0-alpha.20";
const ALPHA_ARTIFACT_NAME = "chatgpt-orchestra-alpha20-windows";

const ALPHA_SCENARIOS = Object.freeze([
  { id: "A01", title: "Fresh install + ChatGPT login onboarding", evidence: ["tests/managed-browser-onboarding.test.js", "tests/managed-browser-readiness-policy.test.js"], manualRequired: true },
  { id: "A02", title: "Open local repository", evidence: ["tests/repository-api.test.js", "tests/project-repository-binding.test.js"], manualRequired: false },
  { id: "A03", title: "Clone repository", evidence: ["tests/git-cli-workspace.test.js", "tests/system-git-workspace.test.js"], manualRequired: false },
  { id: "A04", title: "4-task parallel happy path", evidence: ["tests/scheduler-engine.test.js"], manualRequired: false },
  { id: "A05", title: "Dependency path", evidence: ["tests/scheduler-engine.test.js"], manualRequired: false },
  { id: "A06", title: "Review rework", evidence: ["tests/review-engine.test.js", "tests/scheduler-engine.test.js"], manualRequired: false },
  { id: "A07", title: "Text conflict", evidence: ["tests/integration-engine.test.js", "tests/system-git-integration.test.js"], manualRequired: false },
  { id: "A08", title: "Semantic conflict", evidence: ["tests/integration-engine.test.js"], manualRequired: false },
  { id: "A09", title: "Task/browser death", evidence: ["tests/managed-browser-recovery-registry.test.js", "tests/local-worker-recovery.test.js"], manualRequired: false },
  { id: "A10", title: "App process kill/restart", evidence: ["tests/recovery-controller.test.js", "tests/local-integration-recovery.test.js"], manualRequired: false },
  { id: "A11", title: "OS restart / project resume", evidence: ["tests/recovery-controller.test.js", "tests/project-bundle.test.js", "tests/desktop-app-data.test.js", "tests/desktop-runtime-evidence.test.js"], manualRequired: true },
  { id: "A12", title: "Pause/Resume", evidence: ["tests/recovery-controller.test.js"], manualRequired: false },
  { id: "A13", title: "Stop Now + late event protection", evidence: ["tests/recovery-stop-guards.test.js", "tests/desktop-stop-hardening.test.js"], manualRequired: false },
  { id: "A14", title: "Local worktree salvage", evidence: ["tests/workspace-lifecycle-hardening.test.js"], manualRequired: false },
  { id: "A15", title: "Export/import project", evidence: ["tests/project-bundle.test.js", "tests/persistence-api.test.js", "tests/desktop-project-bundle-import.test.js"], manualRequired: false },
  { id: "A16", title: "Extension-companion fallback", evidence: ["tests/companion-project-migration.test.js", "tests/desktop-runtime-mode.test.js"], manualRequired: false },
  { id: "A17", title: "No duplicate irreversible side effects", evidence: ["tests/event-bus.test.js", "tests/system-git-integration.test.js", "tests/integration-recovery.test.js"], manualRequired: false }
]);

const MANUAL_SCENARIO_IDS = Object.freeze(ALPHA_SCENARIOS.filter((scenario) => scenario.manualRequired).map((scenario) => scenario.id));

module.exports = {
  ALPHA_VERSION,
  ALPHA_ARTIFACT_NAME,
  ALPHA_SCENARIOS,
  MANUAL_SCENARIO_IDS
};
