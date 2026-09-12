const test = require("node:test");
const assert = require("node:assert/strict");

const GenerationStateMachine = require("../content/generation-state.js");

test("does not treat the response present at startup as a fresh completion", () => {
  const machine = new GenerationStateMachine({ quietMs: 500 });
  assert.deepEqual(machine.observe({ busy: false, fingerprint: "old", now: 0 }), []);
  assert.deepEqual(machine.observe({ busy: false, fingerprint: "old", now: 2000 }), []);
});

test("emits one completion after an observed busy -> idle transition", () => {
  const machine = new GenerationStateMachine({ quietMs: 500 });
  machine.observe({ busy: false, fingerprint: "old", now: 0 });

  const started = machine.observe({ busy: true, fingerprint: "old", now: 100 });
  assert.equal(started.some((event) => event.type === "generation_started"), true);

  const stopped = machine.observe({ busy: false, fingerprint: "new", now: 200 });
  assert.equal(stopped.some((event) => event.type === "generation_stopped"), true);
  assert.equal(stopped.some((event) => event.type === "generation_completed"), false);

  const completed = machine.observe({ busy: false, fingerprint: "new", now: 701 });
  assert.equal(completed.filter((event) => event.type === "generation_completed").length, 1);
});

test("recovers when the explicit busy signal was completely missed", () => {
  const machine = new GenerationStateMachine({ quietMs: 500 });
  machine.observe({ busy: false, fingerprint: "old", now: 0 });

  const changed = machine.observe({ busy: false, fingerprint: "new", now: 100 });
  assert.equal(changed.some((event) => event.type === "response_changed"), true);
  assert.equal(changed.some((event) => event.type === "generation_completed"), false);

  const completed = machine.observe({ busy: false, fingerprint: "new", now: 601 });
  assert.equal(completed.filter((event) => event.type === "generation_completed").length, 1);
});

test("does not emit duplicate completion for the same fingerprint", () => {
  const machine = new GenerationStateMachine({ quietMs: 100 });
  machine.observe({ busy: false, fingerprint: "old", now: 0 });
  machine.observe({ busy: false, fingerprint: "new", now: 10 });

  const first = machine.observe({ busy: false, fingerprint: "new", now: 111 });
  const second = machine.observe({ busy: false, fingerprint: "new", now: 1000 });

  assert.equal(first.some((event) => event.type === "generation_completed"), true);
  assert.equal(second.some((event) => event.type === "generation_completed"), false);
});

test("waits for a new quiet window when response text changes while settling", () => {
  const machine = new GenerationStateMachine({ quietMs: 500 });
  machine.observe({ busy: false, fingerprint: "old", now: 0 });
  machine.observe({ busy: false, fingerprint: "partial-1", now: 100 });
  machine.observe({ busy: false, fingerprint: "partial-2", now: 400 });

  assert.equal(
    machine.observe({ busy: false, fingerprint: "partial-2", now: 800 })
      .some((event) => event.type === "generation_completed"),
    false
  );

  assert.equal(
    machine.observe({ busy: false, fingerprint: "partial-2", now: 901 })
      .some((event) => event.type === "generation_completed"),
    true
  );
});
