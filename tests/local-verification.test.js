"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeLocalVerificationPlan, requiresLocalVerification } = require("../platform/local-verification.js");
const { NodeCommandRunner, redactKnownSecrets } = require("../platform/node-command-runner.js");

test("structured local verification accepts executable plus argv and rejects shell/env fields", () => {
  const accepted = normalizeLocalVerificationPlan([
    { command: "npm", args: ["test", "--", "--runInBand"], timeoutMs: 120000, label: "unit tests" }
  ], { required: true });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.commands[0].args, ["test", "--", "--runInBand"]);

  assert.equal(normalizeLocalVerificationPlan(undefined, { required: true }).reason, "local_verification_plan_missing");
  assert.equal(normalizeLocalVerificationPlan([{ command: "npm", args: ["test"], shell: true }], { required: true }).reason, "local_verification_unsafe_fields");
  assert.equal(normalizeLocalVerificationPlan([{ command: "npm", args: ["test"], environment: { TOKEN: "x" } }], { required: true }).reason, "local_verification_unsafe_fields");
  assert.equal(normalizeLocalVerificationPlan([{ command: "npm test", args: [] }], { required: true }).ok, true, "spaces in executable paths are allowed because spawn uses shell:false");
  assert.equal(requiresLocalVerification({ kind: "code" }), true);
  assert.equal(requiresLocalVerification({ kind: "analysis" }), false);
});

test("known tokens and secret assignments are redacted from command output", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-redaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = `ghp_${"a".repeat(32)}`;
  const apiKey = `sk-${"b".repeat(32)}`;
  const generic = "API_KEY=super-secret-value";
  const runner = new NodeCommandRunner({ workspaceRoot: root });
  const result = await runner.run(
    process.execPath,
    ["-e", `process.stdout.write(${JSON.stringify(`${secret}\n${apiKey}\n${generic}`)})`],
    root,
    { trusted: true, timeoutMs: 5000 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes(apiKey), false);
  assert.equal(result.stdout.includes("super-secret-value"), false);
  assert.match(result.stdout, /REDACTED/);
  assert.equal(redactKnownSecrets(`Bearer ${"c".repeat(40)}`).includes("c".repeat(20)), false);
});
