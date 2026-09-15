const test = require("node:test");
const assert = require("node:assert/strict");
const Contracts = require("../platform/contracts.js");
const {
  DesktopIpcRouter,
  registerElectronIpc,
  IPC_QUERY_CHANNEL,
  IPC_EXECUTE_CHANNEL,
  ALLOWED_QUERY_NAMES,
  ALLOWED_COMMAND_NAMES
} = require("../apps/desktop/main/ipc-router.js");

test("desktop IPC router exposes only portable allowlisted query/execute DTOs", async () => {
  const calls = [];
  const host = {
    async query(name, payload) { calls.push(["query", name, payload]); return { apiVersion: 4, ok: true, state: { value: payload.value } }; },
    async execute(name, payload) { calls.push(["execute", name, payload]); return { apiVersion: 4, ok: true, result: payload }; }
  };
  const router = new DesktopIpcRouter({ host });
  const query = await router.query({ name: " state ", payload: { value: 7 } });
  const command = await router.execute({ name: " pause ", payload: { reason: "test" } });
  assert.equal(query.state.value, 7);
  assert.equal(command.result.reason, "test");
  assert.deepEqual(calls.map((item) => item.slice(0, 2)), [["query", "state"], ["execute", "pause"]]);
});

test("desktop IPC allowlists exactly mirror the portable Orchestrator API contract", () => {
  assert.deepEqual([...ALLOWED_QUERY_NAMES], [...Contracts.API_QUERIES]);
  assert.deepEqual([...ALLOWED_COMMAND_NAMES], [...Contracts.API_COMMANDS]);
});

test("unknown desktop IPC query and command names fail closed before host dispatch", async () => {
  const calls = [];
  const router = new DesktopIpcRouter({
    host: {
      async query(name) { calls.push(["query", name]); return { ok: true }; },
      async execute(name) { calls.push(["execute", name]); return { ok: true }; }
    }
  });

  assert.deepEqual(await router.query({ name: "readFile", payload: { path: "C:\\secret" } }), {
    apiVersion: 4,
    ok: false,
    reason: "desktop_ipc_query_not_allowed",
    name: "readFile"
  });
  assert.deepEqual(await router.execute({ name: "spawnShell", payload: { command: "whoami" } }), {
    apiVersion: 4,
    ok: false,
    reason: "desktop_ipc_command_not_allowed",
    name: "spawnShell"
  });
  assert.deepEqual(await router.query({}), {
    apiVersion: 4,
    ok: false,
    reason: "desktop_ipc_query_not_allowed",
    name: null
  });
  assert.deepEqual(await router.execute({ name: "   " }), {
    apiVersion: 4,
    ok: false,
    reason: "desktop_ipc_command_not_allowed",
    name: null
  });
  assert.deepEqual(calls, []);
});

test("registerElectronIpc binds and removes only the two stable generic API channels", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(name, listener) { handlers.set(name, listener); },
    removeHandler(name) { handlers.delete(name); }
  };
  const router = new DesktopIpcRouter({ host: { query: async () => ({ ok: true }), execute: async () => ({ ok: true }) } });
  const dispose = registerElectronIpc({ ipcMain, router });
  assert.deepEqual([...handlers.keys()].sort(), [IPC_EXECUTE_CHANNEL, IPC_QUERY_CHANNEL].sort());
  assert.deepEqual(await handlers.get(IPC_QUERY_CHANNEL)(null, { name: "state" }), { ok: true });
  dispose();
  assert.equal(handlers.size, 0);
});
