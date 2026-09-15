const test = require("node:test");
const assert = require("node:assert/strict");

const MESSAGE_TYPES = require("../content/message-types.js");
const { ManagedBrowserProtocolAdapter } = require("../apps/desktop/main/managed-browser-protocol-adapter.js");

function eventLine(overrides = {}) {
  return `@@ORCH ${JSON.stringify({
    v: 1,
    event: "DONE",
    projectId: "P1",
    taskId: "T1",
    runId: "R1",
    agentId: "A1",
    eventId: "E1",
    sequence: 1,
    payload: { commit: "abc123" },
    ...overrides
  })}`;
}

function harness() {
  const messages = [];
  const agent = { agentId: "A1", sessionId: "S1", chatUrl: "https://chatgpt.com/c/test" };
  const runtime = {
    getAgent(agentId) { return agentId === agent.agentId ? { ...agent } : null; },
    sessionIdForAgent(value) { return value?.sessionId || null; },
    async publishRuntimeMessage(message, sender) {
      messages.push({ message, sender });
      if (message.type === MESSAGE_TYPES.ORCHESTRA_EVENT) return { ok: true, accepted: true };
      return { ok: true };
    }
  };
  return { runtime, messages };
}

function snapshot(text) {
  return {
    text,
    fingerprint: "fp1",
    messageCount: 2,
    pathname: "/c/test",
    url: "https://chatgpt.com/c/test",
    availability: "ready",
    generating: false
  };
}

test("managed browser protocol adapter reuses heartbeat, completion and Orchestra event boundaries", async () => {
  const { runtime, messages } = harness();
  const adapter = new ManagedBrowserProtocolAdapter({ logger: { info() {} } });
  const result = await adapter.publishCompletion(runtime, "A1", snapshot(`work complete\n${eventLine()}`));

  assert.equal(result.ok, true);
  assert.deepEqual(messages.map((item) => item.message.type), [
    MESSAGE_TYPES.CONTENT_HEARTBEAT,
    MESSAGE_TYPES.ASSISTANT_RESPONSE_COMPLETED,
    MESSAGE_TYPES.ORCHESTRA_EVENT
  ]);
  const protocol = messages[2];
  assert.equal(protocol.message.payload.event.eventId, "E1");
  assert.equal(protocol.message.payload.responseFingerprint, "fp1");
  assert.equal(protocol.sender.agentId, "A1");
  assert.equal(protocol.sender.sessionId, "S1");
});

test("managed browser accepts planning output that spells v1 as protocolVersion and still transports its artifact", async () => {
  const { runtime, messages } = harness();
  const adapter = new ManagedBrowserProtocolAdapter({ logger: { info() {} } });
  const artifact = {
    repositoryAccess: { status: "ok", inspectedPaths: ["README.md"], gaps: [] },
    stack: ["HTML"],
    entrypoints: [],
    commands: { build: [], test: [], lint: [], typecheck: [] },
    modules: [],
    persistence: [],
    ci: [],
    instructions: { agentsMd: "absent", paths: [] },
    sensitiveAreas: [],
    constraints: []
  };
  const response = [
    "@@ORCH_ARTIFACT_BEGIN",
    JSON.stringify(artifact, null, 2),
    "@@ORCH_ARTIFACT_END",
    `@@ORCH ${JSON.stringify({
      protocolVersion: 1,
      event: "DONE",
      projectId: "P1",
      taskId: "planning:discovery",
      runId: "R1",
      agentId: "A1",
      sequence: 1,
      eventId: "R1-final",
      payload: { stage: "DISCOVERY" }
    })}`
  ].join("\n");

  const result = await adapter.publishCompletion(runtime, "A1", snapshot(response));
  assert.equal(result.ok, true);
  const protocol = messages.find((item) => item.message.type === MESSAGE_TYPES.ORCHESTRA_EVENT);
  assert.ok(protocol);
  assert.equal(protocol.message.payload.event.v, 1);
  assert.equal(protocol.message.payload.event.taskId, "planning:discovery");
  assert.deepEqual(protocol.message.payload.planningArtifact, artifact);
});

test("managed browser protocol adapter rejects an event claiming another logical agent", async () => {
  const { runtime, messages } = harness();
  const adapter = new ManagedBrowserProtocolAdapter({ logger: { info() {} } });
  const result = await adapter.publishCompletion(runtime, "A1", snapshot(eventLine({ agentId: "OTHER" })));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "agent_mismatch_content");
  assert.deepEqual(messages.map((item) => item.message.type), [
    MESSAGE_TYPES.CONTENT_HEARTBEAT,
    MESSAGE_TYPES.ASSISTANT_RESPONSE_COMPLETED,
    MESSAGE_TYPES.PROTOCOL_ERROR
  ]);
  assert.equal(messages.some((item) => item.message.type === MESSAGE_TYPES.ORCHESTRA_EVENT), false);
});

test("managed browser protocol adapter publishes parser failures through existing protocol-error boundary", async () => {
  const { runtime, messages } = harness();
  const adapter = new ManagedBrowserProtocolAdapter({ logger: { info() {} } });
  const result = await adapter.publishCompletion(runtime, "A1", snapshot("bad\n@@ORCH {broken"));

  assert.equal(result.ok, false);
  assert.equal(messages.at(-1).message.type, MESSAGE_TYPES.PROTOCOL_ERROR);
  assert.equal(messages.some((item) => item.message.type === MESSAGE_TYPES.ORCHESTRA_EVENT), false);
});
