(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const BEGIN = "@@ORCH_WORKER_ARTIFACT_BEGIN";
  const END = "@@ORCH_WORKER_ARTIFACT_END";
  const MAX_BYTES = 192 * 1024;

  function canonicalize(value) {
    if (root.PlanningArtifactParser?.canonicalize) return root.PlanningArtifactParser.canonicalize(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }

  function artifactSignature(value) {
    if (root.PlanningArtifactParser?.artifactSignature) return root.PlanningArtifactParser.artifactSignature(value);
    const text = canonicalize(value);
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= BigInt(text.charCodeAt(index));
      hash = (hash * prime) & mask;
    }
    return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
  }

  function utf8Bytes(value) {
    const text = String(value || "");
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return text.length;
  }

  function parseWorkerArtifact(text, { maxBytes = MAX_BYTES } = {}) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const begins = [];
    const ends = [];
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed === BEGIN) begins.push(index);
      if (trimmed === END) ends.push(index);
    }
    if (!begins.length || !ends.length) return { ok: false, reason: "worker_artifact_markers_missing" };
    if (begins.length !== 1 || ends.length !== 1) return { ok: false, reason: "worker_artifact_marker_ambiguous" };
    const start = begins[0];
    const end = ends[0];
    if (end <= start) return { ok: false, reason: "worker_artifact_markers_invalid_order" };
    const body = lines.slice(start + 1, end).join("\n").trim();
    if (!body) return { ok: false, reason: "worker_artifact_empty" };
    if (utf8Bytes(body) > maxBytes) return { ok: false, reason: "worker_artifact_too_large" };
    try {
      const artifact = JSON.parse(body);
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return { ok: false, reason: "worker_artifact_not_object" };
      if (String(artifact.format || "") !== "file-set-v1") return { ok: false, reason: "worker_artifact_format_invalid" };
      return { ok: true, artifact, signature: artifactSignature(artifact), bytes: utf8Bytes(body) };
    } catch (_) {
      return { ok: false, reason: "worker_artifact_invalid_json" };
    }
  }

  root.WorkerArtifactParser = Object.freeze({ BEGIN, END, MAX_BYTES, canonicalize, artifactSignature, parseWorkerArtifact });
  if (typeof module !== "undefined" && module.exports) module.exports = root.WorkerArtifactParser;
})();
