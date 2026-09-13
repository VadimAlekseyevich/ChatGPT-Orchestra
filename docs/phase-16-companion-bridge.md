# Phase 16 — Desktop Control Plane + Extension Companion Bridge

Phase 16 moves canonical orchestration into the desktop process while preserving the existing ChatGPT DOM automation in the Edge extension. The work is intentionally stacked: the first slice established a secure transport/runtime boundary, the second added explicit fail-closed companion mode, and the current slice adds crash-safe project migration into desktop SQLite.

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

## Crash-safe project migration

Existing extension projects can now cross the source-of-truth boundary without mutating a live desktop Core in place.

The handoff is deliberately two-phase:

```text
Extension canonical project
        │
        │ Export Project Bundle at safe point
        ▼
Authenticated companion RPC
        │
        │ validate + stage
        ▼
<OrchestraData>/companion/migration-pending.json
        │
        │ restart Desktop Companion
        ▼
pre-Core boot validation + SQLite import
        │
        ▼
RECOVERY_REQUIRED state + migration-applied.json
        │
        │ exact projectId + checksum receipt
        ▼
Enable Desktop companion mode
```

Migration can be staged only while standalone extension mode is still canonical and recovery is at `IDLE`, `PAUSED`, `STOPPED` or `RECOVERY_REQUIRED`. The extension exports through the existing `ProjectBundleService`, so browser/session bindings and secrets are already stripped by the portable-state layer.

Desktop validates the bundle before staging and validates it again before import. The pending handoff is written atomically under the companion app-data directory. On the next `desktop:companion` boot, `applyPendingCompanionMigration()` runs before `DesktopHost.init()`. A failed validation/import aborts desktop companion boot and leaves the pending file for diagnosis; successful import writes a durable applied receipt and deletes the pending file.

The import itself uses the existing `PortableStateManager` transaction path, creates a backup and forces `RECOVERY_REQUIRED` so reconciliation happens before dispatch.

The extension records the checksum returned by the staging operation. Companion cutover is allowed only when desktop reports an applied receipt with the exact same `projectId + checksum`. A stale receipt for an older snapshot of the same project cannot authorize cutover.

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

The extension manifest declares `nativeMessaging`, and release validation explicitly allowlists that permission.

## Development migration flow

The normal Phase 15 desktop path is unchanged:

```bash
npm run desktop:dev
```

For a fresh companion session:

```bash
npm run desktop:companion
```

For an existing extension project:

1. Pause or Stop Now until recovery reaches a safe state.
2. Start `npm run desktop:companion` with the Native Messaging host registered.
3. In the extension popup choose **Migrate Project → Desktop**.
4. Confirm the popup reports the bundle staged.
5. Restart Desktop Companion. The pending bundle is imported before Core boot.
6. Click **Enable Desktop**. The extension verifies the applied receipt checksum before disabling its local control plane.
7. Desktop opens the imported project in `RECOVERY_REQUIRED`; reconciliation/resume remains an explicit control-plane step.

## Remaining Phase 16 work

The control-plane cutover path now exists, but Phase 16 still needs:

1. packaged Native Messaging host install/register/uninstall flow;
2. richer desktop connection/migration diagnostics and recovery UI;
3. a real ChatGPT multi-agent smoke run with desktop as canonical state owner;
4. recovery coverage across extension/service-worker/native-host restarts;
5. final roadmap/release-state update after the stacked Phase 16 PRs merge.

## Test gate

```bash
npm run test:phase16
```

The gate covers protocol bounds/versioning, bidirectional RPC, bridged AgentRuntime behavior, Native Messaging framing, pairing-secret persistence, mutual HMAC authentication, authenticated desktop loopback transport, desktop host event routing, explicit companion mode persistence, reconnect, fail-closed disconnect behavior, migration staging, pre-Core SQLite apply, exact-checksum receipt gating, service-worker boundary guards and popup/API routing.
