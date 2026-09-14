const test = require("node:test");
const assert = require("node:assert/strict");
const { DesktopIpcRouter, registerElectronIpc, IPC_QUERY_CHANNEL, IPC_EXECUTE_CHANNEL } = require("../apps/desktop/main/ipc-router.js");

test("desktop IPC router exposes only portable query/execute DTOs", async () => {
  const calls = [];
  const host = {
    async query(name, payload) { calls.push(["query", name, payload]); return { apiVersion: 4, ok: true, state: { value: payload.value } }; },
    async execute(name, payload) { calls.push(["execute", name, payload]); return { apiVersion: 4, ok: true, result: payload }; }
  };
  const router = new DesktopIpcRouter({ host });
  const query = await router.query({ name: "state", payload: { value: 7 } });
  const command = await router.execute({ name: "pause", payload: { reason: "test" } });
  assert.equal(query.state.value, 7);
  assert.equal(command.result.reason, "test");
  assert.deepEqual(calls.map((item) => item.slice(0, 2)), [["query", "state"], ["execute", "pause"]]);
});

test("registerElectronIpc binds and removes stable channels", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(name, listener) { handlers.set(name, listener); },
    removeHandler(name) { handlers.delete(name); }
  };
  const router = new DesktopIpcRouter({ host: { query: async () => ({ ok: true }), execute: async () => ({ ok: true }) } });
  const dispose = registerElectronIpc({ ipcMain, router });
  assert.equal(typeof handlers.get(IPC_QUERY_CHANNEL), "function");
  assert.equal(typeof handlers.get(IPC_EXECUTE_CHANNEL), "function");
  assert.deepEqual(await handlers.get(IPC_QUERY_CHANNEL)(null, { name: "state" }), { ok: true });
  dispose();
  assert.equal(handlers.size, 0);
});
