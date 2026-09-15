"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { ALPHA_VERSION } = require("./alpha-release-contract.js");

const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const PLACEHOLDER_PATTERN = /(?:<[^>]+>|\b(?:todo|pending|tbd|replace me|unknown)\b)/i;
const FORBIDDEN_KEYS = new Set([
  "password",
  "passphrase",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "browserprofilepath",
  "profilepath",
  "userdatadir",
  "storagestate",
  "sessionid",
  "tabid",
  "legacytabid",
  "runtimesource"
]);
const FORBIDDEN_VALUE_PATTERNS = [
  /(?:^|[\\/])(?:browser[-_ ]?profile|user data)(?:[\\/]|$)/i,
  /(?:^|[\\/])Cookies(?:$|[\\/])/i
];

function fail(reason, details = null) {
  const error = new Error(String(reason));
  error.code = String(reason);
  if (details !== null) error.details = details;
  throw error;
}

function requiredText(value, name, min = 2) {
  const text = String(value || "").trim();
  if (text.length < min) fail(`${name}_required`);
  if (PLACEHOLDER_PATTERN.test(text)) fail(`${name}_placeholder`);
  return text;
}

function isoUtc(value = new Date().toISOString()) {
  const text = String(value || "").trim();
  const time = Date.parse(text);
  if (!Number.isFinite(time) || !/Z$/i.test(text)) fail("timestamp_utc_invalid");
  return new Date(time).toISOString();
}

function normalizeBundle(input) {
  const candidate = input?.payload && input.payload.dashboard ? input.payload : input;
  if (!candidate || candidate.format !== "chatgpt-orchestra-debug-bundle" || Number(candidate.version) !== 1 || !candidate.dashboard) {
    fail("debug_bundle_invalid");
  }
  return candidate;
}

function loadDebugBundle(filename) {
  const absolute = path.resolve(String(filename || ""));
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    fail("debug_bundle_read_failed", { filename: absolute, message: error?.message || String(error) });
  }
  return normalizeBundle(parsed);
}

function runtimeEvidence(bundle) {
  const debug = normalizeBundle(bundle);
  const evidence = debug.dashboard?.persistence?.runtimeEvidence;
  if (!evidence || typeof evidence !== "object") fail("runtime_evidence_missing");
  const buildVersion = String(evidence.buildVersion || "").trim();
  const buildCommit = String(evidence.buildCommit || "").trim().toLowerCase();
  const platform = String(evidence.platform || "").trim();
  const arch = String(evidence.arch || "").trim();
  const osRelease = String(evidence.osRelease || "").trim();
  const systemBootTimeUtc = isoUtc(evidence.systemBootTimeUtc);

  if (buildVersion !== ALPHA_VERSION) fail("alpha_version_mismatch", { expected: ALPHA_VERSION, actual: buildVersion });
  if (!COMMIT_PATTERN.test(buildCommit)) fail("build_commit_invalid");
  if (platform !== "win32") fail("manual_alpha_requires_windows", { platform });
  if (!arch) fail("runtime_arch_missing");
  if (!osRelease) fail("runtime_os_release_missing");

  return { buildVersion, buildCommit, platform, arch, osRelease, systemBootTimeUtc };
}

function scanPrivacy(value) {
  const findings = [];
  const seen = new WeakSet();

  function walk(item, pointer) {
    if (item === null || item === undefined) return;
    if (typeof item === "string") {
      for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(item)) findings.push({ path: pointer || "$", reason: "forbidden_path_value" });
      }
      return;
    }
    if (typeof item !== "object") return;
    if (seen.has(item)) return;
    seen.add(item);

    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, `${pointer}[${index}]`));
      return;
    }

    for (const [key, child] of Object.entries(item)) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const next = pointer ? `${pointer}.${key}` : key;
      if (FORBIDDEN_KEYS.has(normalizedKey)) findings.push({ path: next, reason: "forbidden_key" });
      walk(child, next);
    }
  }

  walk(normalizeBundle(value), "$");
  return findings;
}

function readyLead(bundle) {
  const agents = normalizeBundle(bundle).dashboard?.agents;
  return Array.isArray(agents) && agents.some((agent) =>
    String(agent?.role || "").toLowerCase() === "lead" &&
    agent?.connected === true &&
    String(agent?.status || "").toUpperCase() === "IDLE"
  );
}

function projectSummary(bundle) {
  const dashboard = normalizeBundle(bundle).dashboard || {};
  const project = dashboard.project || null;
  const tasks = Array.isArray(dashboard.tasks) ? dashboard.tasks : [];
  const activeRuns = Array.isArray(dashboard.activeRuns) ? dashboard.activeRuns : [];
  const taskText = tasks.slice(0, 20).map((task) => `${task.taskId || "task"}:${task.status || "UNKNOWN"}`).join(", ") || "none";
  const runText = activeRuns.slice(0, 20).map((run) => `${run.runId || "run"}:${run.status || "UNKNOWN"}`).join(", ") || "none";
  return {
    projectId: project?.projectId ? String(project.projectId) : null,
    repository: project?.repository?.fullName || project?.repository?.url || null,
    text: `project=${project?.projectId || "none"}; status=${project?.status || "none"}; stage=${project?.stage || "none"}; tasks=[${taskText}]; activeRuns=[${runText}]`
  };
}

function assertManualConfirmation(value, name) {
  if (value !== true) fail(`${name}_confirmation_required`);
}

function prepareA01Evidence({
  debugBundle,
  tester,
  freshProfile,
  timestampUtc,
  confirmInstallLaunch = false,
  confirmInteractiveLogin = false
} = {}) {
  const bundle = normalizeBundle(debugBundle);
  const runtime = runtimeEvidence(bundle);
  const privacyFindings = scanPrivacy(bundle);
  if (privacyFindings.length) fail("a01_privacy_check_failed", privacyFindings);
  if (!readyLead(bundle)) fail("a01_lead_not_ready");
  assertManualConfirmation(confirmInstallLaunch, "a01_install_launch");
  assertManualConfirmation(confirmInteractiveLogin, "a01_interactive_login");

  const testerText = requiredText(tester, "tester");
  const freshProfileText = requiredText(freshProfile, "fresh_profile", 10);
  const timestamp = isoUtc(timestampUtc || new Date().toISOString());
  const windowsVersion = `${runtime.osRelease} (${runtime.arch})`;

  const body = [
    "Scenario: A01",
    "Result: PASS",
    `Alpha version: ${runtime.buildVersion}`,
    `Build commit: ${runtime.buildCommit}`,
    `Windows version: ${windowsVersion}`,
    `Fresh profile: ${freshProfileText}`,
    "Install/launch: PASS",
    "ChatGPT interactive login: PASS",
    "Lead registration/readiness: PASS",
    "Export privacy check: PASS — no credentials/cookies/browser-profile paths/runtime identifiers",
    `Tester: ${testerText}`,
    `Timestamp UTC: ${timestamp}`,
    "Notes/evidence attachments: generated by scripts/prepare-alpha-manual-evidence.js from a validated debug export; human fresh-profile/install/login confirmations were explicitly supplied"
  ].join("\n");

  return { ok: true, scenario: "A01", runtime, privacyFindings, body };
}

function prepareA11Evidence({
  beforeBundle,
  afterBundle,
  tester,
  projectReference = null,
  timestampUtc,
  confirmRealReboot = false,
  confirmResume = false,
  confirmNoDuplicates = false,
  confirmWorktreePreservation = false
} = {}) {
  const before = normalizeBundle(beforeBundle);
  const after = normalizeBundle(afterBundle);
  const beforeRuntime = runtimeEvidence(before);
  const afterRuntime = runtimeEvidence(after);

  if (beforeRuntime.buildCommit !== afterRuntime.buildCommit) {
    fail("a11_build_commit_changed", { before: beforeRuntime.buildCommit, after: afterRuntime.buildCommit });
  }
  if (beforeRuntime.buildVersion !== afterRuntime.buildVersion) fail("a11_build_version_changed");

  const beforeBoot = Date.parse(beforeRuntime.systemBootTimeUtc);
  const afterBoot = Date.parse(afterRuntime.systemBootTimeUtc);
  if (!(afterBoot > beforeBoot)) {
    fail("a11_boot_time_not_advanced", { before: beforeRuntime.systemBootTimeUtc, after: afterRuntime.systemBootTimeUtc });
  }

  const beforeProject = projectSummary(before);
  const afterProject = projectSummary(after);
  if (!beforeProject.projectId || !afterProject.projectId) fail("a11_project_missing");
  if (beforeProject.projectId !== afterProject.projectId) {
    fail("a11_project_identity_changed", { before: beforeProject.projectId, after: afterProject.projectId });
  }

  assertManualConfirmation(confirmRealReboot, "a11_real_reboot");
  assertManualConfirmation(confirmResume, "a11_resume");
  assertManualConfirmation(confirmNoDuplicates, "a11_no_duplicates");
  assertManualConfirmation(confirmWorktreePreservation, "a11_worktree_preservation");

  const testerText = requiredText(tester, "tester");
  const projectRef = requiredText(projectReference || beforeProject.repository || beforeProject.projectId, "project_reference");
  const timestamp = isoUtc(timestampUtc || new Date().toISOString());

  const body = [
    "Scenario: A11",
    "Result: PASS",
    `Alpha version: ${beforeRuntime.buildVersion}`,
    `Build commit: ${beforeRuntime.buildCommit}`,
    `Project/repository reference: ${projectRef}`,
    `State before OS restart: ${beforeProject.text}`,
    `Pre-restart systemBootTimeUtc: ${beforeRuntime.systemBootTimeUtc}`,
    "Real OS restart performed: PASS",
    `Post-restart systemBootTimeUtc: ${afterRuntime.systemBootTimeUtc}`,
    `State after relaunch/reconciliation: ${afterProject.text}`,
    "Resume result: PASS",
    "Duplicate irreversible side effects check: PASS",
    "Worktree/state preservation: PASS",
    `Tester: ${testerText}`,
    `Timestamp UTC: ${timestamp}`,
    "Notes/evidence attachments: generated by scripts/prepare-alpha-manual-evidence.js from pre/post debug exports; human reboot/resume/no-duplicate/worktree confirmations were explicitly supplied"
  ].join("\n");

  return { ok: true, scenario: "A11", beforeRuntime, afterRuntime, beforeProject, afterProject, body };
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key.startsWith("confirm-")) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`cli_option_value_required:${key}`);
    options[key] = value;
    index += 1;
  }
  return { positionals, options };
}

function writeResult(result, output) {
  if (output) {
    const filename = path.resolve(output);
    fs.writeFileSync(filename, `${result.body}\n`, "utf8");
    process.stdout.write(`manual alpha evidence prepared: ${filename}\n`);
    return;
  }
  process.stdout.write(`${result.body}\n`);
}

function cli(argv = process.argv.slice(2)) {
  const { positionals, options } = parseArgs(argv);
  const scenario = String(positionals[0] || "").toUpperCase();
  if (scenario === "A01") {
    if (!options.debug) fail("a01_debug_file_required");
    const result = prepareA01Evidence({
      debugBundle: loadDebugBundle(options.debug),
      tester: options.tester,
      freshProfile: options["fresh-profile"],
      timestampUtc: options.timestamp,
      confirmInstallLaunch: options["confirm-install-launch"] === true,
      confirmInteractiveLogin: options["confirm-interactive-login"] === true
    });
    writeResult(result, options.out);
    return result;
  }
  if (scenario === "A11") {
    if (!options.before) fail("a11_before_file_required");
    if (!options.after) fail("a11_after_file_required");
    const result = prepareA11Evidence({
      beforeBundle: loadDebugBundle(options.before),
      afterBundle: loadDebugBundle(options.after),
      tester: options.tester,
      projectReference: options["project-ref"],
      timestampUtc: options.timestamp,
      confirmRealReboot: options["confirm-real-reboot"] === true,
      confirmResume: options["confirm-resume"] === true,
      confirmNoDuplicates: options["confirm-no-duplicates"] === true,
      confirmWorktreePreservation: options["confirm-worktree-preservation"] === true
    });
    writeResult(result, options.out);
    return result;
  }
  fail("usage: A01 or A11 scenario required");
}

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`manual alpha evidence preflight failed: ${error?.code || error?.message || error}\n`);
    if (error?.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  COMMIT_PATTERN,
  FORBIDDEN_KEYS,
  normalizeBundle,
  loadDebugBundle,
  runtimeEvidence,
  scanPrivacy,
  readyLead,
  projectSummary,
  prepareA01Evidence,
  prepareA11Evidence,
  parseArgs,
  cli
};
