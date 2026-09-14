const test = require("node:test");
const assert = require("node:assert/strict");

const { ManagedBrowserOnboarding } = require("../apps/desktop/renderer/managed-browser-onboarding.js");

function rootElement() {
  return {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {}
  };
}

test("onboarding panel stays hidden outside managed-browser runtime", async () => {
  const root = rootElement();
  const transport = {
    async query() { return { ok: false, reason: "unknown_api_query" }; },
    async execute() { throw new Error("unexpected_execute"); }
  };
  const onboarding = new ManagedBrowserOnboarding({ rootElement: root, transport });
  await onboarding.refresh();
  assert.equal(root.innerHTML, "");
});

test("managed-browser onboarding explains isolated login and opens ChatGPT without storing credentials", async () => {
  const root = rootElement();
  const calls = [];
  let status = {
    runtimeKind: "desktop-managed-browser",
    sessionOpen: true,
    availability: "unavailable",
    loginRequired: true,
    leadRegistered: false
  };
  const transport = {
    async query(name) { calls.push(["query", name]); return { ok: true, managedBrowser: { ...status } }; },
    async execute(name) { calls.push(["execute", name]); return { ok: true }; }
  };
  const onboarding = new ManagedBrowserOnboarding({ rootElement: root, transport });
  await onboarding.refresh();
  assert.match(root.innerHTML, /Login required/);
  assert.match(root.innerHTML, /isolated browser profile/);
  assert.match(root.innerHTML, /not copied into Orchestra state/);
  assert.match(root.innerHTML, /Open \/ Login to ChatGPT/);

  await onboarding.handleAction("open");
  assert.equal(calls.some((item) => item[0] === "execute" && item[1] === "openManagedBrowser"), true);
});

test("onboarding offers Lead registration only after ChatGPT composer becomes ready", async () => {
  const root = rootElement();
  const calls = [];
  let status = {
    runtimeKind: "desktop-managed-browser",
    sessionOpen: true,
    availability: "ready",
    loginRequired: false,
    leadRegistered: false
  };
  const transport = {
    async query() { return { ok: true, managedBrowser: { ...status } }; },
    async execute(name) {
      calls.push(name);
      if (name === "registerManagedBrowserLead") status = { ...status, leadRegistered: true, leadAgentId: "A1", leadStatus: "IDLE" };
      return { ok: true };
    }
  };
  const onboarding = new ManagedBrowserOnboarding({ rootElement: root, transport });
  await onboarding.refresh();
  assert.match(root.innerHTML, /ChatGPT ready/);
  assert.match(root.innerHTML, /Register this ChatGPT page as Lead/);

  const result = await onboarding.handleAction("register");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["registerManagedBrowserLead"]);
  assert.match(root.innerHTML, /Lead connected/);
});
