"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ALPHA_VERSION, prepareReleaseAssets } = require("../scripts/prepare-alpha-release-assets.js");
const { parseChecksums, verifyReleaseBundle } = require("../scripts/verify-alpha-release-bundle.js");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function evidenceFixtures() {
  return {
    build: { schemaVersion: 1, version: ALPHA_VERSION, commit: COMMIT },
    signature: {
      schemaVersion: 2,
      version: ALPHA_VERSION,
      buildCommit: COMMIT,
      requireSignature: true,
      signatures: [
        { file: "ChatGPT Orchestra.exe", status: "Valid", signerSubject: "CN=Example Release Signer" },
        { file: `ChatGPT Orchestra Setup ${ALPHA_VERSION}.exe`, status: "Valid", signerSubject: "CN=Example Release Signer" }
      ]
    },
    manual: {
      schemaVersion: 4,
      version: ALPHA_VERSION,
      commit: COMMIT,
      validation: {
        schemaVersion: 2,
        alphaVersion: ALPHA_VERSION,
        expectedCommit: COMMIT,
        scenarios: [
          {
            scenarioId: "A01",
            reference: "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-1",
            bodySha256: "a".repeat(64),
            evidence: { buildCommit: COMMIT }
          },
          {
            scenarioId: "A11",
            reference: "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-2",
            bodySha256: "b".repeat(64),
            evidence: { buildCommit: COMMIT }
          }
        ]
      }
    }
  };
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-alpha-bundle-"));
  const desktopDir = path.join(root, "desktop");
  fs.mkdirSync(desktopDir, { recursive: true });
  const fixture = evidenceFixtures();
  writeJson(path.join(desktopDir, "alpha-build-evidence.json"), fixture.build);
  writeJson(path.join(desktopDir, "alpha-signature-evidence.json"), fixture.signature);
  writeJson(path.join(desktopDir, "alpha-manual-evidence.json"), fixture.manual);
  fs.writeFileSync(path.join(desktopDir, `ChatGPT Orchestra Setup ${ALPHA_VERSION}.exe`), "signed-installer-fixture", "utf8");
  const extensionZip = path.join(desktopDir, "chatgpt-orchestra-alpha20-extension.zip");
  fs.writeFileSync(extensionZip, "extension-zip-fixture", "utf8");
  prepareReleaseAssets({ desktopDir, extensionZip, expectedCommit: COMMIT, outputDir: desktopDir });
  return { root, desktopDir };
}

test("downloaded alpha bundle is revalidated before publication", () => {
  const bundle = createBundle();
  try {
    const result = verifyReleaseBundle({ desktopDir: bundle.desktopDir, expectedCommit: COMMIT });
    assert.equal(result.commit, COMMIT);
    assert.equal(result.assetNames.length, 6);
    assert.match(result.installer, /^ChatGPT Orchestra Setup /);
  } finally {
    fs.rmSync(bundle.root, { recursive: true, force: true });
  }
});

test("post-transfer bundle verification fails closed on asset tampering", () => {
  const bundle = createBundle();
  try {
    const installer = path.join(bundle.desktopDir, `ChatGPT Orchestra Setup ${ALPHA_VERSION}.exe`);
    fs.appendFileSync(installer, "tampered", "utf8");
    assert.throws(
      () => verifyReleaseBundle({ desktopDir: bundle.desktopDir, expectedCommit: COMMIT }),
      /alpha_release_manifest_asset_(size|hash)_mismatch/
    );
  } finally {
    fs.rmSync(bundle.root, { recursive: true, force: true });
  }
});

test("checksum parser rejects traversal and duplicate asset names", () => {
  const hash = "a".repeat(64);
  assert.throws(() => parseChecksums(`${hash}  ../installer.exe\n`), /checksum_line_invalid|checksum_name_invalid/);
  assert.throws(() => parseChecksums(`${hash}  installer.exe\n${hash}  installer.exe\n`), /checksum_duplicate/);
});

test("release workflow isolates write permission and signing secrets from install/build validation", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "alpha-release.yml"), "utf8");
  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*issues: read/);

  const signedStart = workflow.indexOf("  signed-alpha:");
  const publishStart = workflow.indexOf("  publish-alpha:");
  assert.ok(signedStart >= 0 && publishStart > signedStart, "expected split signed-alpha and publish-alpha jobs");
  const signedJob = workflow.slice(signedStart, publishStart);
  const publishJob = workflow.slice(publishStart);

  assert.doesNotMatch(signedJob, /contents: write/);
  assert.match(publishJob, /needs: signed-alpha/);
  assert.match(publishJob, /permissions:\s*\n\s*contents: write/);
  assert.doesNotMatch(publishJob, /npm install|WINDOWS_CSC_LINK|WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(publishJob, /verify-alpha-release-bundle\.js/);
  assert.match(publishJob, /actions\/download-artifact@v4/);

  const installStep = signedJob.slice(signedJob.indexOf("Install packaging dependencies"), signedJob.indexOf("Run full alpha acceptance gate"));
  assert.doesNotMatch(installStep, /CSC_LINK|CSC_KEY_PASSWORD|GITHUB_TOKEN|GH_TOKEN/);

  const buildStep = signedJob.slice(signedJob.indexOf("Build signed Windows alpha installer"), signedJob.indexOf("Stage fallback extension"));
  assert.match(buildStep, /CSC_LINK: \$\{\{ secrets\.WINDOWS_CSC_LINK \}\}/);
  assert.match(buildStep, /CSC_KEY_PASSWORD: \$\{\{ secrets\.WINDOWS_CSC_KEY_PASSWORD \}\}/);
});

test("release publication verifies a draft before making it visible and cleans failed staging", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "alpha-release.yml"), "utf8");
  const publishJob = workflow.slice(workflow.indexOf("  publish-alpha:"));

  const stage = publishJob.indexOf("Stage final alpha as draft prerelease");
  const verifyDraft = publishJob.indexOf("Verify staged draft before publication");
  const publish = publishJob.indexOf("Publish verified alpha prerelease");
  const verifyPublished = publishJob.indexOf("Verify published prerelease tag and assets");
  const cleanup = publishJob.indexOf("Cleanup failed staged release");
  assert.ok(stage >= 0 && verifyDraft > stage && publish > verifyDraft && verifyPublished > publish && cleanup > verifyPublished);

  assert.match(publishJob, /gh release create[\s\S]*--prerelease[\s\S]*--draft/);
  assert.match(publishJob, /--json tagName,targetCommitish,isDraft,isPrerelease,assets/);
  assert.match(publishJob, /targetCommitish[\s\S]*GITHUB_SHA/);
  assert.match(publishJob, /isDraft -ne \$true/);
  assert.match(publishJob, /gh release edit \$tag[\s\S]*--draft=false --prerelease/);
  assert.match(publishJob, /if: \$\{\{ failure\(\) \}\}/);
  assert.match(publishJob, /gh release delete \$tag[\s\S]*--yes --cleanup-tag/);
});
