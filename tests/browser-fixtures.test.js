const test = require("node:test");
const assert = require("node:assert/strict");
const fixtures = require("./fixtures/chatgpt-states.json");
const ComposerAdapter = require("../content/composer-adapter.js");

function element({ value = "", disabled = false } = {}) {
  return {
    value,
    disabled,
    textContent: value,
    innerText: value,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    dispatchEvent() {},
    focus() {},
    click() {}
  };
}

function documentFromHtml(html) {
  const source = String(html || "");
  const textareaMatch = source.match(/<textarea[^>]*id=["']prompt-textarea["'][^>]*>([\s\S]*?)<\/textarea>/i);
  const composer = textareaMatch ? element({ value: textareaMatch[1] || "" }) : null;
  const stop = /data-testid=["']stop-button["']/i.test(source) ? element() : null;
  const send = /data-testid=["']send-button["']/i.test(source) ? element() : null;
  const error = /data-testid=["']conversation-turn-error["']/i.test(source) ? element() : null;
  return {
    querySelectorAll(selector) {
      if (/prompt-textarea/.test(selector)) return composer ? [composer] : [];
      if (/stop-button|Stop streaming|Stop generating/.test(selector)) return stop ? [stop] : [];
      if (/send-button|composer-submit-button|Send prompt|composer-submit-btn/.test(selector)) return send ? [send] : [];
      if (/error|conversation-turn-error/.test(selector)) return error ? [error] : [];
      return [];
    }
  };
}

const windowRef = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };

test("Phase 14 browser fixture matrix contains all required ChatGPT states", () => {
  assert.deepEqual(Object.keys(fixtures).sort(), [
    "completed",
    "composerOccupied",
    "error",
    "generating",
    "idle",
    "loginRequired",
    "navigationChanged"
  ]);
});

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`ComposerAdapter classifies ${name} fixture`, () => {
    const adapter = new ComposerAdapter({ documentRef: documentFromHtml(fixture.html), windowRef });
    assert.equal(adapter.getAvailability(), fixture.availability);
    if (fixture.occupied) assert.equal(adapter.isComposerOccupied(), true);
    if (name === "generating") assert.equal(adapter.isGenerating(), true);
  });
}

test("fixture corpus includes assistant completion and navigation baseline evidence", () => {
  assert.match(fixtures.completed.html, /data-turn=["']assistant["']/);
  assert.match(fixtures.completed.html, /DONE/);
  assert.match(fixtures.navigationChanged.html, /data-conversation-path=["']\/c\/new-chat["']/);
});
