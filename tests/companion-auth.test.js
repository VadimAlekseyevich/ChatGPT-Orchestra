const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ensureDesktopPaths } = require("../apps/desktop/main/app-data.js");
const {
  ensureCompanionSecret,
  createClientAuth,
  verifyClientAuth,
  createServerAck,
  verifyServerAck
} = require("../apps/desktop/main/companion-auth.js");

test("companion pairing secret is persistent and challenge/response proofs are mutually verified", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-companion-auth-"));
  const paths = ensureDesktopPaths({ dataDirectory: root });
  const first = ensureCompanionSecret({ paths });
  const second = ensureCompanionSecret({ paths });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(paths.companionSecretFile).mode & 0o777, 0o600);
  }

  const hello = createClientAuth(first);
  assert.equal(verifyClientAuth(first, hello), true);
  assert.equal(verifyClientAuth("0".repeat(64), hello), false);

  const ack = createServerAck(first, hello.clientNonce);
  assert.equal(verifyServerAck(first, hello.clientNonce, ack), true);
  assert.equal(verifyServerAck(first, "f".repeat(48), ack), false);
});
