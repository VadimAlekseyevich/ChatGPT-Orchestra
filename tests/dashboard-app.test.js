const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { FakeDashboardTransport, defaultDashboard } = require("../dashboard/fake-transport.js");
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

function clickEvent(action, dataset = {}) {
  return {
    target: {
      closest() {
        return { disabled: false, dataset: { dashboardAction: action, ...dataset } };
      }
    }
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

test("Dashboard disables recovery Resume while Lead is actively generating planning", async () => {
  const dashboard = defaultDashboard();
  dashboard.project.status = "PLANNING";
  dashboard.project.stage = "PLAN_V1";
  dashboard.recovery.status = "RECOVERY_REQUIRED";
  dashboard.agents = [{
    agentId: "lead-1",
    role: "lead",
    connected: true,
    status: "BUSY",
    label: "Lead"
  }];

  const root = fakeRoot();
  const transport = {
    async query(name) {
      if (name === "dashboard") return { ok: true, dashboard: structuredClone(dashboard) };
      return { ok: false, reason: "unknown_api_query" };
    },
    async execute() { return { ok: false, reason: "must_not_resume_active_planning" }; }
  };
  const app = new DashboardApp({ rootElement: root, transport });
  await app.refresh();

  assert.match(root.innerHTML, /data-dashboard-action="resume" disabled/);
  assert.match(root.innerHTML, /BUSY/);
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

test("Dashboard requires explicit confirmation before trusting a local repository and can disable execution", async () => {
  const dashboard = defaultDashboard();
  dashboard.project.repositoryRuntime = { repositoryId: "repo-1" };
  let trust = "UNTRUSTED";
  const mutations = [];
  let confirmed = false;
  const transport = {
    async query(name, payload = {}) {
      if (name === "dashboard") return { ok: true, dashboard: structuredClone(dashboard) };
      if (name === "repository") {
        assert.equal(payload.repositoryId, "repo-1");
        return { ok: true, repository: { repositoryId: "repo-1", trust } };
      }
      return { ok: false, reason: "unknown_api_query" };
    },
    async execute(name, payload = {}) {
      mutations.push({ name, payload: structuredClone(payload) });
      if (name !== "setRepositoryTrust") return { ok: false, reason: "unknown_api_command" };
      trust = payload.trust;
      return { ok: true, repository: { repositoryId: payload.repositoryId, trust } };
    }
  };
  const root = fakeRoot();
  const app = new DashboardApp({ rootElement: root, transport, confirmAction: () => confirmed });
  await app.refresh();
  assert.match(root.innerHTML, /Local execution/);
  assert.match(root.innerHTML, /UNTRUSTED/);
  assert.match(root.innerHTML, /Enable Local Execution/);

  await app.handleClick(clickEvent("enableLocalExecution", { repositoryId: "repo-1" }));
  assert.equal(mutations.length, 0);
  assert.equal(trust, "UNTRUSTED");

  confirmed = true;
  await app.handleClick(clickEvent("enableLocalExecution", { repositoryId: "repo-1" }));
  assert.deepEqual(mutations.at(-1), { name: "setRepositoryTrust", payload: { repositoryId: "repo-1", trust: "TRUSTED" } });
  assert.equal(trust, "TRUSTED");
  assert.match(root.innerHTML, /Disable Local Execution/);

  await app.handleClick(clickEvent("disableLocalExecution", { repositoryId: "repo-1" }));
  assert.deepEqual(mutations.at(-1), { name: "setRepositoryTrust", payload: { repositoryId: "repo-1", trust: "UNTRUSTED" } });
  assert.equal(trust, "UNTRUSTED");
  assert.match(root.innerHTML, /Enable Local Execution/);
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
