const test = require("node:test");
const assert = require("node:assert/strict");

const Contracts = require("../platform/contracts.js");
const { ChromeStorageStateStore } = require("../platform/extension-runtime.js");
const { MemoryStateStore } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { SQLiteStateStore, loadDatabaseSync } = require("../platform/sqlite-state-store.js");

let sqliteAvailable = true;
try { loadDatabaseSync(); } catch (_) { sqliteAvailable = false; }

function fakeChromeStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(selector = null) {
      if (typeof selector === "string") return { [selector]: data[selector] };
      if (Array.isArray(selector)) return Object.fromEntries(selector.map((key) => [key, data[key]]));
      if (selector && typeof selector === "object") return Object.fromEntries(Object.entries(selector).map(([key, fallback]) => [key, data[key] === undefined ? fallback : data[key]]));
      return { ...data };
    },
    async set(values) { Object.assign(data, values || {}); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async clear() { for (const key of Object.keys(data)) delete data[key]; }
  };
}

async function exercise(store) {
  Contracts.assertTransactionalStateStore(store);
  await store.set({ alpha: { value: 1 }, beta: 2 });
  assert.deepEqual((await store.get("alpha")).alpha, { value: 1 });
  await store.transaction(async (tx) => {
    assert.equal((await tx.get("beta")).beta, 2);
    await tx.set({ beta: 3, gamma: [1, 2] });
    assert.equal((await tx.get("beta")).beta, 3);
  });
  assert.equal((await store.get("beta")).beta, 3);
  assert.deepEqual((await store.get("gamma")).gamma, [1, 2]);
  await store.remove("alpha");
  assert.equal((await store.get("alpha")).alpha, undefined);
}

test("ChromeStorageStateStore satisfies Phase 11 transactional conformance through wrapper", async () => {
  const base = new ChromeStorageStateStore({ storageArea: fakeChromeStorage() });
  await exercise(new TransactionalStateStore({ store: base }));
});

test("MemoryStateStore satisfies Phase 11 transactional conformance through wrapper", async () => {
  await exercise(new TransactionalStateStore({ store: new MemoryStateStore() }));
});

test("TransactionalStateStore serializes ordinary writes behind an active transaction", async () => {
  const store = new TransactionalStateStore({ store: new MemoryStateStore() });
  const order = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const transaction = store.transaction(async (tx) => {
    order.push("transaction-start");
    await tx.set({ imported: true });
    await blocked;
    order.push("transaction-end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const ordinaryWrite = store.set({ heartbeat: true }).then(() => order.push("ordinary-write"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["transaction-start"]);
  release();
  await Promise.all([transaction, ordinaryWrite]);
  assert.deepEqual(order, ["transaction-start", "transaction-end", "ordinary-write"]);
  const state = await store.get(null);
  assert.equal(state.imported, true);
  assert.equal(state.heartbeat, true);
});

test("SQLiteStateStore provides native transactional conformance", { skip: !sqliteAvailable }, async () => {
  const store = new SQLiteStateStore({ filename: ":memory:" });
  try { await exercise(store); }
  finally { store.close(); }
});

test("SQLite transaction rolls back failed writes", { skip: !sqliteAvailable }, async () => {
  const store = new SQLiteStateStore({ filename: ":memory:" });
  try {
    await store.set({ stable: "before" });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.set({ stable: "after", transient: true });
      throw new Error("boom");
    }), /boom/);
    assert.equal((await store.get("stable")).stable, "before");
    assert.equal((await store.get("transient")).transient, undefined);
  } finally { store.close(); }
});
