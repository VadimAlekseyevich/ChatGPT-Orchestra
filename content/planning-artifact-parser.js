(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const BEGIN = "@@ORCH_ARTIFACT_BEGIN";
  const END = "@@ORCH_ARTIFACT_END";
  const MAX_BYTES = 262144;

  function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function artifactSignature(value) {
    const text = canonicalize(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
  }

  function parsePlanningArtifact(text, { maxLength = MAX_BYTES } = {}) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const begins = [];
    const ends = [];
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed === BEGIN) begins.push(index);
      if (trimmed === END) ends.push(index);
    }
    if (!begins.length || !ends.length) return { ok: false, reason: "planning_artifact_markers_missing" };
    if (begins.length !== 1 || ends.length !== 1) return { ok: false, reason: "planning_artifact_marker_ambiguous" };
    const start = begins[0];
    const end = ends[0];
    if (end <= start) return { ok: false, reason: "planning_artifact_markers_invalid_order" };
    const body = lines.slice(start + 1, end).join("\n").trim();
    if (!body) return { ok: false, reason: "planning_artifact_empty" };
    if (body.length > maxLength) return { ok: false, reason: "planning_artifact_too_large" };
    try {
      const artifact = JSON.parse(body);
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return { ok: false, reason: "planning_artifact_not_object" };
      return { ok: true, artifact, signature: artifactSignature(artifact) };
    } catch (_) {
      return { ok: false, reason: "planning_artifact_invalid_json" };
    }
  }

  root.PlanningArtifactParser = Object.freeze({ BEGIN, END, MAX_BYTES, canonicalize, artifactSignature, parsePlanningArtifact });
  if (typeof module !== "undefined" && module.exports) module.exports = root.PlanningArtifactParser;
})();