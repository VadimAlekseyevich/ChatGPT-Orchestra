(() => {
  "use strict";

  const TYPES = globalThis.ChatGPTOrchestra?.MESSAGE_TYPES || {};
  const panel = document.querySelector("main.panel");
  const header = panel?.querySelector("header");
  if (!panel || !header) return;

  const section = document.createElement("section");
  section.className = "orchestra-section";
  section.setAttribute("aria-labelledby", "companionTitle");
  section.innerHTML = `
    <div class="section-heading">
      <div>
        <h2 id="companionTitle">Desktop Companion</h2>
        <p id="companionStatus">Companion: loading…</p>
      </div>
    </div>
    <div class="actions orchestra-actions">
      <button id="enableCompanion" type="button">Enable Desktop</button>
      <button id="reconnectCompanion" class="secondary" type="button">Open / Reconnect</button>
      <button id="disableCompanion" class="secondary" type="button">Use Extension</button>
    </div>
    <p class="hint">Companion mode is explicit and fail-closed: if desktop disconnects, Orchestra will not silently resume orchestration from Chrome storage. During Phase 16, start desktop with <code>npm run desktop:companion</code>.</p>
  `;
  header.insertAdjacentElement("afterend", section);

  const statusEl = section.querySelector("#companionStatus");
  const enableButton = section.querySelector("#enableCompanion");
  const reconnectButton = section.querySelector("#reconnectCompanion");
  const disableButton = section.querySelector("#disableCompanion");

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

  enableButton.addEventListener("click", () => act(enableButton, TYPES.COMPANION_ENABLE));
  reconnectButton.addEventListener("click", () => act(reconnectButton, TYPES.COMPANION_RECONNECT));
  disableButton.addEventListener("click", () => act(disableButton, TYPES.COMPANION_DISABLE));

  refresh();
  setInterval(refresh, 3000);
})();
