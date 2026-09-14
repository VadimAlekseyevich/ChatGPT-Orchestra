"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  OWNER,
  REPOSITORY,
  validateCliArgs
} = require("./validate-alpha-evidence-reference.js");

const ALPHA_VERSION = "2.0.0-alpha.20";
const PLACEHOLDER = /(?:<[^>]+>|\b(?:todo|pending|tbd)\b)/i;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseEvidenceFields(body) {
  const fields = new Map();
  for (const rawLine of String(body || "").replace(/\r\n/g, "\n").split("\n")) {
    const match = rawLine.match(/^\s*([^:#][^:]{0,79}):\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    if (!key || fields.has(key)) continue;
    fields.set(key, match[2].trim());
  }
  return fields;
}

function invalid(reason) {
  return { ok: false, reason };
}

function valueFor(fields, name) {
  return String(fields.get(String(name).toLowerCase()) || "").trim();
}

function requireValue(fields, scenarioId, name) {
  const value = valueFor(fields, name);
  if (!value) return invalid(`alpha_manual_evidence_field_missing:${scenarioId}:${name}`);
  if (PLACEHOLDER.test(value)) return invalid(`alpha_manual_evidence_field_placeholder:${scenarioId}:${name}`);
  return { ok: true, value };
}

function requirePass(fields, scenarioId, name) {
  const result = requireValue(fields, scenarioId, name);
  if (!result.ok) return result;
  if (result.value.toUpperCase() !== "PASS") return invalid(`alpha_manual_evidence_field_not_pass:${scenarioId}:${name}`);
  return result;
}

function requireUtc(fields, scenarioId, name) {
  const result = requireValue(fields, scenarioId, name);
  if (!result.ok) return result;
  if (!UTC_ISO.test(result.value) || !Number.isFinite(Date.parse(result.value))) {
    return invalid(`alpha_manual_evidence_timestamp_invalid:${scenarioId}:${name}`);
  }
  return { ok: true, value: result.value, timestamp: Date.parse(result.value) };
}

function validateCommon(fields, scenarioId) {
  const scenario = requireValue(fields, scenarioId, "Scenario");
  if (!scenario.ok) return scenario;
  if (scenario.value.toUpperCase() !== scenarioId) return invalid(`alpha_manual_evidence_scenario_mismatch:${scenarioId}`);

  const result = requirePass(fields, scenarioId, "Result");
  if (!result.ok) return result;

  const version = requireValue(fields, scenarioId, "Alpha version");
  if (!version.ok) return version;
  if (version.value !== ALPHA_VERSION) return invalid(`alpha_manual_evidence_version_mismatch:${scenarioId}`);

  const tester = requireValue(fields, scenarioId, "Tester");
  if (!tester.ok) return tester;
  const timestamp = requireUtc(fields, scenarioId, "Timestamp UTC");
  if (!timestamp.ok) return timestamp;
  return { ok: true, tester: tester.value, timestampUtc: timestamp.value };
}

function validateEvidenceCommentBody(scenarioId, body) {
  const id = String(scenarioId || "").trim().toUpperCase();
  if (!new Set(["A01", "A11"]).has(id)) return invalid(`alpha_manual_evidence_scenario_invalid:${id || "missing"}`);
  const fields = parseEvidenceFields(body);
  const common = validateCommon(fields, id);
  if (!common.ok) return common;

  if (id === "A01") {
    for (const name of ["Windows version", "Fresh profile"]) {
      const checked = requireValue(fields, id, name);
      if (!checked.ok) return checked;
    }
    for (const name of ["Install/launch", "ChatGPT interactive login", "Lead registration/readiness"]) {
      const checked = requirePass(fields, id, name);
      if (!checked.ok) return checked;
    }
    const privacy = requireValue(fields, id, "Export privacy check");
    if (!privacy.ok) return privacy;
    if (!/^PASS(?:\b|\s|—|-)/i.test(privacy.value)) return invalid(`alpha_manual_evidence_field_not_pass:${id}:Export privacy check`);
    return { ok: true, scenarioId: id, tester: common.tester, timestampUtc: common.timestampUtc };
  }

  for (const name of ["Project/repository reference", "State before OS restart", "State after relaunch/reconciliation"]) {
    const checked = requireValue(fields, id, name);
    if (!checked.ok) return checked;
  }
  for (const name of ["Real OS restart performed", "Resume result", "Duplicate irreversible side effects check", "Worktree/state preservation"]) {
    const checked = requirePass(fields, id, name);
    if (!checked.ok) return checked;
  }
  const before = requireUtc(fields, id, "Pre-restart systemBootTimeUtc");
  if (!before.ok) return before;
  const after = requireUtc(fields, id, "Post-restart systemBootTimeUtc");
  if (!after.ok) return after;
  if (after.timestamp <= before.timestamp) return invalid(`alpha_manual_evidence_boot_time_not_advanced:${id}`);

  return {
    ok: true,
    scenarioId: id,
    tester: common.tester,
    timestampUtc: common.timestampUtc,
    preRestartSystemBootTimeUtc: before.value,
    postRestartSystemBootTimeUtc: after.value
  };
}

async function fetchComment(reference, { token, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new Error("github_token_missing_for_manual_evidence_validation");
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable_for_manual_evidence_validation");
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/issues/comments/${reference.commentId}`;
  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "chatgpt-orchestra-alpha-evidence-validator"
    }
  });
  if (!response?.ok) throw new Error(`alpha_manual_evidence_comment_fetch_failed:${reference.scenarioId}:${response?.status || "unknown"}`);
  const comment = await response.json();
  if (String(comment?.html_url || "") !== reference.reference) throw new Error(`alpha_manual_evidence_comment_url_mismatch:${reference.scenarioId}`);
  return comment;
}

async function validateEvidenceComments(args, { token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
  const references = validateCliArgs(args);
  const scenarios = [];
  for (const reference of references) {
    const comment = await fetchComment(reference, { token, fetchImpl });
    const validation = validateEvidenceCommentBody(reference.scenarioId, comment?.body || "");
    if (!validation.ok) throw new Error(validation.reason);
    scenarios.push({
      scenarioId: reference.scenarioId,
      reference: reference.reference,
      issueNumber: reference.issueNumber,
      commentId: reference.commentId,
      author: String(comment?.user?.login || ""),
      createdAt: String(comment?.created_at || ""),
      updatedAt: String(comment?.updated_at || ""),
      bodySha256: crypto.createHash("sha256").update(String(comment?.body || ""), "utf8").digest("hex"),
      evidence: validation
    });
  }
  return {
    schemaVersion: 1,
    alphaVersion: ALPHA_VERSION,
    validatedAtUtc: new Date(clock()).toISOString(),
    scenarios
  };
}

function writeValidationOutput(result, outputPath) {
  const target = path.resolve(String(outputPath));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

if (require.main === module) {
  validateEvidenceComments(process.argv.slice(2))
    .then((result) => {
      const output = process.env.ALPHA_EVIDENCE_VALIDATION_OUTPUT;
      if (output) writeValidationOutput(result, output);
      console.log(`manual alpha evidence comments ok: ${result.scenarios.map((item) => `${item.scenarioId}=comment-${item.commentId}`).join("; ")}`);
    })
    .catch((error) => {
      console.error(String(error?.message || error));
      process.exitCode = 1;
    });
}

module.exports = {
  ALPHA_VERSION,
  parseEvidenceFields,
  validateEvidenceCommentBody,
  fetchComment,
  validateEvidenceComments,
  writeValidationOutput
};
