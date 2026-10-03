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


test("managed-browser onboarding keeps blocked Google auth inside Orchestra", async () => {
  const calls = [];
  const root = rootElement();
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
    async execute(name) { calls.push(name); return { ok: true }; },
    async openChatGPTExternal() { throw new Error("external_browser_must_not_open"); },
    async switchRuntime() { throw new Error("runtime_must_not_switch"); }
  };
  const onboarding = new ManagedBrowserOnboarding({ rootElement: root, transport });
  await onboarding.refresh();

  assert.match(root.innerHTML, /Google sign-in is unavailable inside embedded browsers/);
  assert.match(root.innerHTML, /will not open an external browser/);
  assert.doesNotMatch(root.innerHTML, /Chrome \/ Edge extension runtime/);

  const result = await onboarding.handleAction("open");
  assert.equal(result?.ok, undefined);
  assert.deepEqual(calls, ["openManagedBrowser"]);
});

test("diagnostics disclosure remains open across polling renders", () => {
  const root = rootElement();
  root.querySelector = (selector) => selector === ".managed-browser-validation" ? { open: true } : null;
  const onboarding = new ManagedBrowserOnboarding({
    rootElement: root,
    transport: {
      async query() { return { ok: true }; },
      async execute() { return { ok: true }; }
    }
  });
  onboarding.status = { availability: "ready", loginRequired: false, leadRegistered: true, leadStatus: "IDLE" };
  onboarding.validation = { complete: false, checks: {} };
  onboarding.render();
  assert.equal(onboarding.validationOpen, true);
  assert.match(root.innerHTML, /managed-browser-validation" open/);
});


test("registered Lead is not presented as connected when current ChatGPT composer is unavailable", () => {
  const root = rootElement();
  const onboarding = new ManagedBrowserOnboarding({
    rootElement: root,
    transport: {
      async query() { return { ok: true }; },
      async execute() { return { ok: true }; }
    }
  });
  onboarding.status = {
    availability: "unavailable",
    loginRequired: true,
    leadRegistered: true,
    leadReady: false,
    leadStatus: "ERROR"
  };
  onboarding.render();
  assert.match(root.innerHTML, /Lead registered, but ChatGPT is not ready/);
  assert.match(root.innerHTML, /Open \/ Login to ChatGPT/);
  assert.doesNotMatch(root.innerHTML, /<strong>Lead connected<\/strong>/);
});