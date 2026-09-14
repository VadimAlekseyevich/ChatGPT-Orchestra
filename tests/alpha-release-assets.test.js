"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ALPHA_VERSION,
  ALPHA_TAG,
  prepareReleaseAssets,
  verifyReleaseEvidence
} = require("../scripts/prepare-alpha-release-assets.js");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function evidenceFixtures(commit = COMMIT) {
  return {
    build: { schemaVersion: 1, version: ALPHA_VERSION, commit },
    signature: {
      schemaVersion: 2,
      version: ALPHA_VERSION,
      buildCommit: commit,
      requireSignature: true,
      signatures: [
        { file: "ChatGPT Orchestra.exe", status: "Valid", signerSubject: "CN=Example Release Signer" },
        { file: `ChatGPT Orchestra Setup ${ALPHA_VERSION}.exe`, status: "Valid", signerSubject: "CN=Example Release Signer" }
      ]
    },
    manual: {
      schemaVersion: 4,
      version: ALPHA_VERSION,
      commit,
      a01: "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-1",
      a11: "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-2",
      validation: {
        schemaVersion: 2,
        alphaVersion: ALPHA_VERSION,
        expectedCommit: commit,
        scenarios: [
          { scenarioId: "A01", reference: "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-1", bodySha256: "a".repeat(64), evidence: { buildCommit: commit } },
          { scenarioId: "A11", reference: "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-2", bodySha256: "b".repeat(64), evidence: { buildCommit: commit } }
        ]
      }
    }
  };
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("release evidence requires one exact commit, strict valid signatures and both manual scenarios", () => {
  const fixture = evidenceFixtures();
  const result = verifyReleaseEvidence({ ...fixture, expectedCommit: COMMIT });
  assert.equal(result.commit, COMMIT);
  assert.deepEqual(result.scenarios.map((item) => item.scenarioId), ["A01", "A11"]);

  assert.throws(() => verifyReleaseEvidence({ ...fixture, expectedCommit: "f".repeat(40) }), /build_commit_mismatch/);

  const unsigned = structuredClone(fixture);
  unsigned.signature.signatures[0].status = "NotSigned";
  assert.throws(() => verifyReleaseEvidence({ ...unsigned, expectedCommit: COMMIT }), /signature_not_valid/);

  const missingManual = structuredClone(fixture);
  missingManual.manual.validation.scenarios.pop();
  assert.throws(() => verifyReleaseEvidence({ ...missingManual, expectedCommit: COMMIT }), /manual_scenarios_incomplete/);
});

test("final prerelease preparation emits manifest, checksums and release notes from validated evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-alpha-release-"));
  const desktopDir = path.join(dir, "desktop");
  fs.mkdirSync(desktopDir, { recursive: true });
  const fixture = evidenceFixtures();
  writeJson(path.join(desktopDir, "alpha-build-evidence.json"), fixture.build);
  writeJson(path.join(desktopDir, "alpha-signature-evidence.json"), fixture.signature);
  writeJson(path.join(desktopDir, "alpha-manual-evidence.json"), fixture.manual);
  const installer = path.join(desktopDir, `ChatGPT Orchestra Setup ${ALPHA_VERSION}.exe`);
  const extensionZip = path.join(desktopDir, "chatgpt-orchestra-alpha20-extension.zip");
  fs.writeFileSync(installer, "signed-installer-fixture", "utf8");
  fs.writeFileSync(extensionZip, "extension-zip-fixture", "utf8");

  try {
    const result = prepareReleaseAssets({ desktopDir, extensionZip, expectedCommit: COMMIT, outputDir: desktopDir });
    assert.equal(result.manifest.version, ALPHA_VERSION);
    assert.equal(result.manifest.tag, ALPHA_TAG);
    assert.equal(result.manifest.commit, COMMIT);
    assert.equal(result.manifest.installer, path.basename(installer));
    assert.deepEqual(result.manifest.signerSubjects, ["CN=Example Release Signer"]);
    assert.deepEqual(result.manifest.manualEvidence.map((item) => item.scenarioId), ["A01", "A11"]);

    const checksums = fs.readFileSync(result.checksumsPath, "utf8");
    for (const name of [
      path.basename(installer),
      path.basename(extensionZip),
      "alpha-build-evidence.json",
      "alpha-signature-evidence.json",
      "alpha-manual-evidence.json",
      "alpha-release-manifest.json"
    ]) assert.match(checksums, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const notes = fs.readFileSync(result.notesPath, "utf8");
    assert.match(notes, /Desktop-first alpha for Windows/);
    assert.match(notes, new RegExp(COMMIT));
    assert.match(notes, /Authenticode=Valid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("release asset preparation refuses ambiguous installers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-alpha-release-"));
  fs.mkdirSync(dir, { recursive: true });
  const fixture = evidenceFixtures();
  writeJson(path.join(dir, "alpha-build-evidence.json"), fixture.build);
  writeJson(path.join(dir, "alpha-signature-evidence.json"), fixture.signature);
  writeJson(path.join(dir, "alpha-manual-evidence.json"), fixture.manual);
  const extensionZip = path.join(dir, "chatgpt-orchestra-alpha20-extension.zip");
  fs.writeFileSync(extensionZip, "zip", "utf8");
  fs.writeFileSync(path.join(dir, `ChatGPT Orchestra Setup ${ALPHA_VERSION}.exe`), "one", "utf8");
  fs.writeFileSync(path.join(dir, "ChatGPT Orchestra Setup duplicate.exe"), "two", "utf8");

  try {
    assert.throws(() => prepareReleaseAssets({ desktopDir: dir, extensionZip, expectedCommit: COMMIT, outputDir: dir }), /installer_count_invalid:2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
