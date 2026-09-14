"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const WorkerArtifactParser = require("../content/worker-artifact-parser.js");
const OrchestraProtocol = require("../protocol/orchestra-protocol.js");
const { EventStore } = require("../background/event-store.js");
const { createLocalOrchestrator } = require("../apps/desktop/main/local-orchestrator.js");

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

function doneEvent(signature) {
  return {
    v: 1,
    event: "DONE",
    projectId: "P1",
    taskId: "T1",
    runId: "R1",
    agentId: "A1",
    eventId: "R1-final",
    sequence: 1,
    payload: {
      summary: "done",
      testsPerformed: [],
      knownLimitations: [],
      artifactFormat: "file-set-v1",
      workerArtifactSignature: signature
    }
  };
}

test("Worker artifact block is parsed separately while the final Orchestra event stays compact", () => {
  const artifact = {
    format: "file-set-v1",
    files: [{ path: "src/value.js", operation: "write", content: "module.exports = 2;\n" }]
  };
  const text = [
    "worker explanation",
    WorkerArtifactParser.BEGIN,
    JSON.stringify(artifact, null, 2),
    WorkerArtifactParser.END,
    `@@ORCH ${JSON.stringify(doneEvent("host-will-replace"))}`
  ].join("\n");
  const parsed = WorkerArtifactParser.parseWorkerArtifact(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.artifact, artifact);
  assert.match(parsed.signature, /^fnv1a64:[0-9a-f]{16}$/);

  const finalLine = `@@ORCH ${JSON.stringify(doneEvent(parsed.signature))}`;
  assert.ok(finalLine.length < OrchestraProtocol.MAX_ENVELOPE_LENGTH);
  assert.equal(OrchestraProtocol.parseLine(finalLine).ok, true);
  assert.equal(finalLine.includes("module.exports"), false);
});

test("Worker artifact parser rejects ambiguous, malformed, wrong-format and oversized blocks", () => {
  const artifact = { format: "file-set-v1", files: [{ path: "src/a.js", operation: "write", content: "x" }] };
  assert.equal(WorkerArtifactParser.parseWorkerArtifact("no markers").reason, "worker_artifact_markers_missing");
  const ambiguous = [WorkerArtifactParser.BEGIN, JSON.stringify(artifact), WorkerArtifactParser.END, WorkerArtifactParser.BEGIN, JSON.stringify(artifact), WorkerArtifactParser.END].join("\n");
  assert.equal(WorkerArtifactParser.parseWorkerArtifact(ambiguous).reason, "worker_artifact_marker_ambiguous");
  const wrongFormat = [WorkerArtifactParser.BEGIN, JSON.stringify({ format: "patch-v1", files: [] }), WorkerArtifactParser.END].join("\n");
  assert.equal(WorkerArtifactParser.parseWorkerArtifact(wrongFormat).reason, "worker_artifact_format_invalid");
  const malformed = [WorkerArtifactParser.BEGIN, "{bad", WorkerArtifactParser.END].join("\n");
  assert.equal(WorkerArtifactParser.parseWorkerArtifact(malformed).reason, "worker_artifact_invalid_json");
  const oversized = [WorkerArtifactParser.BEGIN, JSON.stringify({ format: "file-set-v1", files: [], padding: "x".repeat(200) }), WorkerArtifactParser.END].join("\n");
  assert.equal(WorkerArtifactParser.parseWorkerArtifact(oversized, { maxBytes: 50 }).reason, "worker_artifact_too_large");
});

test("EventStore persists Worker artifact in source, separate from the compact event payload", async () => {
  const storage = fakeStorage();
  const store = new EventStore({ storageArea: storage });
  await store.load();
  const artifact = { format: "file-set-v1", files: [{ path: "src/value.js", operation: "write", content: "next\n" }] };
  const signature = WorkerArtifactParser.artifactSignature(artifact);
  const accepted = await store.accept(doneEvent(signature), {
    route: "completion",
    source: { responseFingerprint: "fp", workerArtifact: artifact }
  });
  assert.deepEqual(accepted.source.workerArtifact, artifact);
  const record = store.recentEvents(1)[0];
  assert.deepEqual(record.source.workerArtifact, artifact);
  assert.equal(record.event.payload.workerArtifactSignature, signature);
  assert.equal(Object.prototype.hasOwnProperty.call(record.event.payload, "localChanges"), false);
});

test("Desktop local orchestrator rejects Worker artifact signature mismatch before EventBus acceptance", async () => {
  const artifact = { format: "file-set-v1", files: [{ path: "src/value.js", operation: "write", content: "next\n" }] };
  const signature = WorkerArtifactParser.artifactSignature(artifact);
  const calls = [];
  const eventBus = {
    async reject(reason) { calls.push(["reject", reason]); return { ok: false, reason }; },
    async handleEvent(event, sender, source) { calls.push(["accept", event, sender, source]); return { ok: true, accepted: true }; }
  };
  class BaseOrchestrator {
    constructor({ eventBus: bus }) { this.eventBus = bus; }
    senderContext(sender) { return sender; }
  }
  const LocalOrchestrator = createLocalOrchestrator(BaseOrchestrator);
  const orchestrator = new LocalOrchestrator({ eventBus });

  const mismatch = await orchestrator.handleProtocolEvent({ payload: { event: doneEvent("fnv1a64:0000000000000000"), workerArtifact: artifact } }, { agentId: "A1" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "worker_artifact_signature_mismatch");
  assert.deepEqual(calls[0], ["reject", "worker_artifact_signature_mismatch"]);

  calls.length = 0;
  const accepted = await orchestrator.handleProtocolEvent({ payload: { event: doneEvent(signature), workerArtifact: artifact, responseFingerprint: "fp" } }, { agentId: "A1" });
  assert.equal(accepted.ok, true);
  assert.equal(calls[0][0], "accept");
  assert.deepEqual(calls[0][3].workerArtifact, artifact);
});
