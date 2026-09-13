# Phase 11 Smoke Test — Portable Persistence

## Automated gate

```powershell
git pull
npm test
npm run test:phase11
```

On Node versions without `node:sqlite`, SQLite-specific tests may be reported as skipped. For the full Phase 11 migration gate use a Node version that exposes `node:sqlite` (Node 22+ recommended).

## Extension export

1. Reload ChatGPT Orchestra from `edge://extensions/`.
2. Refresh ChatGPT tabs so the current content scripts are active.
3. Open or create a project and let Orchestra persist some project/task/review state.
4. Open the popup.
5. Verify `Persistence: schema 1 · chrome.storage.local` is shown.
6. Click **Export Bundle**.
7. Verify a file named approximately `chatgpt-orchestra-<projectId>.bundle.json` is downloaded.
8. Open the JSON file locally and verify:
   - `format` is `chatgpt-orchestra-project-bundle`;
   - `bundleVersion` is `1`;
   - `schemaVersion` is `1`;
   - `manifest.projectId` matches the project;
   - `manifest.checksum` is present;
   - no `tabId`, `legacyTabId` or `sessionId` is required in `state`;
   - agent runtime bindings are absent;
   - obvious credentials are not present in clear text.

## Import safety

1. With the project actively `RUNNING`, try **Import Bundle**.
2. Expected: import is rejected with `portable_import_requires_safe_recovery_state`.
3. Use **Pause** and wait for `PAUSED`, or use **Stop Now** and wait for `STOPPED`.
4. Select the previously exported bundle again.
5. Expected: checksum/schema validation succeeds, import commits, and the extension reloads.
6. Re-open the popup.
7. Expected recovery state: `RECOVERY_REQUIRED` with `portable_import_reconciliation_required`.
8. Expected agent pool: no imported browser sessions are treated as live.
9. Register/recreate the required agent sessions and use **Resume**.
10. Expected: normal Phase 9 reconciliation runs before dispatch reopens.

## Corruption test

1. Copy the exported bundle.
2. Change any project/task value without updating `manifest.checksum`.
3. Attempt import while paused/stopped.
4. Expected: `project_bundle_checksum_mismatch`.
5. Existing persisted project must remain unchanged.

## Destination conflict test

1. Export project A.
2. Start a different project B in a disposable extension profile/state.
3. Pause/stop B.
4. Attempt to import A through the normal popup.
5. Expected: `portable_destination_has_active_project`.

Normal popup import does not set `replace=true`; destructive replacement is reserved for explicit tooling/tests.

## SQLite migration gate

With Node 22+:

```powershell
npm run test:phase11
```

The `extension-shaped state exports and imports into SQLite with identical logical state` test must pass, proving:

```text
Memory/extension-shaped state
→ PortableState
→ Project Bundle
→ validation
→ SQLiteStateStore
→ identical logical project/task/review/integration state
→ RECOVERY_REQUIRED
```

## Regression expectations

After Phase 11, also smoke-test the existing extension path:

- Lead registration;
- planning to `READY`;
- Worker dispatch;
- Pause / Resume;
- no unexpected permission prompts.

Phase 11 must not change Git/review/integration policies.
