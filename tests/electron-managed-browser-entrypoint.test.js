const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function source(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

test("Electron entrypoint selects the managed browser host only through explicit runtime mode", () => {
  const main = source("apps/desktop/main/electron-main.js");
  assert.match(main, /createManagedBrowserDesktopHost/);
  assert.match(main, /resolveDesktopRuntimeMode\(\)/);
  assert.match(main, /RUNTIME_MODES\.MANAGED_BROWSER/);
  assert.match(main, /await createManagedBrowserDesktopHost\(\{ dataDirectory \}\)/);
  assert.match(main, /createNativeCompanionDesktopHost/);
  assert.match(main, /createDesktopHost/);
});

test("package exposes an explicit managed-browser development command and packages all desktop runtime files", () => {
  const pkg = JSON.parse(source("package.json"));
  assert.equal(pkg.scripts["desktop:managed-browser"], "electron . --managed-browser");
  assert.ok(pkg.scripts["test:phase18"].includes("electron-managed-browser-entrypoint.test.js"));
  assert.ok(pkg.build.files.includes("apps/desktop/**/*"));
});
