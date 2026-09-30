"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveDesktopDataDirectory } = require("../apps/desktop/main/app-data.js");
const {
  loadJsonlRecords,
  loadPersistedProjectState,
  validateIssue70Trace,
  printValidationResult
} = require("./validate-issue70-runtime-trace.js");

function projectSummary(state) {
  const projects = state && state.projects && typeof state.projects === "object" ? state.projects : {};
  return {
    activeProjectId: state && state.activeProjectId || null,
    projects
  };
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const repositoryRoot = path.resolve(__dirname, "..");
  const dataRoot = resolveDesktopDataDirectory();
  const databaseFile = path.join(dataRoot, "state", "orchestra.sqlite");
  const logFile = path.join(dataRoot, "logs", "orchestra.jsonl");

  if (!fs.existsSync(databaseFile)) {
    throw new Error("No persisted Orchestra database exists at " + databaseFile + ". Run an existing project first; do not clear app data.");
  }

  const baselineState = loadPersistedProjectState(databaseFile);
  const baseline = projectSummary(baselineState);
  const projectIds = Object.keys(baseline.projects);
  if (!projectIds.length) {
    throw new Error("No persisted projects exist before acceptance. Issue #70 requires an existing persisted project.");
  }

  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();

  console.log("[Issue #70 acceptance] baseline captured before launch");
  console.log("data directory: " + dataRoot);
  console.log("active project before launch: " + (baseline.activeProjectId || "(none)"));
  console.log("persisted projects before launch: " + projectIds.length);
  console.log("acceptance window starts: " + startedIso);
  console.log("");
  console.log("Orchestra will start now.");
  console.log("Continue an EXISTING persisted project and let at least one Planning stage finish.");
  console.log("Do not clear app data and do not create a replacement project for this check.");
  console.log("After the planning stage finishes, close Orchestra. Validation will run automatically.");
  console.log("");

  const electronPath = require("electron");
  const child = spawn(electronPath, [repositoryRoot, "--managed-browser"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: false
  });

  const exit = await waitForExit(child);
  if (exit.signal) {
    throw new Error("Orchestra exited by signal: " + exit.signal);
  }
  if (exit.code !== 0) {
    throw new Error("Orchestra exited with code " + exit.code);
  }

  const records = loadJsonlRecords(logFile);
  const result = validateIssue70Trace(records, {
    afterMs: startedAt,
    persistedProjects: baseline.projects
  });
  printValidationResult(result);

  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[Issue #70 acceptance] ERROR: " + String(error && error.message || error));
  process.exitCode = 1;
});
