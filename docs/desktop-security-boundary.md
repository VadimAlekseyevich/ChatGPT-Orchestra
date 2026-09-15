# Desktop Alpha Security Boundary

ChatGPT Orchestra `2.0.0-alpha.20` treats the Electron renderer as an untrusted presentation surface. Privileged filesystem, Git, process, persistence and managed-browser capabilities stay in the desktop main process behind explicit contracts.

## Renderer isolation

The main Orchestra window must keep all of these settings enabled:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

The renderer loads local application files only. Its Content Security Policy must keep scripts on `'self'`, block plugin/object content, forbid base URL rewriting, forbid embedding, and set `connect-src 'none'`. External HTTPS links are handed to the operating system instead of being navigated inside the privileged Orchestra renderer.

## Preload surface

The preload bridge exposes a deliberately small frozen object. It may:

- submit portable Orchestrator API queries;
- submit portable Orchestrator API commands;
- request a native repository-directory picker;
- request an application restart.

It must not expose `fs`, `child_process`, raw `ipcRenderer`, arbitrary channel send/listen primitives, Electron objects, browser/session handles or a generic native function invocation mechanism.

## IPC allowlist

`orchestra:query` and `orchestra:execute` are transport channels, not permission grants. The main-process IPC router independently checks the requested operation name against the canonical `API_QUERIES` and `API_COMMANDS` platform contracts before the desktop host is invoked.

An unknown or empty operation name fails closed at the IPC boundary even if a lower layer would also reject it. This is intentional defense in depth for a compromised renderer.

The two shell-specific IPC handlers are fixed named capabilities only:

- `orchestra:select-repository-directory`
- `orchestra:restart-application`

No renderer-supplied filesystem path is accepted by the directory-picker handler; Electron returns the user-selected directory. Repository services perform their own path/workspace validation after that boundary.

## Telemetry

The desktop-first alpha ships with **no remote telemetry or analytics collection**. There is no Sentry/PostHog/Segment/Amplitude/Datadog/New Relic/OpenTelemetry analytics dependency and the renderer cannot open network connections because of its CSP.

Local dashboard metrics, logs, events and exported debug bundles are observability data stored or exported under the user's control; they are not automatically transmitted to Orchestra or a third-party analytics service.

Telemetry remains opt-in by roadmap policy. Adding a telemetry SDK, beacon, analytics endpoint or background uploader requires a separate explicit user-consent design and security/privacy review; it must not be slipped into the alpha as an implementation detail.

## Browser isolation

The managed ChatGPT runtime is a separate browser surface/profile from the Orchestra dashboard renderer. The dashboard does not receive ChatGPT credentials, cookies, browser-profile paths or raw browser runtime identifiers through the portable project/debug contracts.

This security boundary complements, rather than replaces, repository trust, structured command execution, companion authentication, Project Bundle redaction, recovery guards, signed release validation and the manual signed-only update policy.
