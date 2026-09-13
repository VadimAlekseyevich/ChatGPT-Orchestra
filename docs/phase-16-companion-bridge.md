# Phase 16 — Desktop Control Plane + Extension Companion Bridge

Phase 16 moves canonical orchestration toward the desktop process while preserving the existing ChatGPT DOM automation in the Edge extension. The work is intentionally stacked: the first slice established a secure transport/runtime boundary; the second slice enables an explicit, fail-closed companion mode without changing the default standalone-extension behavior.

## Current architecture

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

`DesktopBridgeAgentRuntime` implements the existing AgentRuntime contract. It keeps only a logical mirror of remote agents and routes session/prompt/stop/context operations through companion RPC. Browser handles do not become canonical Core state.

`ExtensionCompanionEndpoint` wraps the existing ExtensionAgentRuntime rather than replacing ChatGPT DOM automation. It exposes browser-agent operations to desktop, forwards content/runtime and tab lifecycle events back to desktop handlers, and proxies popup Orchestrator API calls into the desktop host.

`CompanionDesktopHost` is the Phase 16 desktop composition root. Browser events feed the existing Orchestrator, Integration and Recovery paths, while project/event/recovery state remains in desktop SQLite.

## Explicit companion mode

Standalone extension mode remains the default. Companion mode is stored explicitly under the extension setting `orchestraCompanionModeV1` and can be enabled, disabled or reconnected from the popup.

When companion mode is enabled:

- the local extension scheduler watchdog is suspended;
- popup Orchestrator API requests are proxied to desktop;
- content-script protocol/runtime messages are forwarded to desktop;
- tab update/removal events are forwarded to desktop;
- desktop continues to command prompts, Stop Generation, sessions and protocol context through `DesktopBridgeAgentRuntime`;
- a disconnected bridge returns `companion_disconnected` instead of silently falling back to Chrome-storage orchestration;
- a recurring MV3 alarm retries the bridge after disconnect.

This fail-closed rule prevents two canonical control planes from making side effects at the same time.

## Migration safety gate

The migration wizard is not implemented yet. Until it exists, the controller refuses to switch an extension with an active project into companion mode:

```text
companion_enable_requires_project_migration
```

This is deliberate. The user must not create a second canonical copy of an active project simply by toggling a bridge setting. Fresh/no-project extension state can be used for companion development now; active projects will move through the Project Bundle → SQLite migration flow in the next slice.

## Authentication

The desktop local server listens only on `127.0.0.1` and does not accept Orchestra RPC frames before challenge/response authentication.

A random 256-bit secret is stored under the desktop application data directory:

```text
<OrchestraData>/companion/pairing-secret
```

On POSIX hosts it is forced to mode `0600`. The native relay reads the secret locally and performs mutual HMAC-SHA256 authentication with fresh client/server nonces. The secret is never sent through Chrome Native Messaging and therefore is not exposed to extension JavaScript.

The endpoint descriptor is written separately to:

```text
<OrchestraData>/companion/endpoint.json
```

It contains only loopback host/port, protocol versions and a transient instance id.

## Native Messaging boundary

`apps/companion/native-host.js` translates Chrome's 4-byte little-endian length-prefixed JSON messages into the authenticated desktop loopback stream. `native-host-manifest.template.json` still contains placeholders for the packaged executable path and exact extension id; installer/registration automation is a remaining Phase 16 task.

The extension manifest now declares `nativeMessaging`, and release validation explicitly allowlists that permission.

## Development flow

The normal Phase 15 desktop path is unchanged:

```bash
npm run desktop:dev
```

To run the desktop as the Phase 16 control plane:

```bash
npm run desktop:companion
```

The desktop opens the authenticated companion server and waits for the extension peer. In the extension popup, use **Enable Desktop** or **Open / Reconnect**. The native host must already be registered from the manifest template for this developer flow.

## Remaining Phase 16 work

The bridge is now explicit and routable, but Phase 16 is not complete until these pieces land:

1. migration wizard Chrome storage → Project Bundle → desktop SQLite;
2. packaged Native Messaging host install/register/uninstall flow;
3. richer desktop connection diagnostics and recovery UI;
4. a real ChatGPT multi-agent smoke run with desktop as canonical state owner;
5. recovery coverage across extension/service-worker/native-host restarts.

## Test gate

```bash
npm run test:phase16
```

The gate covers protocol bounds/versioning, bidirectional RPC, bridged AgentRuntime behavior, Native Messaging framing, pairing-secret persistence, mutual HMAC authentication, authenticated desktop loopback transport, desktop host event routing, explicit companion mode persistence, reconnect, fail-closed disconnect behavior, active-project migration gating, service-worker boundary guards and popup/API routing.
