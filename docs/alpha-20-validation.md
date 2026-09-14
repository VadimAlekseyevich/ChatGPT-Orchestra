# ChatGPT Orchestra `2.0.0-alpha.20` — Desktop-first Alpha Validation

This is the release runbook for the Phase 20 desktop-first alpha. The desktop managed-browser runtime is the primary path; the extension companion remains an explicit fallback.

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
| A11 | OS restart / project resume | persisted recovery + Project Bundle + desktop data + OS boot-evidence tests | **Required**: real OS restart with a recoverable project; pre/post debug exports must show a changed `systemBootTimeUtc`, while project state/worktrees recover without duplicate irreversible work |
| A12 | Pause/Resume | RecoveryController safe-point tests | Not required |
| A13 | Stop Now + late event protection | stop-boundary + desktop local-process cancellation tests | Not required |
| A14 | Local worktree salvage | workspace lifecycle/salvage tests | Not required |
| A15 | Export/import project | Project Bundle + persistence API + packaged desktop import/relaunch tests | Not required |
| A16 | Extension-companion fallback | companion migration + desktop runtime-mode tests | Not required |
| A17 | No duplicate irreversible side effects | EventBus idempotency + deterministic Git integration/recovery tests | Not required |

## Manual evidence record format

A01 and A11 must each be recorded as a separate comment on an issue in this repository. The final workflow input must be the exact **GitHub issue-comment permalink** (`https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/<n>#issuecomment-<id>`), not free-form text, a screenshot-only reference, a generic issue URL, or `todo/pending` text. A01 and A11 must use distinct comment permalinks.

Recommended A01 comment body:

```text
Scenario: A01
Result: PASS
Alpha version: 2.0.0-alpha.20
Windows version: <version/build>
Fresh profile: <clean Windows user or disposable VM; no existing Orchestra app-data>
Install/launch: PASS
ChatGPT interactive login: PASS
Lead registration/readiness: PASS
Export privacy check: PASS — no credentials/cookies/browser-profile paths/runtime identifiers
Tester: <name/reference>
Timestamp UTC: <ISO-8601>
Notes/evidence attachments: <optional>
```

Recommended A11 comment body:

```text
Scenario: A11
Result: PASS
Alpha version: 2.0.0-alpha.20
Project/repository reference: <non-secret reference>
State before OS restart: <project status + task/run references>
Pre-restart systemBootTimeUtc: <dashboard.persistence.runtimeEvidence.systemBootTimeUtc>
Real OS restart performed: PASS
Post-restart systemBootTimeUtc: <must differ from pre-restart value>
State after relaunch/reconciliation: <status + recovered task/run references>
Resume result: PASS
Duplicate irreversible side effects check: PASS
Worktree/state preservation: PASS
Tester: <name/reference>
Timestamp UTC: <ISO-8601>
Notes/evidence attachments: <optional>
```

The workflow validates that both inputs are distinct comment permalinks in this repository. That validation makes the release evidence auditable, but it does **not** magically prove the real-world steps happened; the tester/release operator is still responsible for truthful PASS evidence.

## Manual A01 procedure

Use the Windows alpha artifact on a clean Windows user account or disposable VM with no existing Orchestra app-data directory. Start `ChatGPT Orchestra.exe` with no runtime flags. Confirm the managed-browser onboarding window opens, sign into ChatGPT interactively, return to the Orchestra Dashboard, register the Lead, and verify the runtime reports ready. Export a debug/project bundle and confirm it contains no ChatGPT credentials, cookies, browser profile path, or browser runtime identifiers.

Record at minimum: alpha version, Windows version, fresh-profile condition, onboarding result, Lead registration result, export privacy check, timestamp, and tester identity/reference.

## Manual A11 procedure

Start a local-repository project and reach a persisted recoverable state with at least one completed or in-flight task. Export a debug bundle **before** reboot and record:

```text
dashboard.persistence.runtimeEvidence.systemBootTimeUtc
```

Then perform an actual operating-system restart. Merely closing/reopening Orchestra, killing its process, signing out/in, or restarting only the managed browser does not satisfy A11.

Relaunch Orchestra from the same packaged alpha build. The app must load persisted SQLite/project state, keep dispatch closed until reconciliation completes, recover or safely replace browser/Worker state, preserve local worktrees, and resume without repeating an irreversible merge/push/commit effect. Export a second debug bundle after relaunch. Its `dashboard.persistence.runtimeEvidence.systemBootTimeUtc` must differ from the pre-reboot value. Because the value is derived from operating-system uptime and rounded to a minute, ordinary Orchestra restarts during the same Windows boot retain the same value while an actual reboot changes it.

Record at minimum: alpha version, project/repository reference, pre/post `systemBootTimeUtc`, state before restart, state after relaunch, recovery decision, resumed run/task identities, verification that no duplicate irreversible side effect occurred, timestamp, and tester identity/reference. Runtime evidence intentionally contains only platform, architecture, OS release and boot time; it does not contain hostname, username, filesystem path or credentials.

## Signed release validation

Final distribution uses the manual GitHub Actions workflow **Alpha Release Validation** (`.github/workflows/alpha-release.yml`). It requires A01 and A11 GitHub issue-comment permalinks as workflow inputs and a real Windows code-signing certificate supplied through repository secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`.

The workflow first validates both evidence references with:

```text
node scripts/validate-alpha-evidence-reference.js A01 <A01-comment-permalink> A11 <A11-comment-permalink>
```

It then reruns `npm run test:alpha`, builds the Windows NSIS installer, stages the fallback extension, and executes:

```text
./scripts/verify-windows-alpha.ps1 -RequireSignature
```

Both the unpacked `ChatGPT Orchestra.exe` and the installer must report **Authenticode=Valid** with a signer certificate. `NotSigned` is acceptable only for ordinary PR/CI candidate artifacts; it blocks the signed release validation workflow. The strict workflow uploads `chatgpt-orchestra-alpha20-signed-windows` plus signature evidence and the supplied manual evidence references. It does not create a GitHub tag or release automatically.

Do not enable `PUBLISH_FOR_PULL_REQUEST=true` to expose release credentials to PR builds. Release signing stays isolated from pull-request CI.

## Release decision

The automated CI candidate gate must be green. A01 and A11 must each have real PASS evidence, and the strict signed release workflow must complete with Authenticode=Valid before publishing the final `v2.0.0-alpha.20` prerelease. A failure in either manual scenario or signing validation blocks the final alpha tag and returns to Phase 20 fix/verify work.

The alpha keeps final target-branch merge/push manual by default. Local command execution remains repository-trust gated, extension companion remains optional fallback, and unknown recovery state remains fail-closed.
