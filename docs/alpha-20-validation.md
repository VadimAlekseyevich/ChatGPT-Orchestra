# ChatGPT Orchestra `2.0.0-alpha.20` — Desktop-first Alpha Validation

This is the release runbook for the Phase 20 desktop-first alpha. The desktop managed-browser runtime is the primary path; the extension companion remains an explicit fallback. Issue #26 remains deferred until after alpha validation and is not part of this release gate.

## Automated candidate gate

Run:

```text
npm run test:alpha
```

The Windows CI job builds the unpacked desktop executable and NSIS installer, stages the fallback extension, verifies version consistency, records Authenticode status in `alpha-signature-evidence.json`, and uploads the `chatgpt-orchestra-alpha20-windows` candidate artifact. Pull-request builds do not receive release signing credentials; an unsigned `NotSigned` PR candidate is therefore allowed only as candidate evidence and must never be treated as the final published alpha.

The release contract contains exactly the 17 scenarios from the roadmap. Automated evidence is mandatory for all 17. A01 and A11 require real manual evidence in addition to automation because CI cannot truthfully prove an interactive ChatGPT login on a fresh user profile or a real OS reboot.

| ID | Scenario | Automated evidence | Manual release evidence |
|---|---|---|---|
| A01 | Fresh install + ChatGPT login onboarding | managed-browser onboarding/readiness tests | **Required**: clean Windows user/VM, launch packaged app, complete ChatGPT login, register Lead, confirm no credentials are stored in Orchestra state/debug export |
| A02 | Open local repository | repository API + project binding tests | Not required |
| A03 | Clone repository | Git CLI/SystemGitWorkspace tests | Not required |
| A04 | 4-task parallel happy path | scheduler parallel-worker test | Not required |
| A05 | Dependency path | scheduler dependency-unlock test | Not required |
| A06 | Review rework | review + scheduler rework tests | Not required |
| A07 | Text conflict | integration + real Git no-ff/conflict tests | Not required |
| A08 | Semantic conflict | integration semantic-repair tests | Not required |
| A09 | Task/browser death | managed-browser recovery + local Worker recovery tests | Not required |
| A10 | App process kill/restart | recovery + local integration recovery tests | Not required |
| A11 | OS restart / project resume | persisted recovery + Project Bundle + desktop data tests | **Required**: restart the operating system with a recoverable project, relaunch Orchestra, reconcile, resume the same project, verify no duplicate work or destructive action |
| A12 | Pause/Resume | RecoveryController safe-point tests | Not required |
| A13 | Stop Now + late event protection | stop-boundary + desktop local-process cancellation tests | Not required |
| A14 | Local worktree salvage | workspace lifecycle/salvage tests | Not required |
| A15 | Export/import project | Project Bundle + persistence API tests | Not required |
| A16 | Extension-companion fallback | companion migration + desktop runtime-mode tests | Not required |
| A17 | No duplicate irreversible side effects | EventBus idempotency + deterministic Git integration/recovery tests | Not required |

## Manual A01 procedure

Use the Windows alpha artifact on a clean Windows user account or disposable VM with no existing Orchestra app-data directory. Start `ChatGPT Orchestra.exe` with no runtime flags. Confirm the managed-browser onboarding window opens, sign into ChatGPT interactively, return to the Orchestra Dashboard, register the Lead, and verify the runtime reports ready. Export a debug/project bundle and confirm it contains no ChatGPT credentials, cookies, browser profile path, or browser runtime identifiers.

Record at minimum: alpha version, Windows version, fresh-profile condition, onboarding result, Lead registration result, export privacy check, timestamp, and tester identity/reference.

## Manual A11 procedure

Start a local-repository project, reach a persisted recoverable state with at least one completed or in-flight task, then perform an actual OS restart. Relaunch Orchestra from the packaged alpha build. The app must load persisted SQLite/project state, keep dispatch closed until reconciliation completes, recover or safely replace browser/Worker state, preserve local worktrees, and resume without repeating an irreversible merge/push/commit effect.

Record at minimum: alpha version, project/repository reference, state before restart, state after relaunch, recovery decision, resumed run/task identities, verification that no duplicate irreversible side effect occurred, timestamp, and tester identity/reference.

## Signed release validation

Final distribution uses the manual GitHub Actions workflow **Alpha Release Validation** (`.github/workflows/alpha-release.yml`). It requires non-placeholder A01 and A11 evidence references as workflow inputs and a real Windows code-signing certificate supplied through repository secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`.

The workflow reruns `npm run test:alpha`, builds the Windows NSIS installer, stages the fallback extension, and executes:

```text
./scripts/verify-windows-alpha.ps1 -RequireSignature
```

Both the unpacked `ChatGPT Orchestra.exe` and the installer must report **Authenticode=Valid** with a signer certificate. `NotSigned` is acceptable only for ordinary PR/CI candidate artifacts; it blocks the signed release validation workflow. The strict workflow uploads `chatgpt-orchestra-alpha20-signed-windows` plus signature evidence and the supplied manual evidence references. It does not create a GitHub tag or release automatically.

Do not enable `PUBLISH_FOR_PULL_REQUEST=true` to expose release credentials to PR builds. Release signing stays isolated from pull-request CI.

## Release decision

The automated CI candidate gate must be green. A01 and A11 must each have real PASS evidence, and the strict signed release workflow must complete with Authenticode=Valid before publishing the final `v2.0.0-alpha.20` prerelease. A failure in either manual scenario or signing validation blocks the final alpha tag and returns to Phase 20 fix/verify work.

The alpha keeps final target-branch merge/push manual by default. Local command execution remains repository-trust gated, extension companion remains optional fallback, and unknown recovery state remains fail-closed.
