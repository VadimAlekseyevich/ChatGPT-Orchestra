const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/selectors.js");
require("../content/utils.js");
const ComposerAdapter = require("../content/composer-adapter.js");

function fakeDocument({ composer = null, sendButton = null, stopButton = null, error = null } = {}) {
  return {
    querySelectorAll(selector) {
      if (selector.includes("stop-button") || selector.includes("Stop")) {
        return stopButton ? [stopButton] : [];
      }
      if (selector.includes("prompt-textarea")) {
        return composer ? [composer] : [];
      }
      if (selector.includes("send-button") || selector.includes("composer-submit")) {
        return sendButton ? [sendButton] : [];
      }
      if (selector.includes("error")) {
        return error ? [error] : [];
      }
      return [];
    }
  };
}

test("refuses to overwrite a composer that already contains user text", async () => {
  const composer = { value: "my unsent draft" };
  const adapter = new ComposerAdapter({
    documentRef: fakeDocument({ composer }),
    windowRef: {}
  });

  const result = await adapter.sendPrompt("automatic follow-up");
  assert.deepEqual(result, { ok: false, reason: "composer_occupied" });
  assert.equal(composer.value, "my unsent draft");
});

test("reports unavailable composer explicitly", async () => {
  const adapter = new ComposerAdapter({
    documentRef: fakeDocument(),
    windowRef: {}
  });

  const result = await adapter.sendPrompt("hello");
  assert.deepEqual(result, { ok: false, reason: "composer_unavailable" });
});

test("reports generation in progress before trying to type", async () => {
  const stopButton = {};
  const adapter = new ComposerAdapter({
    documentRef: fakeDocument({ stopButton }),
    windowRef: {}
  });

  const result = await adapter.sendPrompt("hello");
  assert.deepEqual(result, { ok: false, reason: "generation_in_progress" });
});
