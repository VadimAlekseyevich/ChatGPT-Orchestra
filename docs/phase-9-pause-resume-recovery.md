# Phase 9 — Pause / Resume / Crash Recovery

Phase 9 добавляет отдельный persisted control plane для long-running проектов. Его задача — управлять жизненным циклом Orchestra поверх Planning, Scheduler, Review и Integration, не смешивая control state с task/run state.

## Состояния recovery control plane

`RecoveryStore` (`orchestra.recovery.v1`) хранит:

```text
IDLE
RUNNING
PAUSING
PAUSED
STOPPING
STOPPED
RECOVERING
RECOVERY_REQUIRED
```

Underlying Project/Scheduler/Review/Integration stores не переписываются в искусственный `PAUSED`. Они продолжают хранить фактическую рабочую фазу, а RecoveryStore отвечает только за lifecycle gate и snapshots.

## Главный dispatch invariant

Новый prompt разрешён только если:

```text
bootReady == true
AND recovery.status IN {IDLE, RUNNING}
```

Это правило применяется к planning stage dispatch, Worker assignment, Reviewer assignment, Integrator dispatch и прямому `sendPromptToAgent`.

При service-worker boot `bootReady=false` до окончания reconciliation. Поэтому upgrade с более старой alpha или MV3 restart не может случайно запустить новый side effect до восстановления persisted state.

## Pause

`Pause` — graceful safe-point operation:

1. status → `PAUSING`;
2. новые prompts немедленно запрещаются;
3. уже идущие ChatGPT generations могут закончиться;
4. их protocol events и artifacts продолжают сохраняться;
5. новые Worker/Reviewer/Integrator prompts не запускаются;
6. после исчезновения всех active generation identities status → `PAUSED`;
7. сохраняется recovery snapshot.

Safe point учитывает:

- текущую planning generation;
- active Worker runs;
- active Reviewer runs;
- active Integrator generation/repair.

Pending review или integration work, которое ещё не было dispatched, safe point не блокирует.

## Stop Now

`Stop Now` — immediate interruption boundary:

1. status → `STOPPING`;
2. persisted `stopBoundaryActive=true` выставляется до best-effort stop commands;
3. dispatch закрывается;
4. каждому active agent отправляется `STOP_GENERATION` best-effort;
5. active Worker runs становятся `INTERRUPTED`, но не completed;
6. task возвращается в `READY`, attempt может быть refunded;
7. active review requeue'ится с fresh `reviewId`;
8. active integration run abandon'ится и получит fresh integration identity после Resume;
9. active planning stage помечается `interrupted` и при Resume запускается заново с fresh runId;
10. protocol contexts перестраиваются;
11. сохраняется snapshot, status → `STOPPED`.

`stopBoundaryActive` не зависит от текущей строки lifecycle status. Он переживает `STOPPING -> RECOVERING -> RECOVERY_REQUIRED` при crash/restart и снимается только после успешного reconcile, когда control plane атомарно возвращается в `RUNNING` с `reconciled=true`.

Пока boundary активен, late `DONE`, `REVIEW_*`, `CONFLICT` и blocker events могут остаться в Event Bus audit, но state-machine handlers их не применяют. Это закрывает не только race между `STOP_GENERATION` и последним ответом модели, но и crash-window, когда service worker перезапустился прямо посреди `STOPPING`.

## Resume

`Resume` никогда не означает просто `status=RUNNING`.

Порядок:

```text
RECOVERING
  ↓
reconcile known tabs
  ↓
remove missing replaceable Worker identities
  ↓
create fresh replacement Worker tabs
  ↓
validate target/base Git snapshot
  ↓
reconcile active Worker runs and task branches
  ↓
reconcile reviews
  ↓
reconcile integration
  ↓
rebuild exact protocol contexts
  ↓
issues? ── yes → RECOVERY_REQUIRED
  │
  no
  ↓
RUNNING + clear stopBoundaryActive
  ↓
kick Planning / Review / Scheduler / Integration
```

### Fresh replacement identities

После browser crash старый offline Worker `agentId` не переиспользуется как доказательство продолжения старого run. Offline Worker records удаляются из live registry перед recreation. Старый run сохраняет исходный `agentId` как provenance, а новый tab получает fresh identity.

Это предотвращает ошибку вида: «новая пустая ChatGPT вкладка получила старый agentId, значит старый prompt всё ещё выполняется».

## Git reconciliation активного Worker run

Если исходный Worker tab потерян:

- task branch отсутствует → старый run `INTERRUPTED`, task снова `READY`;
- branch head равен `startSha` → remote progress отсутствует, run `INTERRUPTED`;
- branch продвинулся → Orchestra независимо проверяет:
  - target branch всё ещё на captured base;
  - branch merge-base соответствует project base;
  - branch не behind base;
  - diff не обрезан provider limit;
  - changed files соответствуют task scope.

Если проверки проходят, старый run становится `INTERRUPTED`, а найденный commit сохраняется как `reworkContext.previousCommit`. Следующий fresh run стартует с reconciled commit и обязан заново пройти Git validation + Review.

Небезопасный или неоднозначный branch не принимается — recovery остаётся `RECOVERY_REQUIRED`.

## Reviews

Active Review с исчезнувшим Reviewer не считается продолженным. Он requeue'ится с fresh `reviewId`. Self-review guard остаётся действующим после recovery.

## Integration

Если исходный Integrator tab жив, exact protocol context можно восстановить. Если Integrator потерян, run abandon'ится и scheduler возвращается в `READY_FOR_INTEGRATION`; новый Integrator получает fresh run/branch identity.

Phase 8 target policy сохраняется: target branch не изменяется автоматически.

## Service-worker restart vs browser restart

### MV3 service-worker restart, tabs живы

RecoveryStore RUNNING переводится во временный `RECOVERING`. Tab registry подтверждает живые tabs, protocol contexts перестраиваются, после чего Orchestra автоматически возвращается в `RUNNING` без повторной выдачи уже active work.

### Crash во время Stop Now

Если service worker/browser падает после фиксации `STOPPING`, persisted stop boundary остаётся активным после boot. Recovery может перейти в `RECOVERY_REQUIRED`, но late state-changing events старых run identities всё ещё не применяются. Boundary снимается только успешным Resume reconciliation.

### Browser restart / tabs потеряны

Continuity check находит missing active agents и выставляет `RECOVERY_REQUIRED`. Никакие новые prompts не dispatch'ятся, пока пользователь не нажмёт Resume и reconciliation не завершится.

## Snapshots

Recovery snapshot содержит bounded public state:

- project summary;
- scheduler summary;
- review summary;
- integration summary;
- agent identities/status/context;
- safe-point details;
- reason + timestamp.

Snapshot — diagnostic/recovery checkpoint, но source of truth остаётся в специализированных persisted stores.

## Fail-closed случаи

Resume остаётся в `RECOVERY_REQUIRED`, если:

- Lead нужен для незавершённого planning и не переподключён;
- target branch сдвинулся;
- Git provider недоступен для необходимой reconciliation;
- recovered task branch имеет неверный base / behind state;
- recovered changes выходят за task scope;
- diff может быть provider-truncated;
- review/integration provenance нельзя безопасно восстановить.

## Что Phase 9 не делает

- не добавляет Dashboard/Observability Phase 10;
- не изменяет target-branch merge policy Phase 8;
- не пытается восстановить точный скрытый контекст модели из закрытой ChatGPT вкладки;
- не считает best-effort `STOP_GENERATION` подтверждением отката уже выполненного Git side effect — Git state всегда reconciles отдельно.
