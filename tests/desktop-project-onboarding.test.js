"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DesktopProjectOnboarding,
  MODE_LOCAL,
  MODE_CLONE,
  TERMINAL_PROJECT_STATUSES,
  repositoryPreparationKey
} = require("../apps/desktop/renderer/desktop-project-onboarding.js");

function fakeRoot() {
  return {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {}
  };
}

function readyLead() {
  return [{ agentId: "L1", role: "lead", connected: true, status: "IDLE", label: "Lead" }];
}

function changeEvent(dataset, value, extra = {}) {
  return { target: { dataset: { ...dataset }, value, ...extra, hasAttribute(name) {
    if (name === "data-project-trust") return Object.prototype.hasOwnProperty.call(dataset, "projectTrust");
    if (name === "data-project-workers") return Object.prototype.hasOwnProperty.call(dataset, "projectWorkers");
    return false;
  } } };
}

test("desktop project onboarding waits for a connected IDLE Lead before showing project controls", async () => {
  let agents = [];
  const transport = {
    async query() { return { ok: true, dashboard: { project: null, agents } }; },
    async execute() { throw new Error("execute_must_not_run_without_lead"); }
  };
  const root = fakeRoot();
  const app = new DesktopProjectOnboarding({ rootElement: root, transport });

  await app.refresh();
  assert.match(root.innerHTML, /WAITING FOR LEAD/);
  assert.match(root.innerHTML, /Connect the Lead before starting a project/);
  assert.doesNotMatch(root.innerHTML, /Start Project/);

  app.form.repositoryPath = "C:\\Projects\\Widget";
  app.form.goal = "Implement the requested feature with tests.";
  const rejected = await app.startProject();
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /Lead/);

  agents = readyLead();
  await app.refresh();
  assert.match(root.innerHTML, /Start your first project/);
  assert.match(root.innerHTML, /Start planning/);
});

test("desktop first-project onboarding opens a local repository, auto-detects GitHub origin, trusts it and starts planning", async () => {
  let project = null;
  const calls = [];
  const transport = {
    async query(name) {
      assert.equal(name, "dashboard");
      return { ok: true, dashboard: { project, agents: readyLead() } };
    },
    async selectRepositoryDirectory() {
      return { ok: true, cancelled: false, path: "C:\\Projects\\Widget" };
    },
    async execute(name, payload) {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === "openLocalRepository") return { ok: true, repository: { repositoryId: payload.repositoryId, path: payload.path, trust: "UNTRUSTED" }, repositoryUrl: "https://github.com/acme/widget" };
      if (name === "setRepositoryTrust") return { ok: true, repository: { repositoryId: payload.repositoryId, trust: payload.trust } };
      if (name === "startProject") {
        project = { projectId: "P1", status: "PLANNING", stage: "DISCOVERY", goal: payload.goal, repositoryRuntime: { repositoryId: payload.repositoryId } };
        return { ok: true, project };
      }
      return { ok: false, reason: "unexpected_command" };
    }
  };

  const root = fakeRoot();
  const app = new DesktopProjectOnboarding({ rootElement: root, transport });
  await app.refresh();
  assert.match(root.innerHTML, /Start your first project/);
  assert.match(root.innerHTML, /Open local repository/);
  assert.match(root.innerHTML, /auto-detected from origin/);

  await app.browse();
  assert.equal(app.form.repositoryPath, "C:\\Projects\\Widget");
  app.form.mode = MODE_LOCAL;
  app.form.goal = "Implement the requested feature and verify it end to end.";
  app.form.trust = true;

  const result = await app.startProject();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((item) => item.name), ["openLocalRepository", "setRepositoryTrust", "startProject"]);
  assert.equal(calls[0].payload.path, "C:\\Projects\\Widget");
  assert.equal(calls[1].payload.trust, "TRUSTED");
  assert.equal(calls[2].payload.repositoryUrl, "https://github.com/acme/widget");
  assert.equal(calls[2].payload.repositoryId, calls[0].payload.repositoryId);
  assert.equal(app.form.repositoryUrl, "https://github.com/acme/widget");
  assert.match(root.innerHTML, /Lead is planning the project/);
});

test("local repository without detectable GitHub origin can reuse preparation after manual URL entry", async () => {
  let project = null;
  const calls = [];
  const transport = {
    async query() { return { ok: true, dashboard: { project, agents: readyLead() } }; },
    async execute(name, payload) {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === "openLocalRepository") return { ok: true, repository: { repositoryId: payload.repositoryId }, repositoryUrl: null };
      if (name === "startProject") {
        project = { projectId: "P-local", status: "PLANNING", stage: "DISCOVERY" };
        return { ok: true, project };
      }
      return { ok: false, reason: "unexpected_command" };
    }
  };
  const root = fakeRoot();
  const app = new DesktopProjectOnboarding({ rootElement: root, transport });
  app.agents = readyLead();
  app.form.mode = MODE_LOCAL;
  app.form.repositoryPath = "C:\\Projects\\NoOrigin";
  app.form.goal = "Plan and implement the requested local repository change.";

  const first = await app.startProject();
  assert.equal(first.ok, false);
  assert.match(first.reason, /No GitHub origin was detected/);
  assert.deepEqual(calls.map((item) => item.name), ["openLocalRepository"]);

  const preparedId = calls[0].payload.repositoryId;
  app.form.repositoryUrl = "https://github.com/acme/no-origin";
  app.handleInput({ target: { dataset: { projectField: "repositoryUrl" }, value: app.form.repositoryUrl } });
  const second = await app.startProject();
  assert.equal(second.ok, true);
  assert.deepEqual(calls.map((item) => item.name), ["openLocalRepository", "startProject"]);
  assert.equal(calls[1].payload.repositoryId, preparedId);
  assert.equal(calls[1].payload.repositoryUrl, "https://github.com/acme/no-origin");
});

test("local repository preparation identity ignores optional canonical URL while clone identity follows URL", () => {
  const localA = repositoryPreparationKey({ mode: MODE_LOCAL, repositoryPath: "C:\\Repo", repositoryUrl: "" });
  const localB = repositoryPreparationKey({ mode: MODE_LOCAL, repositoryPath: "C:\\Repo", repositoryUrl: "https://github.com/acme/repo" });
  assert.equal(localA, localB);
  assert.notEqual(
    repositoryPreparationKey({ mode: MODE_CLONE, repositoryUrl: "https://github.com/acme/a" }),
    repositoryPreparationKey({ mode: MODE_CLONE, repositoryUrl: "https://github.com/acme/b" })
  );
});

test("desktop first-project onboarding clones a GitHub repository before starting the project", async () => {
  let project = null;
  const calls = [];
  const transport = {
    async query() { return { ok: true, dashboard: { project, agents: readyLead() } }; },
    async execute(name, payload) {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === "cloneRepository") return { ok: true, repository: { repositoryId: payload.repositoryId, sourceUrl: payload.url }, repositoryUrl: "https://github.com/acme/widget" };
      if (name === "startProject") {
        project = { projectId: "P2", status: "PLANNING", stage: "DISCOVERY" };
        return { ok: true, project };
      }
      return { ok: false, reason: "unexpected_command" };
    }
  };

  const app = new DesktopProjectOnboarding({ rootElement: fakeRoot(), transport });
  app.agents = readyLead();
  app.form.mode = MODE_CLONE;
  app.form.repositoryUrl = "https://github.com/acme/widget.git";
  app.form.goal = "Build the requested feature with tests and integration evidence.";
  const result = await app.startProject();

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((item) => item.name), ["cloneRepository", "startProject"]);
  assert.equal(calls[0].payload.url, "https://github.com/acme/widget.git");
  assert.equal(calls[1].payload.repositoryUrl, "https://github.com/acme/widget");
  assert.equal(calls[1].payload.repositoryId, calls[0].payload.repositoryId);
});

test("READY project exposes Start Execution and forwards selected Worker concurrency", async () => {
  const calls = [];
  let project = { projectId: "P3", status: "READY", stage: "READY" };
  const transport = {
    async query() { return { ok: true, dashboard: { project, agents: readyLead() } }; },
    async execute(name, payload) {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === "startExecution") {
        project = { projectId: "P3", status: "RUNNING", stage: "EXECUTION" };
        return { ok: true };
      }
      return { ok: false, reason: "unexpected_command" };
    }
  };
  const root = fakeRoot();
  const app = new DesktopProjectOnboarding({ rootElement: root, transport });
  await app.refresh();
  assert.match(root.innerHTML, /Step 4 of 4/);
  assert.match(root.innerHTML, /Start execution/);

  app.handleChange(changeEvent({ projectWorkers: "" }, "2"));
  assert.equal(app.form.maxWorkers, 2);
  const result = await app.startExecution();
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], { name: "startExecution", payload: { maxWorkers: 2 } });
  assert.equal(root.innerHTML, "");
});

test("terminal project exposes Start another project and resets repository form without deleting history", async () => {
  for (const status of TERMINAL_PROJECT_STATUSES) {
    const project = { projectId: `P-${status}`, status, stage: status };
    const transport = {
      async query() { return { ok: true, dashboard: { project, agents: readyLead() } }; },
      async execute() { return { ok: false, reason: "unexpected_command" }; }
    };
    const root = fakeRoot();
    const app = new DesktopProjectOnboarding({ rootElement: root, transport });
    await app.refresh();
    assert.match(root.innerHTML, /Start another project/);
    app.form.goal = "old goal that must be reset";
    app.preparedRepository = { repositoryId: "old-repo", key: "old" };

    const reset = app.resetForNewProject();
    assert.equal(reset.ok, true);
    assert.equal(app.project.projectId, `P-${status}`);
    assert.equal(app.newProjectRequested, true);
    assert.equal(app.form.goal, "");
    assert.equal(app.preparedRepository, null);
    assert.match(root.innerHTML, /Start another project/);
    assert.match(root.innerHTML, /Start planning/);
  }
});

test("desktop shell wires the project onboarding script and a narrow native directory picker bridge", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "renderer", "renderer.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "main", "electron-main.js"), "utf8");

  assert.match(html, /id="desktopProjectOnboarding"/);
  assert.match(html, /desktop-project-onboarding\.js/);
  assert.match(renderer, /DesktopProjectOnboarding/);
  assert.match(preload, /selectRepositoryDirectory/);
  assert.match(preload, /orchestra:select-repository-directory/);
  assert.match(main, /showOpenDialog/);
  assert.match(main, /properties: \["openDirectory"\]/);
  assert.doesNotMatch(preload, /require\("node:fs"\)/);
});
