(() => {
  "use strict";

  const TYPES = globalThis.ChatGPTOrchestra?.MESSAGE_TYPES || {};
  const statusEl = document.querySelector("#companionStatus");
  const enableButton = document.querySelector("#enableCompanion");
  const reconnectButton = document.querySelector("#reconnectCompanion");
  const disableButton = document.querySelector("#disableCompanion");
  if (!statusEl) return;

  async function send(type) {
    try {
      return await chrome.runtime.sendMessage({ type });
    } catch (error) {
      return { ok: false, reason: "companion_control_unavailable", message: error?.message || String(error) };
    }
  }

  function render(response) {
    const companion = response?.companion || {};
    const state = companion.state || (companion.enabled ? "DISCONNECTED" : "DISABLED");
    const transport = companion.transport?.kind ? ` · ${companion.transport.kind}` : "";
    const error = companion.lastError ? ` · ${companion.lastError}` : "";
    statusEl.textContent = `Companion: ${state}${transport}${error}`;
    enableButton.disabled = companion.enabled === true;
    reconnectButton.disabled = companion.enabled !== true;
    disableButton.disabled = companion.enabled !== true;
  }

  async function refresh() {
    const response = await send(TYPES.COMPANION_GET_STATUS);
    if (!response?.ok) {
      statusEl.textContent = `Companion error: ${response?.reason || "unknown"}`;
      return response;
    }
    render(response);
    return response;
  }

  async function act(button, type) {
    button.disabled = true;
    statusEl.textContent = "Companion: updating…";
    const response = await send(type);
    if (response?.ok) render(response);
    else statusEl.textContent = `Companion error: ${response?.reason || response?.message || "unknown"}`;
    await refresh();
  }

  enableButton?.addEventListener("click", () => act(enableButton, TYPES.COMPANION_ENABLE));
  reconnectButton?.addEventListener("click", () => act(reconnectButton, TYPES.COMPANION_RECONNECT));
  disableButton?.addEventListener("click", () => act(disableButton, TYPES.COMPANION_DISABLE));

  refresh();
  setInterval(refresh, 3000);
})();
