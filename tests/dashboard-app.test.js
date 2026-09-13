const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { FakeDashboardTransport } = require("../dashboard/fake-transport.js");
const { DashboardApp, attributeSelector } = require("../dashboard/dashboard-app.js");
const { ExtensionDashboardTransport } = require("../dashboard/extension-transport.js");
const MESSAGE_TYPES = require("../content/message-types.js");

function fakeRoot() {
  return {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; }
  };
}

test("same Dashboard frontend renders through Fake Orchestrator API without Chrome globals", async () => {
  const previousChrome = globalThis.chrome;
  try {
    delete globalThis.chrome;
    const root = fakeRoot();
    const transport = new FakeDashboardTransport();
    const app = new DashboardApp({ rootElement: root, transport, pollMs: 60_000 });
    await app.refresh();
    assert.match(root.innerHTML, /Dashboard/);
    assert.match(root.innerHTML, /Foundation/);
    assert.match(root.innerHTML, /Agent health/);
    assert.match(root.innerHTML, /Scheduler explanation/);
    assert.match(root.innerHTML, /Integration evidence/);
    assert.match(root.innerHTML, /Active roles/);
  } finally {
    if (previousChrome !== undefined) globalThis.chrome = previousChrome;
  }
});

test("Dashboard command path works with Fake transport and refreshes DTO", async () => {
  const root = fakeRoot();
  const transport = new FakeDashboardTransport();
  const app = new DashboardApp({ rootElement: root, transport });
  await app.refresh();
  const result = await app.command("pause");
  assert.equal(result.ok, true);
  assert.equal(app.dashboard.recovery.status, "PAUSED");
  assert.match(root.innerHTML, /PAUSED/);
});

test("Dashboard exposes command errors while retaining current view", async () => {
  const root = fakeRoot();
  const transport = new FakeDashboardTransport();
  const app = new DashboardApp({ rootElement: root, transport });
  await app.refresh();
  const result = await app.command("not-a-command");
  assert.equal(result.ok, false);
  assert.match(root.innerHTML, /not-a-command: unknown_api_command/);
  assert.match(root.innerHTML, /Tasks \/ DAG/);
});

test("standalone host loads same DashboardApp with Fake transport", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "dashboard", "standalone.html"), "utf8");
  const bootstrap = fs.readFileSync(path.join(__dirname, "..", "dashboard", "standalone.js"), "utf8");
  assert.match(html, /fake-transport\.js/);
  assert.match(html, /dashboard-app\.js/);
  assert.match(html, /standalone\.js/);
  assert.doesNotMatch(html, /<script>\s*const transport/);
  assert.match(bootstrap, /FakeDashboardTransport/);
  assert.match(bootstrap, /DashboardApp/);
  assert.doesNotMatch(html + bootstrap, /chrome\.runtime/);
});

test("Extension Dashboard transport maps query/execute to generic API messages", async () => {
  const messages = [];
  const runtime = {
    sendMessage(message, callback) {
      messages.push(message);
      callback({ ok: true });
    }
  };
  const previousChrome = globalThis.chrome;
  try {
    globalThis.chrome = { runtime: { lastError: null } };
    const transport = new ExtensionDashboardTransport({ runtime, messageTypes: MESSAGE_TYPES });
    assert.equal((await transport.query("dashboard", { eventLimit: 5 })).ok, true);
    assert.equal((await transport.execute("pause")).ok, true);
    assert.deepEqual(messages[0], { type: MESSAGE_TYPES.ORCHESTRATOR_API_QUERY, payload: { name: "dashboard", payload: { eventLimit: 5 } } });
    assert.deepEqual(messages[1], { type: MESSAGE_TYPES.ORCHESTRATOR_API_EXECUTE, payload: { name: "pause", payload: {} } });
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("portable attribute selector does not require CSS.escape", () => {
  const previous = globalThis.CSS;
  try {
    delete globalThis.CSS;
    assert.equal(attributeSelector("data-task", 'T"1'), '[data-task="T\\"1"]');
  } finally {
    if (previous !== undefined) globalThis.CSS = previous;
  }
});
