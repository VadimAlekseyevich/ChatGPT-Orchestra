# AgentRuntime lifecycle contract

Issue #71 introduces the canonical lifecycle used by orchestration Core.

## Canonical states

- `READY` — the agent passed a recent adapter-specific readiness check and may receive a new prompt.
- `BUSY` — the agent is executing a prompt or otherwise occupied by Orchestra work.
- `UNAVAILABLE` — the agent is temporarily unusable but recovery/rebinding is expected to be possible.
- `FAILED` — the runtime reached a terminal state and must not return to normal work without an explicit recovery/replacement flow.

Adapters own runtime-specific evidence such as browser availability, composer state, tab/session bindings and transport health. Core only consumes the canonical lifecycle API.

## Transition policy

Allowed normal transitions:

- `UNAVAILABLE -> READY | FAILED`
- `READY -> READY | BUSY | UNAVAILABLE | FAILED`
- `BUSY -> BUSY | READY | UNAVAILABLE | FAILED`

`FAILED -> UNAVAILABLE` requires an explicit recovery/replacement action. Direct `FAILED -> READY` additionally requires validated recovery.

No lifecycle event is emitted for a no-op transition that keeps the same state and reason. A repeated readiness check may still refresh `readinessCheckedAt`.

## Freshness

`READY` is freshness-bound. Each runtime exposes `isAgentReady()`, which evaluates the canonical state together with adapter-owned readiness freshness. Dispatch code must use this API instead of treating connectivity or a cached legacy status as readiness.

## Portable runtime events

AgentRuntime exposes `subscribeAgentEvents()`. Portable event types are:

- `agent-added`
- `agent-removed`
- `agent-lifecycle-changed`
- `agent-binding-changed`

Lifecycle events contain identifiers, state/reason, timestamp and safe diagnostic details only. Prompt/response bodies are not included.

## Legacy compatibility

The legacy `status` field remains in agent DTOs during the 2.1.0 migration window:

| Legacy status | Canonical state |
| --- | --- |
| `IDLE` | `READY` |
| `BUSY` | `BUSY` |
| `CONNECTING` / `OFFLINE` | `UNAVAILABLE` |
| recoverable `ERROR` | `UNAVAILABLE` |
| terminal `ERROR` | `FAILED` |

New Core code must not branch on the legacy field. It is retained only for older UI/diagnostic/transport consumers and can be removed after those consumers migrate to AgentRuntime contract v6.
