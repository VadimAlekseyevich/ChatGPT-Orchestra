const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const packageJson = require("../package.json");
const manifest = require("../manifest.json");
const { FALLBACK_EXTENSION_ID, extensionIdFromManifestKey } = require("../apps/desktop/main/companion-fallback.js");

const REQUIRED_CONTENT_FILES = [
  "content/message-types.js",
  "content/protocol-parser.js",
  "content/planning-artifact-parser.js",
  "content/worker-artifact-parser.js",
  "content/utils.js",
  "content/selectors.js"
];

const REQUIRED_DESKTOP_FILES = [
  "apps/desktop/agent-preload.js",
  "apps/desktop/main/electron-managed-browser-driver.js",
  "apps/desktop/main/electron-preload-chatgpt-page-adapter.js",
  "apps/desktop/main/managed-browser-protocol-adapter.js",
  "apps/desktop/main/managed-browser-completion-monitor.js",
  "apps/desktop/main/completion-aware-managed-browser-runtime.js",
  "apps/desktop/main/managed-browser-desktop-host.js"
];

function coveredByBuildFiles(file) {
  const patterns = packageJson.build?.files || [];
  if (patterns.includes(file)) return true;
  if (file.startsWith("apps/desktop/") && patterns.includes("apps/desktop/**/*")) return true;
  if (file.startsWith("content/") && patterns.includes("content/**/*")) return true;
  return false;
}

test("desktop package includes every direct-browser runtime dependency", () => {
  for (const file of [...REQUIRED_CONTENT_FILES, ...REQUIRED_DESKTOP_FILES]) {
    assert.equal(fs.existsSync(path.resolve(__dirname, "..", file)), true, `missing source dependency: ${file}`);
    assert.equal(coveredByBuildFiles(file), true, `desktop build excludes direct-browser dependency: ${file}`);
  }
});

test("every packaged direct-browser JavaScript entry parses before packaging", () => {
  for (const file of [...REQUIRED_CONTENT_FILES, ...REQUIRED_DESKTOP_FILES]) {
    const filename = path.resolve(__dirname, "..", file);
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ["--check", filename], { stdio: "pipe" }),
      `syntax check failed for packaged runtime file: ${file}`
    );
  }
});


test("Windows desktop candidate embeds the staged extension fallback outside app.asar with a stable id", () => {
  assert.equal(extensionIdFromManifestKey(manifest.key), FALLBACK_EXTENSION_ID);
  assert.ok((packageJson.build?.extraResources || []).some((entry) =>
    entry?.from === "dist/alpha-extension" && entry?.to === "alpha-extension"
  ));
  const buildScript = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "build-windows-alpha.js"), "utf8");
  assert.match(buildScript, /stageAlphaExtension\(\)/);
});
