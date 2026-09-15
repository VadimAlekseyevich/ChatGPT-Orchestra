# Desktop Alpha Update Policy

ChatGPT Orchestra `2.0.0-alpha.20` intentionally uses a **manual, signed-only update strategy**. The alpha does not include an automatic updater, background update checks, a remote update feed, or silent installer execution.

## Alpha policy

For the desktop-first alpha:

1. A new build is eligible for distribution only through the strict `Alpha Release Validation` workflow.
2. The Windows application executable and NSIS installer must both pass Authenticode verification with status `Valid`.
3. The workflow must bind manual A01/A11 evidence, build identity, signatures, release manifest and checksums to the same exact Git commit.
4. The workflow publishes the GitHub prerelease only after all release gates pass.
5. Users update manually by obtaining the newer published prerelease installer and running it themselves.
6. Orchestra never downloads or executes an update payload automatically in this alpha.

This is the secure update strategy for Phase 19/20. **No auto-update is safer than an unsigned or weakly authenticated auto-update path.**

## Trust boundary

A candidate CI artifact is not an update source and must not be presented as a production update. Only a published prerelease created by the strict signed-release workflow is eligible for user installation.

Before a release is published, the workflow verifies:

- exact `2.0.0-alpha.20` version and build commit identity;
- valid A01/A11 evidence for that exact commit;
- `Get-AuthenticodeSignature` reports `Valid` for the packaged app and installer;
- generated `alpha-release-manifest.json`;
- generated `SHA256SUMS.txt`;
- expected signed Windows and fallback-extension release assets;
- release tag target and workflow-run ownership before and after publication.

The application itself does not trust GitHub Actions candidate artifacts, arbitrary URLs, or a mutable update feed.

## User data during manual update

Application state lives under the Orchestra application-data directory rather than inside the installed executable directory. Running a newer signed installer is expected to replace application binaries while preserving durable state. Persistence schema migrations remain fail-closed: backup/validation/reconciliation must complete before scheduler dispatch reopens.

The updater policy does not grant installers or migrations permission to import browser credentials, cookies, ordinary Chrome/Edge profiles, or runtime page identities into portable project state.

## Rollback

Automatic downgrade/rollback is not supported during alpha. If a published alpha has a critical regression, publication should be stopped and a corrected signed build should be released from a new validated commit. Existing project state should be exported/backed up before any deliberate manual downgrade experiment.

## Future automatic updates

Automatic updating is explicitly post-alpha work. It must not be enabled by simply adding `electron-updater`, Electron `autoUpdater`, `setFeedURL`, or a periodic download call.

A future auto-update design requires a separate reviewed contract covering at minimum:

- trusted update endpoint and metadata format;
- cryptographic authenticity/signature verification before execution;
- version and channel pinning / anti-downgrade behavior;
- exact release identity and rollback rules;
- staged failure/recovery behavior;
- user-visible consent/restart policy;
- tests proving an untrusted or unsigned payload is rejected fail-closed.

Until that contract exists, the desktop alpha remains manual-update-only.
