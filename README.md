<div align="center">

# ChatGPT Orchestra

Desktop-first multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Windows%20Desktop-0078D4?style=for-the-badge)](#requirements)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.20-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Alpha validation](docs/alpha-20-validation.md) · [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Documentation](docs/README.md)

</div>

---

## Status

The current source candidate is **`2.0.0-alpha.20`**. Phases 0–20 are implemented in `main` through the desktop-first alpha candidate. The final `v2.0.0-alpha.20` prerelease is intentionally blocked until the real manual A01/A11 scenarios pass and the Windows artifacts are Authenticode-signed.

Tracking issue: [#43 — complete manual alpha validation and signed Windows release](https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43).

Issue #26 (external execution feedback loop) remains deferred until after alpha validation.

## What it is

ChatGPT Orchestra coordinates Lead, Worker, Reviewer and Integrator agents around durable project state. Chats are executors, not the source of truth: planning, DAG state, run identities, local Git provenance, review, integration, recovery and observability live in Orchestra.

The primary alpha runtime is the packaged desktop application with a managed ChatGPT browser profile. The Edge extension remains an explicit companion fallback, not the primary product path.

```text
Desktop UI / Dashboard
        ↓
Orchestrator API
        ↓
Orchestra Core
Planning → DAG → Parallel Workers → Review → Integration
        ↓                       ↓
SQLite state              local Git worktrees
        ↓                       ↓
managed ChatGPT agents     trusted local verification
```

## Desktop-first alpha capabilities

- local repository registration and clone;
- isolated task and integration Git worktrees;
- explicit repository trust before local commands may run;
- `shell:false`, argv-only local command execution with bounded output, timeouts, cancellation and audit metadata;
- independent artifact provenance and scope validation before review;
- deterministic no-ff local integration with conflict detection and repair fallback;
- direct desktop managed-browser `AgentRuntime` with dedicated persistent ChatGPT profile;
- extension companion fallback;
- SQLite persistence, Project Bundle export/import and deterministic recovery;
- Pause / Resume / Stop Now boundaries with late-event rejection;
- workspace salvage instead of deleting dirty abandoned worktrees;
- portable Dashboard and observability surfaces;
- automated acceptance evidence for all 17 Phase 20 alpha scenarios.

The final target-branch merge/push remains user-controlled. Orchestra does not silently publish completed integration work.

## Alpha acceptance

`npm run test:alpha` runs the automated candidate gate. Phase 20 maps each of the 17 roadmap scenarios to executable evidence. Two scenarios also require real manual evidence because CI cannot truthfully simulate them:

- **A01:** fresh Windows install + interactive ChatGPT login onboarding;
- **A11:** real operating-system restart + project recovery/resume without duplicate irreversible effects.

The canonical procedure is [`docs/alpha-20-validation.md`](docs/alpha-20-validation.md). A separate manual **Alpha Release Validation** GitHub Actions workflow requires A01/A11 evidence and validates `Authenticode=Valid` before a signed release artifact is accepted.

## Development quick start

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm install
npm test
npm run test:phase20
npm run test:alpha
```

Run the desktop managed-browser product path:

```powershell
npm run desktop:managed-browser
```

Build the Windows installer candidate:

```powershell
npm run desktop:dist:win
```

The extension fallback can be staged with:

```powershell
npm run extension:stage-alpha
```

## Safety invariants

- dispatch stays closed until startup/recovery reconciliation completes;
- Worker `DONE` is not acceptance;
- mutating task results require independently validated Git artifacts;
- task authors cannot approve their own work;
- dependencies unlock only after approved prerequisites;
- local command execution is disabled until the repository is explicitly trusted;
- local commands run as executable + argv, never through a shell string;
- dirty abandoned worktrees are salvage evidence and are not auto-deleted;
- integration is deterministic and conflicts fail closed into remediation;
- Stop Now blocks late state-machine effects and cancels active local verification;
- portable exports redact credentials/runtime identities;
- target-branch writes remain user-controlled;
- unsigned Windows CI output is only an alpha **candidate**, never the final signed prerelease.

## Requirements

For the desktop alpha/development path:

- Windows 10/11 for the release target;
- Node.js 22 recommended for desktop development and SQLite tests;
- system Git available on `PATH`;
- ChatGPT access and an interactive login in Orchestra's dedicated managed-browser profile.

Node 18 remains covered for portable/Core compatibility jobs in CI.

## Roadmap status

```text
Phase 0–14   Core architecture, scheduling, provenance, review, integration,
             recovery, portability, persistence, dashboard, context and CI
Phase 15      Desktop shell                                  ✅
Phase 16      Desktop control plane + companion bridge      ✅
Phase 17      Local repository runtime + Git worktrees      ✅
Phase 18      Direct desktop ChatGPT AgentRuntime           ✅
Phase 19      Desktop parity / reliability / security       ✅
Phase 20      Desktop-first Alpha candidate                 ✅ code + CI
             Manual A01/A11 + signed release               ⏳ issue #43
Phase 21      Post-alpha cutover / provider expansion       after validation
```

Full architecture and historical sequencing remain in [`ROADMAP.md`](ROADMAP.md).

## Key documentation

- [`docs/alpha-20-validation.md`](docs/alpha-20-validation.md) — authoritative alpha release runbook;
- [`ROADMAP.md`](ROADMAP.md) — browser-extension → desktop architecture roadmap;
- [`docs/README.md`](docs/README.md) — documentation index;
- [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md) — platform contracts;
- [`docs/phase-11-portable-persistence.md`](docs/phase-11-portable-persistence.md) — portable persistence and bundles;
- [`docs/phase-12-dashboard-observability.md`](docs/phase-12-dashboard-observability.md) — Dashboard/observability boundary;
- [`docs/phase-13-context-agent-packets.md`](docs/phase-13-context-agent-packets.md) — portable role context;
- [`docs/phase-14-contract-tests-ci.md`](docs/phase-14-contract-tests-ci.md) — contract/CI foundation.

## License

See [`LICENSE`](LICENSE).
