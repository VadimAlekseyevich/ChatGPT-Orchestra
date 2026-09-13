# ChatGPT Orchestra 2.0.0-alpha.16 — Phase 16 Checkpoint Smoke Test

This build is a **Phase 16 desktop-control-plane checkpoint**, not the final Desktop-first Alpha release from Phase 20. Its purpose is to validate the current desktop Core + SQLite + Edge Companion path on a real Windows machine before continuing the planned desktop migration.

Phase 17 is **not blocked** by this checkpoint. The external-execution feedback-loop idea in issue #26 remains explicitly deferred until the Phase 20 Desktop-first Alpha has been completed and tested.

## Checkpoint scope

Included in this checkpoint:

- desktop Core + SQLite canonical state;
- Edge extension as the ChatGPT DOM/agent companion;
- Native Messaging registration and authenticated bridge;
- extension → desktop project migration;
- planning, DAG scheduling, workers, review, integration;
- pause/resume/recovery across desktop/extension restarts;
- Dashboard/observability and Project Bundle portability.

Not part of this Phase 16 checkpoint because they are planned for later roadmap phases:

- Phase 17 local Git/worktrees and local command execution;
- Phase 18 direct desktop ChatGPT runtime;
- Phase 19 parity/reliability/security hardening;
- Phase 20 Desktop-first Alpha release gate.

Explicitly deferred until **after Phase 20 alpha validation**:

- issue #26 external execution feedback loop;
- automatic CI/Android result delivery back into ChatGPT;
- `ExecutionRuntime`, `ArtifactStore`, automatic attachment delivery or self-hosted-runner orchestration.

## CI artifact

Use the `chatgpt-orchestra-alpha16-windows` artifact produced by the Alpha package CI job. It contains:

```text
desktop/win-unpacked/
alpha-extension/
```

The desktop executable is:

```text
desktop/win-unpacked/ChatGPT Orchestra.exe
```

Load `alpha-extension/` as an unpacked extension in Microsoft Edge.

## 1. Register the packaged Native Messaging host

1. Open `edge://extensions`.
2. Enable Developer mode.
3. Load `alpha-extension/` unpacked.
4. Copy the exact 32-character extension id.
5. From PowerShell in the extracted artifact directory run:

```powershell
& ".\desktop\win-unpacked\ChatGPT Orchestra.exe" --register-native-host=<extension-id> --native-host-browsers=edge
```

Expected result: JSON with `ok: true` and an Edge registration entry. No browser token, GitHub token or ChatGPT credential should be requested or written by this command.

## 2. Start the desktop control plane

Run:

```powershell
& ".\desktop\win-unpacked\ChatGPT Orchestra.exe" --companion
```

Open the extension popup. `Desktop Companion` should become reachable. A bridge disconnect must not silently reactivate extension-owned orchestration.

## 3. Fresh-project companion smoke

Use a small disposable GitHub repository and a bounded goal that naturally produces at least three tasks, including two tasks that can run independently and one dependent task.

Verify:

- desktop Dashboard is the visible canonical project state;
- Lead planning reaches a validated DAG;
- at least two Workers execute in parallel;
- dependent work does not dispatch before prerequisites are approved;
- Review runs independently;
- Integration reaches verified completion;
- extension popup reflects companion connectivity;
- no `tabId`/browser handle is required as portable project identity.

## 4. Pause / restart / resume

During a second run:

1. pause while workers are active;
2. wait for a safe paused state;
3. close ChatGPT Orchestra Desktop;
4. close/reopen Edge or reload the extension service worker;
5. restart desktop with `--companion`;
6. reconnect from the extension popup;
7. resume.

Expected result: persisted SQLite state survives, pending work is reconciled, completed/approved work is not duplicated, and scheduling continues deterministically.

## 5. Existing extension project migration

In standalone extension mode, create or use a disposable active project and bring it to a safe recovery state (`IDLE`, `PAUSED`, `STOPPED` or `RECOVERY_REQUIRED`).

In the popup choose **Migrate Project → Desktop**.

Expected sequence:

1. extension exports a validated Project Bundle while remaining canonical;
2. desktop stages the bundle and reports restart required;
3. restart desktop companion;
4. desktop applies the staged bundle to SQLite before Core boot;
5. popup verifies an applied receipt for the exact `projectId + checksum`;
6. only then **Enable Desktop** succeeds;
7. desktop opens the project in `RECOVERY_REQUIRED`/reconciled state rather than dispatching immediately.

A stale receipt for an older snapshot must not authorize cutover.

## 6. Fail-closed disconnect

With companion mode enabled:

1. terminate the desktop app;
2. attempt an Orchestra command from the extension popup;
3. verify a controlled companion-disconnected error/state;
4. confirm local extension scheduling does not resume automatically;
5. restart desktop and use reconnect.

Expected result: one canonical control plane at a time.

## 7. Logs and state hygiene

Check the Orchestra application data directory after the smoke run.

Verify:

- SQLite database exists and reopens successfully;
- pairing secret exists only locally and is not printed in UI/logs;
- structured logs contain no obvious credentials/tokens;
- migration pending file is removed after successful apply;
- applied migration receipt remains available for cutover verification;
- Project Bundle export contains no required `tabId`/`sessionId` runtime identity.

## 8. Unregister after testing

When the checkpoint test is finished:

```powershell
& ".\desktop\win-unpacked\ChatGPT Orchestra.exe" --unregister-native-host --native-host-browsers=edge
```

Then remove the unpacked extension if desired.

## Pass criteria

The Phase 16 checkpoint passes when all of the following are observed on a real Windows + Edge + ChatGPT run:

- Native Messaging registration works from the packaged executable;
- desktop/extension pairing works after restart;
- a real multi-agent project completes planning → workers → review → integration;
- pause/desktop restart/extension restart/resume preserves logical state;
- active-project migration to SQLite works with exact-checksum cutover gating;
- companion disconnect is fail-closed;
- no duplicate task/review/integration side effects are observed;
- no obvious secret or browser-handle leakage is found in portable state/logs.

A failure here is a Phase 16 defect to fix, but it does not redefine the roadmap. **Phase 17 is the next implementation phase. Issue #26 remains deferred until after the Phase 20 Desktop-first Alpha and its real validation.**
