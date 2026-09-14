# Phase 18 Live Validation

Phase 18 automation is complete only when the packaged desktop runtime is exercised against a real authenticated ChatGPT session without the extension acting as the executor.

## Preconditions

- Use the Windows artifact produced from the current `phase18-managed-browser-runtime` head.
- Launch Orchestra in managed-browser mode.
- Keep the extension absent or disabled for the direct-runtime validation.
- Sign in only inside Orchestra's isolated managed-browser profile.
- Do not copy browser cookies, credentials, page identifiers, or profile paths into project state or validation notes.

## Validation flow

1. Open ChatGPT from the managed-browser onboarding panel and complete login.
2. Confirm the page reports ready, then register the active page as Lead.
3. Start the reference project and allow the six planning stages to complete through the direct protocol bridge.
4. Run at least two independent Worker tasks concurrently and verify that the validation checklist records overlapping Worker runs.
5. Complete independent Review and observe a dependency unlock before the dependent Worker executes.
6. Complete Integration and reach `INTEGRATION_VERIFIED`.
7. Exercise Stop Generation once and confirm the active completion monitor is cancelled without publishing a partial assistant completion.
8. Exercise a fresh-page/session replacement and confirm the logical agent can recover without changing its Orchestra identity.
9. Export managed-browser validation evidence and the portable project bundle.
10. Inspect both exports and confirm they contain no browser URL, page/session identifier, browser-profile path, cookie, credential, prompt text, or assistant response text.

## Pass condition

The run passes when the managed-browser validation checklist is complete, Integration is verified, recovery remains healthy, and exported evidence stays within the documented privacy boundary.

The live-validation evidence is intentionally whitelist-built from booleans, enum-like states, timestamps, and counters rather than by serializing and redacting a larger runtime object.
