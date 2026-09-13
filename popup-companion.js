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
        <p id="companionMigrationStatus">Migration: not staged</p>
      </div>
    </div>
    <div class="actions orchestra-actions">
      <button id="migrateCompanionProject" class="secondary" type="button">Migrate Project → Desktop</button>
      <button id="enableCompanion" type="button">Enable Desktop</button>
      <button id="reconnectCompanion" class="secondary" type="button">Open / Reconnect</button>
      <button id="disableCompanion" class="secondary" type="button">Use Extension</button>
    </div>
    <p class="hint">For an existing extension project: pause/stop to a safe point, start desktop with <code>npm run desktop:companion</code>, stage the migration, restart desktop so SQLite applies it, then enable Desktop. Bridge loss is fail-closed and never silently reactivates Chrome-storage orchestration.</p>
  `;
  header.insertAdjacentElement("afterend", section);

  const statusEl = section.querySelector("#companionStatus");
  const migrationStatusEl = section.querySelector("#companionMigrationStatus");
  const migrateButton = section.querySelector("#migrateCompanionProject");
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
    migrateButton.disabled = companion.enabled === true;
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
    else if (response?.reason === "companion_enable_requires_project_migration") {
      statusEl.textContent = "Companion: project migration required before cutover";
    } else {
      statusEl.textContent = `Companion error: ${response?.reason || response?.message || "unknown"}`;
    }
    await refresh();
    return response;
  }

  async function migrateProject() {
    migrateButton.disabled = true;
    migrationStatusEl.textContent = "Migration: exporting and staging…";
    const response = await send(TYPES.COMPANION_MIGRATE_PROJECT);
    if (response?.ok) {
      migrationStatusEl.textContent = `Migration staged: ${response.projectId}. Restart Desktop Companion, then click Enable Desktop.`;
    } else if (response?.reason === "companion_migration_requires_safe_point") {
      migrationStatusEl.textContent = `Migration blocked: recovery is ${response.recoveryStatus}. Pause or Stop Now first.`;
    } else {
      migrationStatusEl.textContent = `Migration error: ${response?.reason || response?.message || "unknown"}`;
    }
    await refresh();
  }

  migrateButton.addEventListener("click", migrateProject);
  enableButton.addEventListener("click", () => act(enableButton, TYPES.COMPANION_ENABLE));
  reconnectButton.addEventListener("click", () => act(reconnectButton, TYPES.COMPANION_RECONNECT));
  disableButton.addEventListener("click", () => act(disableButton, TYPES.COMPANION_DISABLE));

  refresh();
  setInterval(refresh, 3000);
})();
