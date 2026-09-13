(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const BUNDLE_FORMAT = "chatgpt-orchestra-project-bundle";
  const BUNDLE_VERSION = 1;
  const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function fnv1a64(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (const byte of bytes) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(16).padStart(16, "0");
  }

  function checksumPayload(bundle) {
    const copy = clone(bundle);
    if (copy?.manifest) delete copy.manifest.checksum;
    return canonicalize(copy);
  }

  function bundleChecksum(bundle) { return fnv1a64(checksumPayload(bundle)); }

  function byteLength(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return new TextEncoder().encode(text).length;
  }

  function parseBundle(input) {
    if (typeof input === "string") {
      if (byteLength(input) > MAX_BUNDLE_BYTES) return { ok: false, reason: "project_bundle_too_large" };
      try { return { ok: true, bundle: JSON.parse(input) }; }
      catch (_) { return { ok: false, reason: "project_bundle_invalid_json" }; }
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "project_bundle_not_object" };
    if (byteLength(input) > MAX_BUNDLE_BYTES) return { ok: false, reason: "project_bundle_too_large" };
    return { ok: true, bundle: clone(input) };
  }

  class ProjectBundleService {
    constructor({ portableStateManager, clock = () => Date.now(), sourceHost = "extension" } = {}) {
      this.portableStateManager = portableStateManager;
      this.clock = clock;
      this.sourceHost = String(sourceHost || "unknown");
    }

    async exportBundle({ projectId = null } = {}) {
      const captured = await this.portableStateManager?.capture?.({ projectId });
      if (!captured?.ok) return captured || { ok: false, reason: "portable_state_unavailable" };
      const state = captured.snapshot;
      const project = state.namespaces.projects.projects[state.projectId];
      const scheduler = state.namespaces.scheduler || {};
      const eventState = state.namespaces.events || {};
      const bundle = {
        format: BUNDLE_FORMAT,
        bundleVersion: BUNDLE_VERSION,
        schemaVersion: state.schemaVersion,
        manifest: {
          projectId: state.projectId,
          createdAt: this.clock(),
          sourceHost: this.sourceHost,
          repository: clone(project?.repository || null),
          checksumAlgorithm: "fnv1a64"
        },
        project: clone(project),
        state,
        events: clone(Array.isArray(eventState.events) ? eventState.events : []),
        decisions: clone(Array.isArray(scheduler.decisions) ? scheduler.decisions : []),
        artifacts: []
      };
      bundle.manifest.checksum = bundleChecksum(bundle);
      const serialized = JSON.stringify(bundle, null, 2);
      if (byteLength(serialized) > MAX_BUNDLE_BYTES) return { ok: false, reason: "project_bundle_too_large" };
      return {
        ok: true,
        bundle,
        serialized,
        filename: `chatgpt-orchestra-${state.projectId}.bundle.json`,
        bytes: byteLength(serialized)
      };
    }

    validateBundle(input) {
      const parsed = parseBundle(input);
      if (!parsed.ok) return parsed;
      const bundle = parsed.bundle;
      if (bundle.format !== BUNDLE_FORMAT) return { ok: false, reason: "project_bundle_format_invalid" };
      if (Number(bundle.bundleVersion) !== BUNDLE_VERSION) return { ok: false, reason: "project_bundle_version_unsupported", bundleVersion: bundle.bundleVersion };
      const projectId = String(bundle.manifest?.projectId || "").trim();
      if (!projectId || bundle.state?.projectId !== projectId || bundle.project?.projectId !== projectId) {
        return { ok: false, reason: "project_bundle_identity_mismatch" };
      }
      const checksum = String(bundle.manifest?.checksum || "");
      if (!checksum || checksum !== bundleChecksum(bundle)) return { ok: false, reason: "project_bundle_checksum_mismatch" };
      const stateCheck = this.portableStateManager?.validate?.(bundle.state);
      if (!stateCheck?.ok) return stateCheck || { ok: false, reason: "portable_state_invalid" };
      return { ok: true, bundle, projectId, schemaVersion: stateCheck.schemaVersion };
    }

    async importBundle(input, { replace = false } = {}) {
      const checked = this.validateBundle(input);
      if (!checked.ok) return checked;
      const imported = await this.portableStateManager.import(checked.bundle.state, { replace });
      if (!imported.ok) return imported;
      return {
        ok: true,
        projectId: checked.projectId,
        backupId: imported.backupId,
        appliedMigrations: imported.appliedMigrations || [],
        recoveryRequired: true
      };
    }
  }

  root.ProjectBundle = {
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    MAX_BUNDLE_BYTES,
    canonicalize,
    fnv1a64,
    bundleChecksum,
    parseBundle,
    ProjectBundleService
  };

  if (typeof module !== "undefined" && module.exports) module.exports = root.ProjectBundle;
})();
