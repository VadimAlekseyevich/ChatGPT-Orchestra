const test = require("node:test");
const assert = require("node:assert/strict");

const recoveryState = { status: "STOPPING", stopBoundaryActive: true };
let workerCompletions = 0;
let reviewVerdicts = 0;
let integrationConflicts = 0;

class PlanningEngine { async handleCompletion() { throw new Error("planning completion crossed stop boundary"); } async handleBlocker() {} }
class SchedulerEngine {
  async handleCompletion() { workerCompletions += 1; return { applied: true }; }
  async handleBlocker() {}
  async handleNeedsUser() {}
}
class ReviewEngine {
  async handleReviewEvent() { reviewVerdicts += 1; return { applied: true }; }
  async handleReviewFailureEvent() {}
}
class IntegrationEngine {
  async handleCompletion() {}
  async handleIntegrationEvent() { integrationConflicts += 1; return { applied: true }; }
  async handleFailureEvent() {}
}

globalThis.ChatGPTOrchestra = {
  RecoveryRuntime: { controller: { getPublicState: () => ({ ...recoveryState }) } },
  PlanningEngine,
  SchedulerEngine,
  ReviewEngine,
  IntegrationEngine
};
require("../background/recovery-stop-guards.js");

async function assertStopBoundaryBlocksHandlers() {
  const scheduler = new SchedulerEngine();
  const review = new ReviewEngine();
  const integration = new IntegrationEngine();
  assert.equal((await scheduler.handleCompletion({})).reason, "stop_boundary_active");
  assert.equal((await review.handleReviewEvent({})).reason, "stop_boundary_active");
  assert.equal((await integration.handleIntegrationEvent({})).reason, "stop_boundary_active");
  assert.equal(workerCompletions, 0);
  assert.equal(reviewVerdicts, 0);
  assert.equal(integrationConflicts, 0);
}

test("late DONE and review/integration events are ignored while Stop Now boundary is active", async () => {
  await assertStopBoundaryBlocksHandlers();
});

test("crash during STOPPING keeps late events blocked after status becomes RECOVERY_REQUIRED", async () => {
  recoveryState.status = "RECOVERY_REQUIRED";
  recoveryState.stopBoundaryActive = true;
  await assertStopBoundaryBlocksHandlers();
});

test("normal handlers resume only after persisted stop boundary is cleared", async () => {
  recoveryState.status = "RUNNING";
  recoveryState.stopBoundaryActive = false;
  const scheduler = new SchedulerEngine();
  const review = new ReviewEngine();
  const integration = new IntegrationEngine();
  assert.equal((await scheduler.handleCompletion({})).applied, true);
  assert.equal((await review.handleReviewEvent({})).applied, true);
  assert.equal((await integration.handleIntegrationEvent({})).applied, true);
  assert.equal(workerCompletions, 1);
  assert.equal(reviewVerdicts, 1);
  assert.equal(integrationConflicts, 1);
});
