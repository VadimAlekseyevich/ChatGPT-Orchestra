"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateEvidenceCommentBody,
  validateEvidenceComments
} = require("../scripts/validate-alpha-evidence-comments.js");

const A01_REF = "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-123456789";
const A11_REF = "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-987654321";
const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const A01_BODY = `Scenario: A01
Result: PASS
Alpha version: 2.0.0-alpha.20
Build commit: ${BUILD_COMMIT}
Windows version: Windows 11 24H2 build 26100
Fresh profile: clean disposable Windows VM with no existing Orchestra app-data
Install/launch: PASS
ChatGPT interactive login: PASS
Lead registration/readiness: PASS
Export privacy check: PASS — no credentials, cookies, browser profile paths, or runtime identifiers
Tester: release-operator
Timestamp UTC: 2026-09-15T02:00:00Z
Notes/evidence attachments: none`;

const A11_BODY = `Scenario: A11
Result: PASS
Alpha version: 2.0.0-alpha.20
Build commit: ${BUILD_COMMIT}
Project/repository reference: local-test-repository
State before OS restart: RUNNING task=T1 run=R1
Pre-restart systemBootTimeUtc: 2026-09-14T08:00:00.000Z
Real OS restart performed: PASS
Post-restart systemBootTimeUtc: 2026-09-15T01:50:00.000Z
State after relaunch/reconciliation: RUNNING task=T1 run=R1 recovered
Resume result: PASS
Duplicate irreversible side effects check: PASS
Worktree/state preservation: PASS
Tester: release-operator
Timestamp UTC: 2026-09-15T02:05:00Z
Notes/evidence attachments: none`;

test("A01 evidence comment requires clean-profile login/privacy fields and a valid build commit", () => {
  const result = validateEvidenceCommentBody("A01", A01_BODY);
  assert.equal(result.ok, true);
  assert.equal(result.scenarioId, "A01");
  assert.equal(result.buildCommit, BUILD_COMMIT);

  assert.match(validateEvidenceCommentBody("A01", A01_BODY.replace("ChatGPT interactive login: PASS", "ChatGPT interactive login: FAIL")).reason, /field_not_pass/);
  assert.match(validateEvidenceCommentBody("A01", A01_BODY.replace("Fresh profile: clean disposable Windows VM with no existing Orchestra app-data", "Fresh profile: <describe profile>")).reason, /field_placeholder/);
  assert.match(validateEvidenceCommentBody("A01", A01_BODY.replace("Alpha version: 2.0.0-alpha.20", "Alpha version: 2.0.0-alpha.19")).reason, /version_mismatch/);
  assert.match(validateEvidenceCommentBody("A01", A01_BODY.replace(BUILD_COMMIT, "deadbeef")).reason, /build_commit_invalid/);
});

test("manual evidence build commit must match the exact release commit", () => {
  assert.equal(validateEvidenceCommentBody("A01", A01_BODY, { expectedCommit: BUILD_COMMIT }).ok, true);
  assert.equal(validateEvidenceCommentBody("A11", A11_BODY, { expectedCommit: BUILD_COMMIT }).ok, true);
  const mismatch = "f".repeat(40);
  assert.match(validateEvidenceCommentBody("A01", A01_BODY, { expectedCommit: mismatch }).reason, /build_commit_mismatch:A01/);
  assert.match(validateEvidenceCommentBody("A11", A11_BODY, { expectedCommit: mismatch }).reason, /build_commit_mismatch:A11/);
});

test("A11 evidence comment proves a later OS boot fingerprint and recovery PASS fields", () => {
  const result = validateEvidenceCommentBody("A11", A11_BODY);
  assert.equal(result.ok, true);
  assert.equal(result.buildCommit, BUILD_COMMIT);
  assert.equal(result.preRestartSystemBootTimeUtc, "2026-09-14T08:00:00.000Z");
  assert.equal(result.postRestartSystemBootTimeUtc, "2026-09-15T01:50:00.000Z");

  const sameBoot = A11_BODY.replace("Post-restart systemBootTimeUtc: 2026-09-15T01:50:00.000Z", "Post-restart systemBootTimeUtc: 2026-09-14T08:00:00.000Z");
  assert.match(validateEvidenceCommentBody("A11", sameBoot).reason, /boot_time_not_advanced/);
  assert.match(validateEvidenceCommentBody("A11", A11_BODY.replace("Resume result: PASS", "Resume result: FAIL")).reason, /field_not_pass/);
});

test("manual evidence timestamp and scenario identity are strict", () => {
  assert.match(validateEvidenceCommentBody("A01", A01_BODY.replace("Timestamp UTC: 2026-09-15T02:00:00Z", "Timestamp UTC: yesterday")).reason, /timestamp_invalid/);
  assert.match(validateEvidenceCommentBody("A01", A01_BODY.replace("Scenario: A01", "Scenario: A11")).reason, /scenario_mismatch/);
  assert.match(validateEvidenceCommentBody("A10", A01_BODY).reason, /scenario_invalid/);
});

test("GitHub comment validation fetches exact permalinks, binds them to release SHA and records hashes", async () => {
  const comments = new Map([
    ["123456789", { html_url: A01_REF, body: A01_BODY, user: { login: "tester-a" }, created_at: "2026-09-15T02:00:01Z", updated_at: "2026-09-15T02:00:01Z" }],
    ["987654321", { html_url: A11_REF, body: A11_BODY, user: { login: "tester-b" }, created_at: "2026-09-15T02:05:01Z", updated_at: "2026-09-15T02:05:01Z" }]
  ]);
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, options });
    const id = String(url).split("/").at(-1);
    const comment = comments.get(id);
    return { ok: Boolean(comment), status: comment ? 200 : 404, async json() { return comment; } };
  };

  const result = await validateEvidenceComments(["A01", A01_REF, "A11", A11_REF], {
    token: "test-token",
    fetchImpl,
    expectedCommit: BUILD_COMMIT,
    clock: () => Date.parse("2026-09-15T02:10:00Z")
  });

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.alphaVersion, "2.0.0-alpha.20");
  assert.equal(result.expectedCommit, BUILD_COMMIT);
  assert.equal(result.validatedAtUtc, "2026-09-15T02:10:00.000Z");
  assert.deepEqual(result.scenarios.map((item) => item.scenarioId), ["A01", "A11"]);
  assert.deepEqual(result.scenarios.map((item) => item.evidence.buildCommit), [BUILD_COMMIT, BUILD_COMMIT]);
  assert.match(result.scenarios[0].bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(result.scenarios[1].author, "tester-b");
  assert.equal(requested.length, 2);
  assert.match(requested[0].options.headers.Authorization, /^Bearer /);
});

test("GitHub comment validation fails closed on missing release commit, missing token or URL mismatch", async () => {
  await assert.rejects(
    validateEvidenceComments(["A01", A01_REF, "A11", A11_REF], { token: "test-token", expectedCommit: "", fetchImpl: async () => ({ ok: true }) }),
    /expected_commit_missing_or_invalid/
  );

  await assert.rejects(
    validateEvidenceComments(["A01", A01_REF, "A11", A11_REF], { token: "", expectedCommit: BUILD_COMMIT, fetchImpl: async () => ({ ok: true }) }),
    /github_token_missing/
  );

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { html_url: "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-1", body: A01_BODY, user: { login: "tester" } }; }
  });
  await assert.rejects(
    validateEvidenceComments(["A01", A01_REF, "A11", A11_REF], { token: "test-token", expectedCommit: BUILD_COMMIT, fetchImpl }),
    /comment_url_mismatch/
  );
});
