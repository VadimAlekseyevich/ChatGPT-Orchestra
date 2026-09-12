(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const BEGIN = "@@ORCH_ARTIFACT_BEGIN";
  const END = "@@ORCH_ARTIFACT_END";
  const MAX_BYTES = 262144;

  function parsePlanningArtifact(text, { maxLength = MAX_BYTES } = {}) {
    const raw = String(text || "");
    const start = raw.lastIndexOf(BEGIN);
    const end = raw.lastIndexOf(END);
    if (start < 0 || end < 0 || end <= start) return { ok: false, reason: "planning_artifact_markers_missing" };
    const body = raw.slice(start + BEGIN.length, end).trim();
    if (!body || body.length > maxLength) return { ok: false, reason: body ? "planning_artifact_too_large" : "planning_artifact_empty" };
    try {
      const artifact = JSON.parse(body);
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return { ok: false, reason: "planning_artifact_not_object" };
      return { ok: true, artifact };
    } catch (_) {
      return { ok: false, reason: "planning_artifact_invalid_json" };
    }
  }

  root.PlanningArtifactParser = Object.freeze({ BEGIN, END, MAX_BYTES, parsePlanningArtifact });
  if (typeof module !== "undefined" && module.exports) module.exports = root.PlanningArtifactParser;
})();