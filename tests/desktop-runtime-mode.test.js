const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RUNTIME_MODES,
  companionRequested,
  managedBrowserRequested,
  desktopShellRequested,
  resolveDesktopRuntimeMode
} = require("../apps/desktop/main/desktop-runtime-mode.js");

test("desktop runtime defaults to the managed-browser primary product path", () => {
  assert.equal(resolveDesktopRuntimeMode([], {}), RUNTIME_MODES.MANAGED_BROWSER);
});

test("legacy fake desktop shell is dev/test only and requires an explicit flag or environment", () => {
  assert.equal(desktopShellRequested(["--desktop-shell"], {}), true);
  assert.equal(desktopShellRequested([], { ORCHESTRA_DESKTOP_SHELL: "1" }), true);
  assert.equal(resolveDesktopRuntimeMode(["--desktop-shell"], {}), RUNTIME_MODES.DESKTOP);
});

test("companion mode remains explicitly selectable as fallback", () => {
  assert.equal(companionRequested(["--companion"], {}), true);
  assert.equal(companionRequested([], { ORCHESTRA_COMPANION: "1" }), true);
  assert.equal(resolveDesktopRuntimeMode(["--companion"], {}), RUNTIME_MODES.COMPANION);
});

test("managed browser mode remains explicitly selectable even though it is the default", () => {
  assert.equal(managedBrowserRequested(["--managed-browser"], {}), true);
  assert.equal(managedBrowserRequested([], { ORCHESTRA_MANAGED_BROWSER: "1" }), true);
  assert.equal(resolveDesktopRuntimeMode(["--managed-browser"], {}), RUNTIME_MODES.MANAGED_BROWSER);
});

test("desktop rejects every ambiguous multi-runtime selection", () => {
  assert.throws(() => resolveDesktopRuntimeMode(["--companion", "--managed-browser"], {}), /desktop_runtime_mode_conflict/);
  assert.throws(() => resolveDesktopRuntimeMode(["--desktop-shell", "--managed-browser"], {}), /desktop_runtime_mode_conflict/);
  assert.throws(() => resolveDesktopRuntimeMode(["--desktop-shell", "--companion"], {}), /desktop_runtime_mode_conflict/);
  assert.throws(() => resolveDesktopRuntimeMode([], { ORCHESTRA_COMPANION: "1", ORCHESTRA_MANAGED_BROWSER: "1" }), /desktop_runtime_mode_conflict/);
});
