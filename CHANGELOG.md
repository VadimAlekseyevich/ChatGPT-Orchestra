# Changelog

Все заметные изменения ChatGPT Orchestra фиксируются в этом файле.

Формат основан на принципах Keep a Changelog. Multi-agent архитектура развивается как линия `2.x`; prerelease-имя хранится в `manifest.version_name`.

## [2.0.0-alpha.7] - 2026-09-12

### Added

- `GitProvider` boundary и первая read-only реализация `GitHubRestProvider`;
- immutable execution base snapshot: default branch + exact base SHA;
- deterministic branch naming `orchestra/<projectId>/<taskId>/<runId>`;
- persisted per-run Git provenance в SchedulerStore;
- Worker prompt contract v2 с обязательной task branch для mutating runs;
- independent validation remote branch head vs reported commit;
- merge-base / ahead / behind freshness validation;
- changed-files validation против `scope.allow` и `scope.deny`;
- exact comparison Worker-reported `changedFiles` vs GitHub compare;
- target-branch movement detection;
- artifact validation audit в scheduler decision log;
- popup Git base indicator;
- Phase 6 architecture doc, smoke-test и ADR 0005;
- `npm run test:phase6` и Git-provider regression tests.

### Reliability and safety

- Worker `DONE` больше не может перевести mutating task в `DONE_UNVERIFIED`, пока remote Git artifact не прошёл независимую validation;
- wrong branch, malformed commit SHA, missing remote branch, head mismatch, wrong merge base, out-of-scope files и false changed-files report отклоняются;
- `target_branch_moved` переводит execution в `NEEDS_USER` вместо silent rebase;
- provider/auth/network/rate-limit failures fail closed и не превращаются в trusted Worker report;
- retry создаёт новый `runId`, поэтому получает новую task branch identity;
- abandoned task branches сохраняются для provenance по policy `retain_until_review_or_manual_cleanup`;
- extension не хранит GitHub credentials и не выполняет GitHub write API calls.

### Changed

- prerelease version обновлена до `2.0.0-alpha.7`;
- manifest добавляет host permission `https://api.github.com/*` для read-only artifact verification;
- `SchedulerStore` хранит execution Git snapshot, run branch metadata и artifact validation result;
- `SchedulerEngine` проверяет base freshness до новых dispatch и Git artifact перед task completion;
- `WorkerPrompts` запрещает direct target-branch writes и требует pushed per-run branch metadata;
- `DONE_UNVERIFIED` теперь означает «Git artifact validated but not independently reviewed».

### Known limitation

Initial GitHub REST validation is unauthenticated. Private/unavailable repositories fail closed until a future authenticated provider/connector is introduced.

### Not yet implemented

- independent Reviewer approval / `CHANGES_REQUIRED` loop;
- integration branch, merge/rebase/cherry-pick and semantic conflict resolution;
- full project Pause/Resume/reconciliation;
- automated safe cleanup of abandoned branches.

---

## [2.0.0-alpha.6] - 2026-09-12

### Added

- persisted `SchedulerStore` and `SchedulerEngine`;
- parallel Worker assignment and dependency unlocking;
- configurable `maxWorkers`;
- conflict-aware file/resource locking;
- retries, watchdog, tab-loss handling and `NEEDS_USER` escalation;
- scheduler decision log and Phase 5 regression tests.

### Safety

- one Worker identity cannot own two active runs;
- mutually-exclusive tasks are not scheduled together;
- Worker `DONE` remains `DONE_UNVERIFIED` rather than `APPROVED/MERGED/VERIFIED`.

---

## [2.0.0-alpha.5] - 2026-09-12

### Added

- persisted Project Store and `goal + repository` bootstrap;
- staged `DISCOVERY -> PLAN_V1 -> CRITIQUE -> PLAN_V2 -> DECOMPOSE -> DAG_CRITIC` pipeline;
- bounded planning artifact framing;
- deterministic DAG validation and `READY` gate;
- planning crash-window recovery and Phase 4 tests/docs.

---

## [2.0.0-alpha.4] - 2026-09-12

### Added

- Orchestra Protocol v1 (`@@ORCH`);
- persisted Event Store/Event Bus;
- event identity, duplicate/collision suppression and monotonic sequence;
- protocol context binding and stale-event rejection;
- Phase 3 protocol regression tests.

---

## [2.0.0-alpha.3] - 2026-09-12

### Added

- Manifest V3 service worker Orchestrator;
- persistent Tab Registry and stable agent IDs;
- explicit Lead registration and managed Worker tabs;
- heartbeat/reconnect/tab lifecycle handling;
- targeted agent routing and Phase 2 tests.

---

## [2.0.0-alpha.2] - 2026-09-12

### Added

- modular ChatGPT adapter layer;
- deterministic generation state machine;
- dual-signal completion detection for missed busy/stop-button transitions;
- SPA/startup stale-response protection;
- typed messages, structured diagnostics and deterministic core tests.

---

## [2.0.0-alpha.1] - 2026-09-12

### Changed

- project renamed to **ChatGPT Orchestra**;
- README/repository metadata/versioning policy reset around the multi-agent product direction;
- legacy single-tab flag runner retained as compatibility foundation;
- added `ROADMAP.md`, `CHANGELOG.md` and ADR structure.

---

## Legacy baseline — 1.2.0

Pre-Orchestra version with configurable single-tab `DONE/FAIL/ERROR` automation, notifications, randomized delay, duplicate-response guard and local settings.
