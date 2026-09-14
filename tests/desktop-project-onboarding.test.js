"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DesktopProjectOnboarding,
  MODE_LOCAL,
  MODE_CLONE
} = require("../apps/desktop/renderer/desktop-project-onboarding.js");

function fakeRoot() {
  return {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {}
  };
}

function changeEvent(dataset, value, extra = {}) {
  return { target: { dataset: { ...dataset }, value, ...extra, hasAttribute(name) {
    if (name === "data-project-trust") return Object.prototype.hasOwnProperty.call(dataset, "projectTrust");
    if (name === "data-project-workers") return Object.prototype.hasOwnProperty.call(dataset, "projectWorkers");
    return false;
  } } };
}

test("desktop first-project onboarding opens a local repository, optionally trusts it and starts planning", async () => {
  let project = null;
  const calls = [];
  const transport = {
    async query(name) {
      assert.equal(name, "dashboard");
      return { ok: true, dashboard: { project } };
    },
    async selectRepositoryDirectory() {
      return { ok: true, cancelled: false, path: "C:\\Projects\\Widget" };
    },
    async execute(name, payload) {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === "openLocalRepository") return { ok: true, repository: { repositoryId: payload.repositoryId, path: payload.path, trust: "UNTRUSTED" } };
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

  await app.browse();
  assert.equal(app.form.repositoryPath, "C:\\Projects\\Widget");
  app.form.mode = MODE_LOCAL;
  app.form.repositoryUrl = "https://github.com/acme/widget";
  app.form.goal = "Implement the requested feature and verify it end to end.";
  app.form.trust = true;

  const result = await app.startProject();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((item) => item.name), ["openLocalRepository", "setRepositoryTrust", "startProject"]);
  assert.equal(calls[0].payload.path, "C:\\Projects\\Widget");
  assert.equal(calls[1].payload.trust, "TRUSTED");
  assert.equal(calls[2].payload.repositoryUrl, "https://github.com/acme/widget");
  assert.equal(calls[2].payload.repositoryId, calls[0].payload.repositoryId);
  assert.match(root.innerHTML, /Lead is planning the project/);
});

test("desktop first-project onboarding clones a GitHub repository before starting the project", async () => {
  let project = null;
  const calls = [];
  const transport = {
    async query() { return { ok: true, dashboard: { project } }; },
    async execute(name, payload) {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === "cloneRepository") return { ok: true, repository: { repositoryId: payload.repositoryId, sourceUrl: payload.url } };
      if (name === "startProject") {
        project = { projectId: "P2", status: "PLANNING", stage: "DISCOVERY" };
        return { ok: true, project };
      }
      return { ok: false, reason: "unexpected_command" };
    }
  };

  const app = new DesktopProjectOnboarding({ rootElement: fakeRoot(), transport });
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
    async query() { return { ok: true, dashboard: { project } }; },
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
  assert.match(root.innerHTML, /Planning complete/);
  assert.match(root.innerHTML, /Start Execution/);

  app.handleChange(changeEvent({ projectWorkers: "" }, "2"));
  assert.equal(app.form.maxWorkers, 2);
  const result = await app.startExecution();
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], { name: "startExecution", payload: { maxWorkers: 2 } });
  assert.equal(root.innerHTML, "");
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
