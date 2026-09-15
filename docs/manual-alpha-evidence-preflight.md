# Manual Alpha Evidence Preflight

This helper reduces formatting and evidence mistakes in the two real Phase 20 manual gates. It validates exported Orchestra debug bundles and produces a ready-to-post A01 or A11 evidence comment only when the machine-checkable evidence is consistent and the tester explicitly confirms the actions that software cannot truthfully prove.

**This helper does not replace the real manual actions.** A01 still requires a real clean Windows profile/install and interactive ChatGPT login. A11 still requires a real Windows OS restart and a real recovery/resume check. The helper never performs those actions and never infers PASS from CI alone.

## A01 — fresh install and ChatGPT login

After testing the exact packaged candidate on a clean Windows user/VM, register an IDLE Lead and use **Export Debug** in Orchestra. Then run from the matching source checkout:

```powershell
npm run alpha:evidence -- A01 `
  --debug .\chatgpt-orchestra-debug-<project>.json `
  --tester "Vadim" `
  --fresh-profile "Disposable Windows VM; no previous Orchestra app-data" `
  --confirm-install-launch `
  --confirm-interactive-login `
  --out .\A01-evidence.txt
```

The A01 preflight checks the debug-bundle format, `2.0.0-alpha.20`, a 40-character build commit, Windows runtime evidence, a connected `IDLE` Lead, and the exported payload for forbidden credential/cookie/browser-profile/runtime-identifier fields. It refuses to emit PASS evidence unless `--confirm-install-launch` and `--confirm-interactive-login` are supplied explicitly.

The generated file is a structured evidence-comment draft. Review it, then post it as a separate issue comment in this repository. Do not edit the build commit to a different candidate.

## A11 — real OS restart and project resume

Use the **same exact candidate commit as A01**. Reach a persisted recoverable project state and export a debug bundle before reboot. Perform a real operating-system restart, relaunch the same installed build, allow recovery/reconciliation to complete, verify the project/worktrees and absence of duplicate irreversible effects, then export a second debug bundle.

Run:

```powershell
npm run alpha:evidence -- A11 `
  --before .\before-reboot.json `
  --after .\after-reboot.json `
  --tester "Vadim" `
  --project-ref "owner/repository alpha recovery validation" `
  --confirm-real-reboot `
  --confirm-resume `
  --confirm-no-duplicates `
  --confirm-worktree-preservation `
  --out .\A11-evidence.txt
```

The A11 preflight requires both exports to be valid Windows debug bundles from `2.0.0-alpha.20`, with the same exact build commit and the same project ID. `Post-restart systemBootTimeUtc` must be later than `Pre-restart systemBootTimeUtc`; an ordinary application relaunch on the same Windows boot fails this check. It also refuses PASS evidence unless `--confirm-real-reboot`, `--confirm-resume`, `--confirm-no-duplicates`, and `--confirm-worktree-preservation` are supplied explicitly.

## Final evidence and release workflow

A01 and A11 must be posted as two distinct GitHub issue comments. Pass their exact `#issuecomment-...` permalinks to the manual **Alpha Release Validation** workflow. That workflow independently fetches and validates the comments, requires both comments to match its exact `github.sha`, reruns the full alpha gate, requires valid Authenticode signatures, re-verifies the release bundle, and only then can publish `v2.0.0-alpha.20`.

If `main` changes after the manual test, the build commit changes and the final workflow will reject the older evidence. Repeat A01 and A11 on the new exact candidate rather than editing an old evidence comment to claim a different build.
