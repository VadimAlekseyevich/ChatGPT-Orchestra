"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLocalSchedulerEngine, isReplayableLocalCompletion } = require("../apps/desktop/main/local-scheduler-engine.js");

function run() {
  return { runId: "R1", taskId: "T1", agentId: "A1", status: "RUNNING" };
}

function record(overrides = {}) {
  return {
    cursor: 7,
    source: { workerArtifact: { format: "file-set-v1", files: [{ path: "src/value.js", operation: "write", content: "next\n" }] } },
    event: {
      v: 1,
      event: "DONE",
      projectId: "P1",
      taskId: "T1",
      runId: "R1",
      agentId: "A1",
      eventId: "R1-final",
      sequence: 1,
      payload: { artifactFormat: "file-set-v1", workerArtifactSignature: "fnv1a64:0123456789abcdef" },
      ...(overrides.event || {})
    },
    ...overrides
  };
}

test("only persisted local file-set completion for the same active run is replayable", () => {
  const active = run();
  assert.equal(isReplayableLocalCompletion(record(), active), true);
  assert.equal(isReplayableLocalCompletion(record({ source: { workerArtifact: null } }), active), false);
  assert.equal(isReplayableLocalCompletion(record({ event: { ...record().event, runId: "R2" } }), active), false);
  assert.equal(isReplayableLocalCompletion(record({ event: { ...record().event, payload: { artifactFormat: "git" } } }), active), false);
});

test("desktop scheduler replays persisted local Worker DONE after restart only while run remains active", async () => {
  const decisions = [];
  const completions = [];
  class BaseSchedulerEngine {
    constructor(options = {}) { Object.assign(this, options); }
    async init() { return { initialized: true }; }
    getPublicState() { return { status: "RUNNING" }; }
  }
  const LocalSchedulerEngine = createLocalSchedulerEngine(BaseSchedulerEngine);
  const store = {
    activeRuns() { return [run()]; },
    async logDecision(type, details) { decisions.push({ type, details }); }
  };
  const eventBus = { recent() { return { events: [record()] }; } };
  const engine = new LocalSchedulerEngine({ store, eventBus });
  engine.handleCompletion = async (item) => { completions.push(item.event.eventId); };

  const state = await engine.init();
  assert.deepEqual(state, { status: "RUNNING" });
  assert.deepEqual(completions, ["R1-final"]);
  assert.equal(decisions[0].type, "local_worker_completion_replayed");
  assert.equal(decisions[0].details.runId, "R1");

  store.activeRuns = () => [];
  completions.length = 0;
  assert.deepEqual(await engine.replayPersistedLocalCompletions(), { replayed: 0 });
  assert.deepEqual(completions, []);
});
