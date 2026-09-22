const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  StructuredLogger,
  sanitizeValue
} = require("../apps/desktop/main/structured-logger.js");

function silentConsole() {
  return { log() {}, debug() {}, warn() {}, error() {} };
}

function tempLogFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-structured-log-"));
  return path.join(directory, "orchestra.jsonl");
}

test("StructuredLogger writes privacy-safe JSONL with stable component context", () => {
  const filename = tempLogFile();
  let now = Date.parse("2026-09-22T12:00:00.000Z");
  const logger = new StructuredLogger({
    filename,
    clock: () => now++,
    consoleTarget: silentConsole(),
    instanceId: "test-instance",
    component: "desktop"
  });
  const error = new Error("boom");
  const circular = { name: "root" };
  circular.self = circular;

  logger.info("diagnostic", {
    token: "secret-token",
    password: "secret-password",
    prompt: "do not persist this prompt",
    url: "https://example.com/path?access_token=secret#fragment",
    nested: { cookie: "session-cookie" },
    error,
    circular
  });
  logger.child("managed-browser", { runtime: "direct" }).debug("heartbeat", { availability: "ready" });

  const lines = fs.readFileSync(filename, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].instanceId, "test-instance");
  assert.equal(lines[0].component, "desktop");
  assert.equal(lines[0].details.token, "[redacted]");
  assert.equal(lines[0].details.password, "[redacted]");
  assert.equal(lines[0].details.nested.cookie, "[redacted]");
  assert.match(lines[0].details.prompt, /^\[omitted:/);
  assert.equal(lines[0].details.url, "https://example.com/path");
  assert.equal(lines[0].details.error.message, "boom");
  assert.equal(lines[0].details.circular.self, "[circular]");
  assert.equal(lines[1].component, "managed-browser");
  assert.equal(lines[1].details.runtime, "direct");
  assert.equal(lines[1].seq, lines[0].seq + 1);

  const serialized = fs.readFileSync(filename, "utf8");
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("secret-password"), false);
  assert.equal(serialized.includes("session-cookie"), false);
  assert.equal(serialized.includes("do not persist this prompt"), false);
  assert.equal(serialized.includes("access_token=secret"), false);
});

test("StructuredLogger rotates bounded JSONL files instead of growing without limit", () => {
  const filename = tempLogFile();
  const logger = new StructuredLogger({
    filename,
    consoleTarget: silentConsole(),
    instanceId: "rotation-test",
    maxBytes: 1024,
    maxFiles: 2
  });

  logger.info("first", { value: "x".repeat(900) });
  logger.info("second", { value: "y".repeat(900) });
  logger.info("third", { value: "z".repeat(900) });

  assert.equal(fs.existsSync(filename), true);
  assert.equal(fs.existsSync(`${filename}.1`), true);
  assert.equal(fs.existsSync(`${filename}.2`), true);
  assert.ok(fs.statSync(filename).size > 0);
  assert.ok(fs.statSync(`${filename}.1`).size > 0);
});

test("sanitizeValue bounds large collections and handles non-JSON values", () => {
  const sanitized = sanitizeValue({
    big: 123n,
    fn() {},
    items: Array.from({ length: 120 }, (_, index) => index)
  });
  assert.equal(sanitized.big, "123");
  assert.equal(sanitized.fn, "[function]");
  assert.equal(sanitized.items.length, 101);
  assert.match(sanitized.items.at(-1), /^\[omitted:/);
});
