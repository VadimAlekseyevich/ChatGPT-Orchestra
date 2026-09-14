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

function resolveDesktopRuntimeMode(argv = process.argv, env = process.env) {
  const companion = companionRequested(argv, env);
  const managedBrowser = managedBrowserRequested(argv, env);
  if (companion && managedBrowser) throw new Error("desktop_runtime_mode_conflict");
  if (managedBrowser) return RUNTIME_MODES.MANAGED_BROWSER;
  if (companion) return RUNTIME_MODES.COMPANION;
  return RUNTIME_MODES.DESKTOP;
}

module.exports = {
  RUNTIME_MODES,
  companionRequested,
  managedBrowserRequested,
  resolveDesktopRuntimeMode
};
