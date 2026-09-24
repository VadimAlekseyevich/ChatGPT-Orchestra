const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  ElectronManagedBrowserDriver,
  unsupportedEmbeddedAuthProvider,
  assertManagedNavigationUrl
} = require("../apps/desktop/main/electron-managed-browser-driver.js");

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = "about:blank";
    this.title = "ChatGPT";
    this.windowOpenHandler = null;
  }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  async executeJavaScript() { return { readyState: "complete", url: this.url }; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = Boolean(options.show);
    this.focused = false;
    this.destroyed = false;
    FakeBrowserWindow.instances.push(this);
  }
  async loadURL(url) {
    this.webContents.url = String(url);
    this.webContents.emit("did-navigate", {}, this.webContents.url);
  }
  show() { this.visible = true; }
  hide() { this.visible = false; this.focused = false; }
  restore() { this.visible = true; }
  focus() {
    for (const item of FakeBrowserWindow.instances) item.focused = false;
    this.focused = true;
  }
  isFocused() { return this.focused; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  getTitle() { return this.options.title || ""; }
  close() { this.destroyed = true; this.visible = false; this.focused = false; this.emit("closed"); }
  destroy() { this.close(); }
}

function harness() {
  FakeBrowserWindow.instances.length = 0;
  const fromPathCalls = [];
  const browserSession = { kind: "fake-session" };
  const externalUrls = [];
  const electronApi = {
    BrowserWindow: FakeBrowserWindow,
    session: {
      fromPath(profileDirectory, options) {
        fromPathCalls.push({ profileDirectory, options });
        return browserSession;
      }
    },
    shell: {
      async openExternal(url) {
        externalUrls.push(String(url));
      }
    }
  };
  const pageCalls = [];
  const pageAdapter = {
    async ping(webContents) {
      pageCalls.push({ type: "ping", url: webContents.getURL() });
      return { ok: true, availability: "ready", generating: false, url: webContents.getURL() };
    },
    async sendPrompt(webContents, prompt) {
      pageCalls.push({ type: "send", url: webContents.getURL(), prompt });
      return { ok: true, accepted: true, url: webContents.getURL() };
    },
    async stopGeneration(webContents) {
      pageCalls.push({ type: "stop", url: webContents.getURL() });
      return { ok: true, stopped: true, url: webContents.getURL() };
    }
  };
  const driver = new ElectronManagedBrowserDriver({ electronApi, pageAdapter });
  const profileDirectory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-electron-driver-")), "profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  return { driver, electronApi, browserSession, fromPathCalls, pageCalls, externalUrls, profileDirectory };
}

test("Electron managed driver opens a dedicated persistent Session by absolute app-data path", async () => {
  const { driver, browserSession, fromPathCalls, profileDirectory } = harness();
  await driver.start({ profileDirectory });
  assert.deepEqual(fromPathCalls, [{ profileDirectory: path.resolve(profileDirectory), options: { cache: true } }]);

  const session = await driver.createSession({ url: "https://chatgpt.com/", active: true });
  assert.match(session.id, /^electron-page-/);
  const win = FakeBrowserWindow.instances[0];
  assert.equal(win.options.webPreferences.session, browserSession);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.webSecurity, true);
  assert.equal(win.options.webPreferences.allowRunningInsecureContent, false);
  assert.equal(win.options.webPreferences.devTools, false);
  assert.deepEqual(win.webContents.windowOpenHandler({ url: "https://example.com" }), { action: "deny" });
  assert.equal(session.active, true);
  await driver.close();
});

test("managed browser navigation allows current OpenAI auth hosts and known identity providers while remaining fail-closed", () => {
  assert.equal(assertManagedNavigationUrl("about:blank"), "about:blank");
  assert.equal(assertManagedNavigationUrl("https://chatgpt.com/c/123"), "https://chatgpt.com/c/123");
  assert.equal(assertManagedNavigationUrl("https://auth.openai.com/login"), "https://auth.openai.com/login");
  assert.equal(assertManagedNavigationUrl("https://setup.auth.openai.com/login"), "https://setup.auth.openai.com/login");
  assert.equal(assertManagedNavigationUrl("https://auth0.openai.com/authorize"), "https://auth0.openai.com/authorize");
  assert.equal(assertManagedNavigationUrl("https://accounts.google.com/o/oauth2/v2/auth"), "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(unsupportedEmbeddedAuthProvider("https://accounts.google.com/o/oauth2/v2/auth"), "google");
  assert.equal(unsupportedEmbeddedAuthProvider("https://chatgpt.com/"), null);
  assert.equal(assertManagedNavigationUrl("https://appleid.apple.com/auth/authorize"), "https://appleid.apple.com/auth/authorize");
  assert.equal(assertManagedNavigationUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"), "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(assertManagedNavigationUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/"), "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/");
  assert.throws(() => assertManagedNavigationUrl("http://chatgpt.com/"), /managed_browser_navigation_forbidden/);
  assert.throws(() => assertManagedNavigationUrl("https://evilopenai.com/"), /managed_browser_navigation_forbidden/);
  assert.throws(() => assertManagedNavigationUrl("https://example.com/"), /managed_browser_navigation_forbidden/);
  assert.throws(() => assertManagedNavigationUrl("not a url"), /managed_browser_navigation_url_invalid/);
});

test("Google auth stays inside Orchestra and never opens the system browser", async () => {
  const { driver, externalUrls, profileDirectory } = harness();
  const events = [];
  await driver.start({ profileDirectory });
  driver.subscribe((event) => events.push(event));
  const session = await driver.createSession({ url: "https://chatgpt.com/auth/login", active: true });
  const win = FakeBrowserWindow.instances[0];

  assert.deepEqual(
    win.webContents.windowOpenHandler({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" }),
    { action: "deny" }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(win.webContents.getURL(), "https://chatgpt.com/auth/login");
  assert.equal(win.isVisible(), true);
  assert.deepEqual(externalUrls, []);
  assert.ok(events.some((event) => event.type === "unsupported-auth-provider" && event.provider === "google"));

  const ping = await driver.pingSession(session.id);
  assert.equal(ping.unsupportedAuthProvider, "google");

  await driver.activateSession(session.id);
  const afterReopen = await driver.pingSession(session.id);
  assert.equal(afterReopen.unsupportedAuthProvider, null);
  await driver.close();
});

test("allowlisted auth popups are redirected into the same managed window and arbitrary popups stay denied", async () => {
  const { driver, profileDirectory } = harness();
  const events = [];
  await driver.start({ profileDirectory });
  driver.subscribe((event) => events.push(event));
  const session = await driver.createSession({ url: "https://chatgpt.com/auth/login", active: true });
  const win = FakeBrowserWindow.instances[0];

  assert.deepEqual(win.webContents.windowOpenHandler({ url: "https://setup.auth.openai.com/login?flow=1" }), { action: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(win.webContents.getURL(), "https://setup.auth.openai.com/login?flow=1");
  assert.ok(events.some((event) => event.type === "auth-navigation-redirected" && event.sessionId === session.id));

  const beforeBlockedPopup = win.webContents.getURL();
  assert.deepEqual(win.webContents.windowOpenHandler({ url: "https://example.com/phish" }), { action: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(win.webContents.getURL(), beforeBlockedPopup);
  assert.ok(events.some((event) => event.type === "navigation-blocked" && event.url === "https://example.com/phish"));
  await driver.close();
});

test("driver delegates ChatGPT operations to a page adapter without exposing BrowserWindow handles", async () => {
  const { driver, pageCalls, profileDirectory } = harness();
  await driver.start({ profileDirectory });
  const session = await driver.createSession({ url: "https://chatgpt.com/c/test", active: false });
  assert.deepEqual(Object.keys(session).sort(), ["active", "id", "title", "url"]);

  assert.equal((await driver.pingSession(session.id)).ok, true);
  assert.equal((await driver.sendPrompt(session.id, "hello")).ok, true);
  assert.equal((await driver.stopGeneration(session.id)).ok, true);
  assert.deepEqual(pageCalls.map((item) => item.type), ["ping", "send", "stop"]);
  assert.equal(pageCalls[1].prompt, "hello");
  await driver.close();
});

test("activation, navigation and window close produce portable session lifecycle data", async () => {
  const { driver, profileDirectory } = harness();
  const events = [];
  await driver.start({ profileDirectory });
  driver.subscribe((event) => events.push(event));
  const session = await driver.createSession({ url: "https://chatgpt.com/", active: false });
  const active = await driver.activateSession(session.id);
  assert.equal(active.active, true);
  assert.equal((await driver.getActiveSession()).id, session.id);

  const navigated = await driver.navigateSession(session.id, "https://chatgpt.com/c/next");
  assert.equal(navigated.url, "https://chatgpt.com/c/next");
  assert.ok(events.some((event) => event.type === "session-navigation" && event.sessionId === session.id));

  FakeBrowserWindow.instances[0].close();
  assert.equal(await driver.getSession(session.id), null);
  assert.ok(events.some((event) => event.type === "session-removed" && event.reason === "window_closed"));
  await driver.close();
});

test("driver fails closed for prompt/stop when no ChatGPT page adapter is configured", async () => {
  const { electronApi, profileDirectory } = harness();
  const driver = new ElectronManagedBrowserDriver({ electronApi });
  await driver.start({ profileDirectory });
  const session = await driver.createSession({ url: "https://chatgpt.com/" });
  assert.equal((await driver.sendPrompt(session.id, "hello")).reason, "chatgpt_page_adapter_unavailable");
  assert.equal((await driver.stopGeneration(session.id)).reason, "chatgpt_page_adapter_unavailable");
  const ping = await driver.pingSession(session.id);
  assert.equal(ping.ok, true);
  assert.equal(ping.availability, "unavailable");
  await driver.close();
});