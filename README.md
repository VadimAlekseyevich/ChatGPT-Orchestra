<div align="center">

# ChatGPT Orchestra

Multi-agent orchestration for ChatGPT coding workflows, moving gradually from an Edge extension to a desktop application.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования-и-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.12-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Документация](docs/README.md) · [Issues](../../issues)

</div>

---

## Идея

**ChatGPT Orchestra** превращает несколько ChatGPT-сессий в управляемый оркестр coding-agent'ов с централизованным planning, DAG scheduling, Git provenance, independent review, verified integration и deterministic recovery.

Ключевой принцип: **чаты — исполнители, а не источник истины**. Project/task/run/review/integration/recovery state принадлежит Orchestrator Core и сохраняется независимо от конкретных browser sessions.

Начиная с alpha.11 проект постепенно мигрирует от browser-extension-only архитектуры к platform-neutral Core и будущему desktop-приложению. Extension остаётся рабочей reference-реализацией и позже станет временным companion bridge.

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.12`**.

Завершены:

- Phase 0 — repository reset / rename hygiene;
- Phase 1 — deterministic ChatGPT DOM adapter;
- Phase 2 — service worker + persistent agent registry;
- Phase 3 — Orchestra Protocol v1 + persisted Event Bus;
- Phase 4 — Project Bootstrap + Planner/Critic + DAG validation;
- Phase 5 — conflict-aware parallel scheduler;
- Phase 6 — per-run Git isolation + independent artifact validation;
- Phase 7 — independent Reviewer + bounded rework;
- Phase 8 — Integrator + semantic-conflict remediation;
- Phase 9 — Pause / Stop Now / Resume / crash recovery;
- Phase 10 — platform contracts + portable Orchestrator API;
- Phase 11 — portable persistence + Project Bundle + SQLite StateStore.

Текущий execution pipeline:

```text
User goal + repository
        ↓
Planning / Critic / DAG validation
        ↓
READY
        ↓
parallel Workers
        ↓
Git artifact validation
        ↓
DONE_BY_WORKER
        ↓
independent Review
   ↙              ↘
CHANGES_REQUIRED  APPROVED
   ↓                 ↓
new rework run   dependency unlock
        └────────────┘
              ↓
     READY_FOR_INTEGRATION
              ↓
        dynamic Integrator
              ↓
 deterministic --no-ff merges
       ↙              ↘
 text conflict   semantic conflict
       ↓              ↓
      bounded repair loop
              ↓
   integration verification
              ↓
      INTEGRATION_VERIFIED
```

`INTEGRATION_VERIFIED` означает verified integration branch, а не automatic merge в target branch.

---

## Platform Boundary

Phase 10 отделила Core от browser host:

```text
Edge / Chrome
    │
    ├─ ExtensionAgentRuntime
    ├─ ChromeStorageStateStore
    └─ ChromeAlarmRuntime
              │
              ▼
       Orchestrator API v2
              │
              ▼
 Planning / Scheduler / Review
 Integration / Recovery / EventBus
```

Основные contracts:

- `AgentRuntime` — logical agents и session lifecycle;
- `StateStore` — persistence backend;
- `TimerRuntime` — recurring watchdog scheduling;
- `OrchestratorApi` — platform-neutral command/query surface.

Для browser-free tests используются `FakeAgentRuntime`, `MemoryStateStore` и deterministic timer.

Подробнее: [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md).

---

## Portable Persistence + Project Bundle

Phase 11 добавляет migration bridge extension → desktop.

Canonical portable snapshot включает project-scoped logical state:

```text
projects
scheduler
reviews
integration
recovery
events
```

Browser runtime bindings не являются частью portable state. При export удаляются `tabId`, `legacyTabId`, `sessionId` и runtime sender metadata, а agent registry экспортируется пустым.

Project Bundle v1 содержит:

```text
manifest
project
state
events
decisions
artifacts
```

Bundle имеет schema version, size bound и checksum. Secrets, API keys, tokens, cookies, credentials и private-key material redacted перед export.

### Import safety

Import разрешён только в безопасном lifecycle состоянии:

```text
IDLE
PAUSED
STOPPED
RECOVERY_REQUIRED
```

После import:

```text
browser bindings = empty
recovery = RECOVERY_REQUIRED
reload = required in extension host
```

Extension freeze'ит StateStore после successful import, чтобы stale in-memory heartbeat или другой старый write не мог перезаписать импортированное состояние до reload.

Popup содержит **Export Bundle** и **Import Bundle**.

Подробнее: [`docs/phase-11-portable-persistence.md`](docs/phase-11-portable-persistence.md).

---

## SQLite StateStore

Для будущего desktop control plane добавлен `SQLiteStateStore` на Node `node:sqlite`.

Свойства:

- SQLite WAL mode;
- `BEGIN IMMEDIATE` transactions;
- rollback failed writes;
- serialized external writes;
- key/value StateStore semantics, совместимые с extension backend;
- Memory/Chrome/SQLite conformance tests.

SQLite не используется внутри MV3 extension runtime и не расширяет browser permissions.

---

## Recovery control plane

Long-running lifecycle хранится отдельно от task state:

```text
RUNNING
  ├─ Pause ─────→ PAUSING → safe point → PAUSED
  ├─ Stop Now ──→ STOPPING → interrupted snapshot → STOPPED
  └─ crash ─────→ RECOVERING
                    ├─ continuity valid → RUNNING
                    └─ ambiguity → RECOVERY_REQUIRED → Resume
```

Resume сначала reconciles tabs, Git state, runs, reviews, integration identities и protocol contexts. Dispatch открывается только после успешного reconciliation.

Подробнее: [`docs/phase-9-pause-resume-recovery.md`](docs/phase-9-pause-resume-recovery.md).

---

## Safety invariants alpha.12

- boot reconciliation закрывает dispatch до `bootReady=true`;
- Worker `DONE` не означает acceptance;
- mutating result не проходит без independently validated Git artifact;
- author не review'ит собственный run;
- dependency unlock требует `APPROVED`;
- Integrator использует deterministic `--no-ff` merge order;
- target branch movement fail-closed;
- final integration report требует independent remote validation;
- runtime connectivity и health разделены;
- project import не разрешён во время active `RUNNING` execution;
- imported project всегда требует reconciliation;
- browser/session IDs удаляются из portable state;
- imported runtime IDs повторно удаляются перед persistence;
- stale writes после extension import блокируются до reload;
- alpha.12 не пишет target branch напрямую.

---

## Быстрый старт

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
npm run test:phase11
```

Затем:

1. `edge://extensions/` → Developer mode → Load unpacked;
2. открой ChatGPT и явно зарегистрируй Lead;
3. укажи GitHub repository + project goal;
4. дождись planning status `READY`;
5. выбери Worker slots и Start Execution;
6. наблюдай Worker → Git validation → Review → Integration;
7. используй Pause/Stop Now/Resume для lifecycle control;
8. используй Export Bundle для сохранения portable project state;
9. Import Bundle выполняй только после Pause/Stop либо из recovery state;
10. после import расширение reload'ится и требует reconciliation.

Runtime extension не требует npm dependencies или build step.

---

## Требования и permissions

- Microsoft Edge + Manifest V3;
- доступ к ChatGPT;
- Node.js 18+ для development tests;
- Node с `node:sqlite` для SQLite-specific tests/runtime adapter.

Manifest permissions:

- `storage` — persisted extension state;
- `tabs` — extension AgentRuntime;
- `alarms` — extension TimerRuntime;
- ChatGPT host permissions — content adapter;
- `https://api.github.com/*` — read-only Git provenance/recovery validation.

Extension не хранит GitHub credentials и не использует GitHub write API.

---

## Roadmap

Desktop migration продолжается без big-bang rewrite:

- Phase 10 — Platform Boundary + Orchestrator API — `2.0.0-alpha.11`;
- Phase 11 — Portable Persistence + Project Export/Import — `2.0.0-alpha.12`;
- **Phase 12 — Portable Dashboard + Observability API — следующий этап;**
- Phase 13 — Context Management + Portable Agent Packets;
- Phase 14 — Contract Tests + CI Foundation;
- Phase 15 — Desktop Shell Bootstrap;
- Phase 16 — Desktop Control Plane + Extension Companion Bridge;
- Phase 17 — Local Repository Runtime + Git Worktrees;
- Phase 18 — Direct Desktop ChatGPT AgentRuntime;
- Phase 19 — Desktop Parity + Reliability / Security Hardening;
- Phase 20 — Desktop-first Alpha Release;
- Phase 21 — Post-alpha Cutover / Provider Expansion.

Полная стратегия: [`ROADMAP.md`](ROADMAP.md) и [`docs/adr/0009-gradual-desktop-migration.md`](docs/adr/0009-gradual-desktop-migration.md).

---

## Документация

- [`ROADMAP.md`](ROADMAP.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/README.md`](docs/README.md)
- [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md)
- [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md)
- [`docs/phase-5-scheduler.md`](docs/phase-5-scheduler.md)
- [`docs/phase-6-git-task-isolation.md`](docs/phase-6-git-task-isolation.md)
- [`docs/phase-7-review-loop.md`](docs/phase-7-review-loop.md)
- [`docs/phase-8-integrator.md`](docs/phase-8-integrator.md)
- [`docs/phase-9-pause-resume-recovery.md`](docs/phase-9-pause-resume-recovery.md)
- [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md)
- [`docs/phase-11-portable-persistence.md`](docs/phase-11-portable-persistence.md)
- [`docs/phase-11-smoke-test.md`](docs/phase-11-smoke-test.md)
- [`docs/adr/0011-portable-persistence-project-bundles.md`](docs/adr/0011-portable-persistence-project-bundles.md)
