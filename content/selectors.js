(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  root.SELECTORS = Object.freeze({
    stopButtons: Object.freeze([
      'button[data-testid="stop-button"]',
      '[role="button"][data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label*="Stop" i][data-testid]'
    ]),
    assistantMessages: Object.freeze([
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-message-author="assistant"]',
      '[data-testid^="conversation-turn-"][data-turn="assistant"]',
      '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
      'article[data-turn="assistant"]',
      'section[data-turn="assistant"]',
      'article[data-message-author-role="assistant"]'
    ]),
    assistantBodies: Object.freeze([
      '.markdown',
      '.prose',
      '[class*="markdown"]',
      '[data-message-content]'
    ]),
    composers: Object.freeze([
      '#prompt-textarea',
      'textarea[name="prompt-textarea"]',
      'textarea#prompt-textarea'
    ]),
    sendButtons: Object.freeze([
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button.composer-submit-btn'
    ]),
    retryButtons: Object.freeze([
      'button[data-testid="regenerate-button"]',
      'button[aria-label*="Retry" i]',
      'button[aria-label*="Regenerate" i]'
    ]),
    errorIndicators: Object.freeze([
      '[data-testid*="error" i][role="alert"]',
      '[data-testid="conversation-turn-error"]',
      '[role="alert"][class*="error" i]'
    ])
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.SELECTORS;
  }
})();
