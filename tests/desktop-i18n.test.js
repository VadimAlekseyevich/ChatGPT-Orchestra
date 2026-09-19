"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ManagedBrowserOnboarding } = require("../apps/desktop/renderer/managed-browser-onboarding.js");

const {
  DesktopI18n,
  CATALOGS,
  STORAGE_KEY,
  normalizeLocale,
  resolveLocale
} = require("../apps/desktop/renderer/i18n.js");

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    data
  };
}

test("desktop localization ships matching ru/en key sets", () => {
  assert.deepEqual(Object.keys(CATALOGS.ru).sort(), Object.keys(CATALOGS.en).sort());
  assert.ok(Object.keys(CATALOGS.en).length > 100);
});

test("desktop locale resolves system Russian and falls back to English", () => {
  assert.equal(normalizeLocale("ru-RU"), "ru");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("de-DE"), "en");
  assert.equal(resolveLocale({ systemLocale: "ru-RU" }), "ru");
  assert.equal(resolveLocale({ systemLocale: "fr-FR" }), "en");
});

test("explicit locale choice persists and overrides system locale", () => {
  const storage = memoryStorage();
  const first = new DesktopI18n({ storage, systemLocale: "ru-RU" });
  assert.equal(first.locale, "ru");
  first.setLocale("en");
  assert.equal(storage.data[STORAGE_KEY], "en");

  const second = new DesktopI18n({ storage, systemLocale: "ru-RU" });
  assert.equal(second.locale, "en");
});

test("desktop translator interpolates localized values and never exposes unknown raw keys", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: "ru" });
  const i18n = new DesktopI18n({ storage, systemLocale: "en-US" });
  assert.match(i18n.t("workflow.title"), /Orchestra/);
  assert.equal(i18n.t("bundle.current", { projectId: "P1" }), "Текущий проект: P1");
  assert.equal(i18n.t("missing.key", {}, "Fallback"), "Fallback");
  assert.equal(i18n.t("missing.key"), "");
});


test("Russian locale renders the managed-browser first-run action in Russian", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: "ru" });
  const i18n = new DesktopI18n({ storage, systemLocale: "en-US" });
  const root = { innerHTML: "", addEventListener() {}, removeEventListener() {} };
  const transport = { async query() { return { ok: true }; }, async execute() { return { ok: true }; } };
  const onboarding = new ManagedBrowserOnboarding({
    rootElement: root,
    transport,
    t: (key, fallback, params) => i18n.t(key, params, fallback)
  });
  onboarding.status = { availability: "unavailable", loginRequired: true, leadRegistered: false };
  onboarding.render();
  assert.match(root.innerHTML, /Шаг 1 из 4/);
  assert.match(root.innerHTML, /Открыть \/ войти в ChatGPT/);
});
