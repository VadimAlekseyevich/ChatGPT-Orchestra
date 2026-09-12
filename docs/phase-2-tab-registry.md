# Phase 2 — Service Worker + Tab Registry Contract

Phase 2 introduces centralized ownership of ChatGPT agent tabs without implementing task scheduling yet.

## Registration rules

1. A normal ChatGPT tab is never an agent by default.
2. A Lead is registered only after an explicit popup action on the active ChatGPT tab.
3. A Worker tab is created by the service worker as `about:blank`, bound to an `agentId/tabId`, and only then navigated to ChatGPT.
4. Messages from unregistered ChatGPT tabs are acknowledged as ignored and produce no registry mutation.

## Agent identity

An agent is a logical record independent from page reload:

```json
{
  "agentId": "agent-...",
  "role": "worker",
  "tabId": 123,
  "chatUrl": "https://chatgpt.com/...",
  "status": "IDLE"
}
```

Reloading the same tab preserves `tabId`, therefore the same `agentId` is recovered when the content script announces itself again.

Closing the tab does not delete the agent record. It becomes `OFFLINE` and loses its active `tabId`; automatic recreation belongs to a later recovery phase.

## Status model

Phase 2 uses the intentionally small health model:

- `CONNECTING` — registry knows the tab, content adapter has not confirmed readiness yet;
- `IDLE` — composer is available and generation is not active;
- `BUSY` — ChatGPT is generating;
- `ERROR` — registered tab is in an unavailable/error state or navigated outside ChatGPT;
- `OFFLINE` — the known tab was closed or disappeared during reconciliation.

These are transport/agent-health states, not task states.

## Heartbeat

All ChatGPT content scripts send one `CONTENT_READY` handshake. Only a tab that is already present in the registry receives an agent acknowledgement and enables periodic heartbeat.

This is deliberate: unrelated user ChatGPT tabs must not continuously wake the extension service worker.

An explicitly registered Lead receives an orchestrator `PING`, which both returns the current adapter state and enables heartbeat.

## Addressed commands

The service worker exposes deterministic routing methods:

```text
sendPromptToAgent(agentId, prompt)
stopAgent(agentId)
```

The registry resolves `agentId -> tabId`; commands are sent only to that tab. Phase 3 will place Orchestra Protocol events above this transport layer.

## Persistence and service-worker restart

`TabRegistry` is stored in `chrome.storage.local` under a versioned storage key. On service-worker startup:

1. registry state is loaded;
2. every stored live `tabId` is checked;
3. existing ChatGPT tabs are set to `CONNECTING` and pinged;
4. missing tabs become `OFFLINE`;
5. tabs outside ChatGPT become `ERROR`.

This recovers the transport topology; full project/run recovery is intentionally deferred to the later recovery phase.

## Phase boundary

Phase 2 does **not** implement:

- task scheduling;
- Planner/Critic;
- worker-to-worker event protocol;
- review/integration;
- project Pause/Resume semantics;
- automatic recreation of dead workers.

Those capabilities must consume this registry rather than bypass it.
