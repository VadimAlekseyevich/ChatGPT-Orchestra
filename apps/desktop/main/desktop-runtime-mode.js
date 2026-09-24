"use strict";

const RUNTIME_MODES = Object.freeze({
  DESKTOP: "desktop",
  COMPANION: "companion",
  MANAGED_BROWSER: "managed-browser"
});

function companionRequested(argv = process.argv, env = process.env) {
  return (argv || []).includes("--companion") || env?.ORCHESTRA_COMPANION === "1";
}

function managedBrowserRequested(argv = process.argv, env = process.env) {
  return (argv || []).includes("--managed-browser") || env?.ORCHESTRA_MANAGED_BROWSER === "1";
}

function desktopShellRequested(argv = process.argv, env = process.env) {
  return (argv || []).includes("--desktop-shell") || env?.ORCHESTRA_DESKTOP_SHELL === "1";
}

function runtimeModeFlag(mode) {
  const normalized = String(mode || "");
  if (normalized === RUNTIME_MODES.COMPANION) return "--companion";
  if (normalized === RUNTIME_MODES.MANAGED_BROWSER) return "--managed-browser";
  if (normalized === RUNTIME_MODES.DESKTOP) return "--desktop-shell";
  throw new Error("desktop_runtime_mode_invalid");
}

function runtimeRelaunchArgs(argv = process.argv.slice(1), mode) {
  const stripped = (argv || []).filter((item) => !["--companion", "--managed-browser", "--desktop-shell"].includes(String(item || "")));
  return [...stripped, runtimeModeFlag(mode)];
}

function resolveDesktopRuntimeMode(argv = process.argv, env = process.env) {
  const companion = companionRequested(argv, env);
  const managedBrowser = managedBrowserRequested(argv, env);
  const desktopShell = desktopShellRequested(argv, env);
  const selected = [companion, managedBrowser, desktopShell].filter(Boolean).length;
  if (selected > 1) throw new Error("desktop_runtime_mode_conflict");
  if (companion) return RUNTIME_MODES.COMPANION;
  if (desktopShell) return RUNTIME_MODES.DESKTOP;
  return RUNTIME_MODES.MANAGED_BROWSER;
}

module.exports = {
  RUNTIME_MODES,
  companionRequested,
  managedBrowserRequested,
  desktopShellRequested,
  runtimeModeFlag,
  runtimeRelaunchArgs,
  resolveDesktopRuntimeMode
};