const test = require("node:test");
const assert = require("node:assert/strict");
const { ReviewStore } = require("../background/review-store.js");

function fakeStorage() {
  const data = {};
  return { data, async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

test("persists review queue and forbids self-review assignment", async () => {
  const storage = fakeStorage();
  let id = 0;
  const store = new ReviewStore({ storageArea: storage, idFactory: () => `REV${++id}` });
  await store.load();
  await store.ensureProject("P1", { maxReviewIterations: 4 });
  const queued = await store.enqueue({ taskId: "T1", workerRunId: "R1", authorAgentId: "A1", iteration: 1 });
  assert.equal(queued.review.reviewId, "REV1");
  assert.equal((await store.assign("REV1", "A1")).reason, "self_review_forbidden");
  const assigned = await store.assign("REV1", "A2");
  assert.equal(assigned.ok, true);
  assert.equal(assigned.review.reviewerAgentId, "A2");

  const restored = new ReviewStore({ storageArea: storage });
  await restored.load();
  assert.equal(restored.get("REV1").reviewerAgentId, "A2");
  assert.equal(restored.summary().settings.maxReviewIterations, 4);
});

test("requeue releases reviewer identity without losing review provenance", async () => {
  const store = new ReviewStore({ storageArea: fakeStorage(), idFactory: () => "REV1" });
  await store.load();
  await store.ensureProject("P1");
  await store.enqueue({ taskId: "T1", workerRunId: "R1", authorAgentId: "A1", iteration: 2, packetSeed: { workerReport: { summary: "done" } } });
  await store.assign("REV1", "A2");
  const requeued = await store.requeue("REV1", "tab_closed");
  assert.equal(requeued.status, "PENDING");
  assert.equal(requeued.reviewerAgentId, null);
  assert.equal(requeued.authorAgentId, "A1");
  assert.equal(requeued.workerRunId, "R1");
  assert.equal(requeued.iteration, 2);
  assert.equal(requeued.packetSeed.workerReport.summary, "done");
});
