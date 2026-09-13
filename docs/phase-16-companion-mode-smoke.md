# Phase 16 Companion Mode Smoke Checklist

Use this checklist only after the Native Messaging host is registered for the unpacked/installed extension id.

1. Start the desktop control plane with `npm run desktop:companion`.
2. Open the extension popup with no active standalone extension project.
3. Click **Enable Desktop**.
4. Confirm popup status becomes `Companion: CONNECTED`.
5. Register the active ChatGPT tab as Lead from the existing popup controls.
6. Confirm the desktop Dashboard shows the same logical Lead and SQLite persistence.
7. Create one Worker and confirm the browser tab is created by the extension while the desktop owns orchestration state.
8. Close/reopen the popup and confirm companion mode remains enabled.
9. Stop the native relay/desktop connection and confirm popup/API operations return `companion_disconnected`; no extension scheduler dispatch should occur.
10. Restart desktop companion mode and use **Open / Reconnect**; confirm the bridge returns to `CONNECTED`.
11. Disable companion mode only for a fresh/no-project test state; confirm standalone extension controls work again.

Migration gate check:

1. In standalone extension mode, create or load an active project.
2. Click **Enable Desktop**.
3. Confirm the switch is rejected with `companion_enable_requires_project_migration` and standalone extension orchestration remains active.

Do not use active production projects for companion cutover until the migration wizard is implemented.
