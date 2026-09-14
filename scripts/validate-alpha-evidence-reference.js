"use strict";

const assert = require("node:assert/strict");

const OWNER = "VadimAlekseyevich";
const REPOSITORY = "ChatGPT-Orchestra";
const SCENARIOS = new Set(["A01", "A11"]);
const ISSUE_COMMENT_PATH = new RegExp(`^/${OWNER}/${REPOSITORY}/issues/([1-9][0-9]*)$`, "i");
const ISSUE_COMMENT_HASH = /^#issuecomment-([1-9][0-9]*)$/i;

function validateEvidenceReference(scenarioId, rawReference) {
  const id = String(scenarioId || "").trim().toUpperCase();
  if (!SCENARIOS.has(id)) return { ok: false, reason: `alpha_manual_evidence_scenario_invalid:${id || "missing"}` };

  const reference = String(rawReference || "").trim();
  if (!reference) return { ok: false, reason: `alpha_manual_evidence_missing:${id}` };

  let url;
  try {
    url = new URL(reference);
  } catch (_) {
    return { ok: false, reason: `alpha_manual_evidence_url_invalid:${id}` };
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return { ok: false, reason: `alpha_manual_evidence_host_invalid:${id}` };
  }
  if (url.username || url.password || url.search) {
    return { ok: false, reason: `alpha_manual_evidence_url_unsafe:${id}` };
  }

  const issueMatch = url.pathname.match(ISSUE_COMMENT_PATH);
  const commentMatch = url.hash.match(ISSUE_COMMENT_HASH);
  if (!issueMatch || !commentMatch) {
    return { ok: false, reason: `alpha_manual_evidence_comment_permalink_required:${id}` };
  }

  return {
    ok: true,
    scenarioId: id,
    reference: url.toString(),
    issueNumber: Number(issueMatch[1]),
    commentId: Number(commentMatch[1])
  };
}

function validateCliArgs(args) {
  assert.equal(args.length, 4, "usage: node scripts/validate-alpha-evidence-reference.js A01 <comment-url> A11 <comment-url>");
  const first = validateEvidenceReference(args[0], args[1]);
  const second = validateEvidenceReference(args[2], args[3]);
  for (const result of [first, second]) {
    if (!result.ok) throw new Error(result.reason);
  }
  assert.notEqual(first.reference, second.reference, "alpha_manual_evidence_refs_must_be_distinct");
  return [first, second];
}

if (require.main === module) {
  try {
    const results = validateCliArgs(process.argv.slice(2));
    console.log(`manual alpha evidence references ok: ${results.map((item) => `${item.scenarioId}=issue#${item.issueNumber}/comment-${item.commentId}`).join("; ")}`);
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  OWNER,
  REPOSITORY,
  validateEvidenceReference,
  validateCliArgs
};
