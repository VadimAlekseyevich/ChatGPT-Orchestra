const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RUNTIME_MODES,
  companionRequested,
  managedBrowserRequested,
  resolveDesktopRuntimeMode
} = require("../apps/desktop/main/desktop-runtime-mode.js");

test("desktop runtime mode defaults to the existing desktop shell", () => {
  assert.equal(resolveDesktopRuntimeMode([], {}), RUNTIME_MODES.DESKTOP);
});

test("companion mode remains explicitly selectable by flag or environment", () => {
  assert.equal(companionRequested(["--companion"], {}), true);
  assert.equal(companionRequested([], { ORCHESTRA_COMPANION: "1" }), true);
  assert.equal(resolveDesktopRuntimeMode(["--companion"], {}), RUNTIME_MODES.COMPANION);
});

test("managed browser mode is opt-in by flag or environment", () => {
  assert.equal(managedBrowserRequested(["--managed-browser"], {}), true);
  assert.equal(managedBrowserRequested([], { ORCHESTRA_MANAGED_BROWSER: "1" }), true);
  assert.equal(resolveDesktopRuntimeMode(["--managed-browser"], {}), RUNTIME_MODES.MANAGED_BROWSER);
});

test("desktop rejects ambiguous companion plus managed-browser mode", () => {
  assert.throws(() => resolveDesktopRuntimeMode(["--companion", "--managed-browser"], {}), /desktop_runtime_mode_conflict/);
  assert.throws(() => resolveDesktopRuntimeMode([], { ORCHESTRA_COMPANION: "1", ORCHESTRA_MANAGED_BROWSER: "1" }), /desktop_runtime_mode_conflict/);
});
