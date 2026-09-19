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
  assert.match(root.innerHTML, /ChatGPT is ready/);
  assert.match(root.innerHTML, /Register this ChatGPT page as Lead/);
  assert.match(root.innerHTML, /Step 2 of 4/);

  const result = await onboarding.handleAction("register");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["registerManagedBrowserLead"]);
  assert.match(root.innerHTML, /Lead connected/);
});


test("managed-browser onboarding routes blocked Google auth into the packaged companion fallback", async () => {
  const calls = [];
  const root = fakeRoot();
  const transport = {
    async query(name) {
      if (name === "managedBrowserStatus") return {
        ok: true,
        managedBrowser: {
          availability: "unavailable",
          loginRequired: true,
          leadRegistered: false,
          unsupportedAuthProvider: "google"
        }
      };
      if (name === "managedBrowserValidation") return { ok: true, validation: null };
      return { ok: false, reason: "unknown" };
    },
    async execute() { return { ok: true }; },
    async prepareCompanionFallback() {
      calls.push("prepare");
      return { ok: true, extensionId: "fixed", extensionDirectory: "C:/fallback" };
    },
    async switchRuntime(mode) {
      calls.push(["switch", mode]);
      return { ok: true, restarting: true, mode };
    },
    async openChatGPTExternal() {
      calls.push("external");
      return { ok: true };
    }
  };
  const onboarding = new ManagedBrowserOnboarding({ rootElement: root, transport });
  await onboarding.refresh();
  assert.match(root.innerHTML, /Google sign-in must continue/);
  assert.match(root.innerHTML, /Prepare and use Chrome \/ Edge fallback/);

  const result = await onboarding.handleAction("use-companion");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["prepare", ["switch", "companion"]]);
});

test("managed-browser onboarding fails closed when companion preparation is unavailable", async () => {
  const root = fakeRoot();
  const transport = {
    async query() { return { ok: true }; },
    async execute() { return { ok: true }; },
    async prepareCompanionFallback() { return { ok: false, reason: "companion_fallback_requires_packaged_runtime" }; },
    async switchRuntime() { throw new Error("must_not_switch"); }
  };
  const onboarding = new ManagedBrowserOnboarding({ rootElement: root, transport });
  onboarding.status = { availability: "unavailable", loginRequired: true, leadRegistered: false, unsupportedAuthProvider: "google" };
  const result = await onboarding.handleAction("use-companion");
  assert.equal(result.ok, false);
  assert.match(root.innerHTML, /companion_fallback_requires_packaged_runtime/);
});
