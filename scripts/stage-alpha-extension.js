"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "dist", "alpha-extension");
const FILES = [
  "manifest.json",
  "icon.png",
  "popup.html",
  "popup.js",
  "popup.css",
  "popup-companion.js",
  "content.js"
];
const DIRECTORIES = [
  "background",
  "content",
  "context",
  "dashboard",
  "persistence",
  "platform",
  "prompts",
  "protocol"
];

function copyEntry(relative) {
  const source = path.join(ROOT, relative);
  const target = path.join(OUTPUT, relative);
  assert.ok(fs.existsSync(source), `alpha_extension_source_missing:${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

function assertStagedManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUTPUT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.version_name, pkg.version, "alpha_extension_version_mismatch");
  assert.ok(fs.existsSync(path.join(OUTPUT, manifest.background.service_worker)), "alpha_extension_service_worker_missing");
  assert.ok(fs.existsSync(path.join(OUTPUT, manifest.action.default_popup)), "alpha_extension_popup_missing");
  for (const entry of manifest.content_scripts || []) {
    for (const script of entry.js || []) {
      assert.ok(fs.existsSync(path.join(OUTPUT, script)), `alpha_extension_content_script_missing:${script}`);
    }
  }
}

function main() {
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  for (const file of FILES) copyEntry(file);
  for (const directory of DIRECTORIES) copyEntry(directory);
  assertStagedManifest();
  console.log(`alpha extension staged: ${OUTPUT}`);
}

if (require.main === module) main();

module.exports = { main, ROOT, OUTPUT, FILES, DIRECTORIES };
