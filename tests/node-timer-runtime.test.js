const test = require("node:test");
const assert = require("node:assert/strict");

require("../platform/contracts.js");
const { NodeTimerRuntime } = require("../platform/node-timer-runtime.js");

test("NodeTimerRuntime satisfies TimerRuntime and replaces named recurring timers", async () => {
  const scheduled = [];
  const cleared = [];
  const setIntervalFn = (listener, delay) => {
    const handle = { listener, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    scheduled.push(handle);
    return handle;
  };
  const clearIntervalFn = (handle) => cleared.push(handle);
  const runtime = new NodeTimerRuntime({ setIntervalFn, clearIntervalFn, logger: { warn() {} } });
  globalThis.ChatGPTOrchestra.PlatformContracts.assertTimerRuntime(runtime);

  let fires = 0;
  runtime.scheduleRecurring("watchdog", { periodMinutes: 2 }, async () => { fires += 1; });
  assert.equal(scheduled[0].delay, 120000);
  assert.equal(scheduled[0].unrefCalled, true);
  await scheduled[0].listener();
  assert.equal(fires, 1);

  runtime.scheduleRecurring("watchdog", { periodMinutes: 1 }, () => {});
  assert.equal(cleared.length, 1);
  assert.deepEqual(runtime.list(), [{ name: "watchdog", intervalMs: 60000 }]);
  assert.equal(await runtime.cancel("watchdog"), true);
  assert.equal(await runtime.cancel("watchdog"), false);
});

test("NodeTimerRuntime contains listener failures instead of rejecting the interval callback", async () => {
  let scheduledListener = null;
  const warnings = [];
  const runtime = new NodeTimerRuntime({
    setIntervalFn(listener) { scheduledListener = listener; return { unref() {} }; },
    clearIntervalFn() {},
    logger: { warn(...args) { warnings.push(args); } }
  });
  runtime.scheduleRecurring("watchdog", {}, async () => { throw new Error("boom"); });
  await scheduledListener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
});
