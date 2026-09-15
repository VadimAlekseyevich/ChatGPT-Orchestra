# ChatGPT Orchestra `2.0.0-alpha.20` — Desktop-first Alpha Validation

This is the release runbook for the Phase 20 desktop-first alpha. The desktop managed-browser runtime is the primary path; the extension companion remains an explicit fallback.

## Automated candidate gate

Run:

```text
npm run test:alpha
```

The Windows CI job builds the unpacked desktop executable and NSIS installer, stages the fallback extension, verifies version consistency, records the exact source commit in `alpha-build-evidence.json`, records Authenticode status in `alpha-signature-evidence.json`, and uploads the `chatgpt-orchestra-alpha20-windows` candidate artifact. The packaged app also exposes the same build version and commit through `dashboard.persistence.runtimeEvidence`, so a manual tester can prove exactly which candidate was exercised. Pull-request builds do not receive release signing credentials; an unsigned `NotSigned` PR candidate is therefore allowed only as candidate evidence and must never be treated as the final published alpha.

The release contract contains exactly the 17 scenarios from the roadmap. Automated evidence is mandatory for all 17. A01 and A11 require real manual evidence in addition to automation because CI cannot truthfully prove an interactive ChatGPT login on a fresh user profile or a real OS reboot.

| ID | Scenario | Automated evidence | Manual release evidence |
|---|---|---|---|
| A01 | Fresh install + ChatGPT login onboarding | managed-browser onboarding/readiness + exact build identity tests | **Required**: clean Windows user/VM, launch packaged app, complete ChatGPT login, register Lead, confirm no credentials are stored in Orchestra state/debug export |
| A02 | Open local repository | repository API + project binding tests | Not required |
| A03 | Clone repository | Git CLI/SystemGitWorkspace tests | Not required |
| A04 | 4-task parallel happy path | scheduler parallel-worker test | Not required |
| A05 | Dependency path | scheduler dependency-unlock test | Not required |
| A06 | Review rework | review + scheduler rework tests | Not required |
| A07 | Text conflict | integration + real Git no-ff/conflict tests | Not required |
| A08 | Semantic conflict | integration semantic-repair tests | Not required |
| A09 | Task/browser death | managed-browser recovery + local Worker recovery tests | Not required |
| A10 | App process kill/restart | recovery + local integration recovery tests | Not required |
| A11 | OS restart / project resume | persisted recovery + Project Bundle + desktop data + OS boot/build-identity tests | **Required**: real OS restart with a recoverable project; pre/post debug exports must show a changed `systemBootTimeUtc` and the same exact `buildCommit`, while project state/worktrees recover without duplicate irreversible work |
| A12 | Pause/Resume | RecoveryController safe-point tests | Not required |
| A13 | Stop Now + late event protection | stop-boundary + desktop local-process cancellation tests | Not required |
| A14 | Local worktree salvage | workspace lifecycle/salvage tests | Not required |
| A15 | Export/import project | Project Bundle + persistence API + packaged desktop import/relaunch tests | Not required |
| A16 | Extension-companion fallback | companion migration + desktop runtime-mode tests | Not required |
| A17 | No duplicate irreversible side effects | EventBus idempotency + deterministic Git integration/recovery tests | Not required |

## Exact build identity requirement

Every packaged Windows candidate is bound to one 40-character Git commit SHA. The build wrapper writes that identity in two places:

```text
dist/desktop/alpha-build-evidence.json
dashboard.persistence.runtimeEvidence.buildCommit
```

The runtime evidence also exposes:

```text
dashboard.persistence.runtimeEvidence.buildVersion
```

For final alpha validation, A01 and A11 must both have been performed on the **same exact commit** that the signed `Alpha Release Validation` workflow is building. The workflow sets its expected commit from `github.sha` and rejects manual evidence from any older/newer candidate, even when both candidates use the same `2.0.0-alpha.20` version string. If `main` changes after A01/A11 evidence is collected, those manual scenarios must be repeated on a candidate built from the new commit.

## Manual evidence record format

A01 and A11 must each be recorded as a separate comment on an issue in this repository. The final workflow input must be the exact **GitHub issue-comment permalink** (`https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/<n>#issuecomment-<id>`), not free-form text, a screenshot-only reference, a generic issue URL, or `todo/pending` text. A01 and A11 must use distinct comment permalinks.

The signed release workflow has read-only issue access and fetches the referenced comments before any signing/build work. It validates the structured fields below, rejects placeholders/failing fields/version drift/build-commit drift, and records each validated comment's author/timestamps plus a SHA-256 hash of its body in `alpha-manual-evidence.json`. This prevents a permalink that merely exists or evidence from a different alpha candidate from satisfying the gate. It still does not prove that a human statement is truthful; the actual clean-profile login and real OS reboot remain manual responsibilities.

Recommended A01 comment body:

```text
Scenario: A01
Result: PASS
Alpha version: 2.0.0-alpha.20
Build commit: <replace with dashboard.persistence.runtimeEvidence.buildCommit or alpha-build-evidence.json commit>
Windows version: <replace with version/build>
Fresh profile: <replace with clean Windows user or disposable VM condition; no existing Orchestra app-data>
Install/launch: PASS
ChatGPT interactive login: PASS
Lead registration/readiness: PASS
Export privacy check: PASS — no credentials/cookies/browser-profile paths/runtime identifiers
Tester: <replace with tester name/reference>
Timestamp UTC: <replace with ISO-8601 UTC timestamp ending in Z>
Notes/evidence attachments: <optional; replace or remove>
```

Recommended A11 comment body:

```text
Scenario: A11
Result: PASS
Alpha version: 2.0.0-alpha.20
Build commit: <replace with the same exact commit used for A01 and the signed release workflow>
Project/repository reference: <replace with non-secret reference>
State before OS restart: <replace with project status + task/run references>
Pre-restart systemBootTimeUtc: <replace with dashboard.persistence.runtimeEvidence.systemBootTimeUtc>
Real OS restart performed: PASS
Post-restart systemBootTimeUtc: <replace with later post-reboot value>
State after relaunch/reconciliation: <replace with status + recovered task/run references>
Resume result: PASS
Duplicate irreversible side effects check: PASS
Worktree/state preservation: PASS
Tester: <replace with tester name/reference>
Timestamp UTC: <replace with ISO-8601 UTC timestamp ending in Z>
Notes/evidence attachments: <optional; replace or remove>
```

Before posting evidence, replace every angle-bracket placeholder. The validator rejects placeholder values such as `<...>`, `todo`, `pending`, and `tbd`. `Build commit` must be exactly 40 hexadecimal characters.

## Manual A01 procedure

Use the Windows alpha candidate on a clean Windows user account or disposable VM with no existing Orchestra app-data directory. Start `ChatGPT Orchestra.exe` with no runtime flags. Confirm the managed-browser onboarding window opens, sign into ChatGPT interactively, return to the Orchestra Dashboard, register the Lead, and verify the runtime reports ready. Export a debug/project bundle and confirm it contains no ChatGPT credentials, cookies, browser profile path, or browser runtime identifiers.

Record `dashboard.persistence.runtimeEvidence.buildVersion` and `dashboard.persistence.runtimeEvidence.buildCommit` from the same installed app/debug export. Confirm the commit equals `alpha-build-evidence.json` in the candidate artifact. Record at minimum: alpha version, exact build commit, Windows version, fresh-profile condition, onboarding result, Lead registration result, export privacy check, timestamp, and tester identity/reference.

## Manual A11 procedure

Use the **same candidate commit as A01**. Start a local-repository project and reach a persisted recoverable state with at least one completed or in-flight task. Export a debug bundle **before** reboot and record:

```text
dashboard.persistence.runtimeEvidence.buildCommit
dashboard.persistence.runtimeEvidence.systemBootTimeUtc
```

Then perform an actual operating-system restart. Merely closing/reopening Orchestra, killing its process, signing out/in, or restarting only the managed browser does not satisfy A11.

Relaunch Orchestra from the same packaged alpha build. The app must load persisted SQLite/project state, keep dispatch closed until reconciliation completes, recover or safely replace browser/Worker state, preserve local worktrees, and resume without repeating an irreversible merge/push/commit effect. Export a second debug bundle after relaunch. Its `dashboard.persistence.runtimeEvidence.systemBootTimeUtc` must be later than the pre-reboot value, and its `dashboard.persistence.runtimeEvidence.buildCommit` must be identical to the pre-reboot commit. Because boot time is derived from operating-system uptime and rounded to a minute, ordinary Orchestra restarts during the same Windows boot retain the same value while an actual reboot changes it.

Record at minimum: alpha version, exact build commit, project/repository reference, pre/post `systemBootTimeUtc`, state before restart, state after relaunch, recovery decision, resumed run/task identities, verification that no duplicate irreversible side effect occurred, timestamp, and tester identity/reference. Runtime evidence intentionally contains only platform, architecture, OS release, boot time, alpha version and source commit; it does not contain hostname, username, filesystem path or credentials.

## Signed release validation and publication

Final distribution uses the manual GitHub Actions workflow **Alpha Release Validation** (`.github/workflows/alpha-release.yml`). Run it from `main`. It requires A01 and A11 GitHub issue-comment permalinks as workflow inputs and a real Windows code-signing certificate supplied through repository secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`.

The workflow binds both manual evidence comments and the Windows package to the current `github.sha`, then validates reference shape and comment contents with:

```text
node scripts/validate-alpha-evidence-reference.js A01 <A01-comment-permalink> A11 <A11-comment-permalink>
node scripts/validate-alpha-evidence-comments.js A01 <A01-comment-permalink> A11 <A11-comment-permalink>
```

The second validator reads the exact GitHub comments through the workflow's read-only `issues: read` permission. For both scenarios it requires `Build commit` to equal the workflow commit. For A01 it also requires the clean-profile/install/login/Lead/privacy fields to pass. For A11 it requires the reboot/recovery fields to pass and requires `Post-restart systemBootTimeUtc` to be later than `Pre-restart systemBootTimeUtc`.

The build/validation job has only `contents: read`; release write permission is not available while dependencies, tests or untrusted package scripts run. Windows signing credentials are scoped only to the signing credential check and signed installer build, not to `npm install`, ordinary tests, artifact staging, or the publication job.

The workflow reruns `npm run test:alpha`, builds the Windows NSIS installer with the same commit embedded in `alpha-build-evidence.json` and packaged runtime evidence, stages the fallback extension, and executes:

```text
./scripts/verify-windows-alpha.ps1 -RequireSignature
```

The verifier rejects version/build-commit drift before evaluating signatures. Both the unpacked `ChatGPT Orchestra.exe` and the installer must report **Authenticode=Valid** with a signer certificate. `NotSigned` is acceptable only for ordinary PR/CI candidate artifacts; it blocks the signed release validation workflow.

After the strict gates pass, the workflow creates `chatgpt-orchestra-alpha20-extension.zip` and runs `scripts/prepare-alpha-release-assets.js`. That final asset gate re-reads build, signature and manual-evidence manifests; requires one exact source commit, strict signatures, and both A01/A11 records; computes release SHA-256 checksums; and writes:

```text
alpha-release-manifest.json
SHA256SUMS.txt
alpha-release-notes.md
```

The signed candidate plus these audit files are retained as the `chatgpt-orchestra-alpha20-signed-windows` Actions artifact. A separate publication job is the only job granted `contents: write`. It downloads the signed artifact, runs `scripts/verify-alpha-release-bundle.js`, and independently rechecks the exact build commit, version, A01/A11 evidence, strict signatures, manifest contents, file sizes, and SHA-256 checksums before any release is staged.

Immediately before staging, the publication job again requires that neither tag nor release `v2.0.0-alpha.20` already exists. It then creates the release as a **draft prerelease** targeted at the exact `github.sha`, attaches only the signed NSIS installer, fallback-extension ZIP, build/signature/manual evidence JSON files, release manifest and `SHA256SUMS.txt`, and verifies the draft's `targetCommitish`, draft/prerelease flags, and exact asset set. Only that verified draft is published. The final step fetches the created tag, requires it to resolve to the exact workflow commit, and rechecks the published release flags and exact asset set.

If the publication job fails after a release has been staged for the current exact commit, its failure cleanup removes that staged/published release and associated tag. This makes publication fail-closed across artifact transfer, draft staging, and final verification rather than publishing first and discovering a bad release afterward.

Do not enable `PUBLISH_FOR_PULL_REQUEST=true` to expose release credentials to PR builds. Release signing and GitHub release publication stay isolated in the manually dispatched release workflow on `main`.

## Release decision

The automated CI candidate gate must be green. A01 and A11 must each have real PASS evidence from the same exact commit, and the strict signed release workflow must complete for that commit with Authenticode=Valid before the final `v2.0.0-alpha.20` prerelease exists. The workflow itself validates the transferred signed bundle, verifies a draft release, publishes it, and verifies the resulting tag/release. A failure in either manual scenario, commit binding, artifact identity, signing validation, release-bundle verification, draft verification, or final publication verification blocks final alpha and returns to Phase 20 fix/verify work.

The alpha keeps final target-branch merge/push manual by default. Local command execution remains repository-trust gated, extension companion remains optional fallback, and unknown recovery state remains fail-closed.
