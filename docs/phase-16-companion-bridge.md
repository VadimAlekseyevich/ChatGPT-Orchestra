# Phase 16 — Companion Bridge Foundation

This stacked Phase 16 slice establishes the transport/runtime boundary required to move the canonical Orchestra control plane into the desktop process while keeping the existing ChatGPT DOM automation in the Edge extension.

## Implemented in this slice

```text
Desktop Core / SQLite
  CompanionDesktopHost
       │
  DesktopBridgeAgentRuntime
       │
  Companion RPC v1
       │
Authenticated loopback server
       │
Native Messaging relay
       │
NativeMessagingTransport
       │
ExtensionCompanionEndpoint
       │
ExtensionAgentRuntime
       │
ChatGPT tabs/content adapter
```

The RPC protocol is versioned, JSON-only and bounded to 256 KiB per frame. A version handshake checks both companion protocol and platform contract versions before the desktop runtime accepts the extension peer.

`DesktopBridgeAgentRuntime` implements the existing AgentRuntime contract. It keeps only a logical mirror of remote agents and routes session/prompt/stop/context operations through companion RPC. Browser handles do not cross into Core DTOs beyond the existing portable logical session metadata.

`ExtensionCompanionEndpoint` wraps the existing ExtensionAgentRuntime rather than replacing ChatGPT DOM automation. It exposes browser-agent operations to desktop and forwards content/runtime and tab lifecycle events back to desktop handlers.

`CompanionDesktopHost` is the Phase 16 composition root. The reverse bridge handlers feed browser runtime/session messages into the existing Orchestrator, Integration and Recovery paths, so desktop remains the domain owner instead of duplicating service-worker orchestration logic.

## Authentication

The desktop local server listens only on `127.0.0.1` and does not accept Orchestra RPC frames before challenge/response authentication.

A random 256-bit secret is stored under the desktop application data directory:

```text
<OrchestraData>/companion/pairing-secret
```

On POSIX hosts it is forced to mode `0600`. The native relay reads the secret locally and performs mutual HMAC-SHA256 authentication with fresh client/server nonces. The secret is never sent through Chrome Native Messaging and therefore is not exposed to the extension JavaScript context.

The endpoint descriptor is written separately to:

```text
<OrchestraData>/companion/endpoint.json
```

It contains only loopback host/port, protocol versions and a transient instance id.

## Native Messaging boundary

`apps/companion/native-host.js` is a reference relay. It translates Chrome's 4-byte little-endian length-prefixed JSON messages into the authenticated desktop loopback stream. `native-host-manifest.template.json` deliberately contains placeholders for the packaged executable path and exact extension id; an installer/registration flow is still required before companion mode can be enabled for users.

## Deliberately not enabled yet

This foundation does **not** switch the existing MV3 service worker into companion mode by default. Phase 15 extension behavior remains unchanged. The next Phase 16 slice must:

1. add explicit extension companion-mode bootstrap/reconnect logic around `ExtensionCompanionEndpoint`;
2. add Native Messaging permission/host installation only when the companion path is ready;
3. surface connection status in popup/Desktop Dashboard;
4. migrate canonical project state from Chrome storage to SQLite through the existing Project Bundle path;
5. add disconnect/reconnect recovery tests with a real service-worker-shaped fixture.

## Test gate

```bash
npm run test:phase16
```

The gate covers protocol bounds/versioning, bidirectional RPC, bridged AgentRuntime behavior, Native Messaging transport framing, pairing-secret persistence, mutual HMAC authentication, authenticated desktop loopback transport and browser-event routing into a desktop-owned Core host.
