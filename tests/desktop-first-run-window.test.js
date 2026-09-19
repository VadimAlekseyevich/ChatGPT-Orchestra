"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { revealDesktopMainWindow } = require("../apps/desktop/main/desktop-window-policy.js");

function fakeWindow() {
  const calls = [];
  return {
    calls,
    showInactive() { calls.push("showInactive"); },
    show() { calls.push("show"); },
    focus() { calls.push("focus"); },
    isDestroyed() { return false; }
  };
}

test("managed-browser startup reveals Dashboard without stealing ChatGPT login focus", () => {
  const window = fakeWindow();
  const result = revealDesktopMainWindow(window, { preserveExistingFocus: true });
  assert.deepEqual(result, { shown: true, mode: "inactive" });
  assert.deepEqual(window.calls, ["showInactive"]);
});

test("non-managed desktop modes reveal and focus the main window normally", () => {
  const window = fakeWindow();
  const result = revealDesktopMainWindow(window, { preserveExistingFocus: false });
  assert.deepEqual(result, { shown: true, mode: "active" });
  assert.deepEqual(window.calls, ["show", "focus"]);
});

test("Electron main creates Dashboard hidden and applies managed-browser reveal policy after load", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "main", "electron-main.js"), "utf8");
  assert.match(source, /show:\s*false/);
  assert.match(source, /revealDesktopMainWindow\(mainWindow/);
  assert.match(source, /preserveExistingFocus:\s*runtimeMode === RUNTIME_MODES\.MANAGED_BROWSER/);
});
