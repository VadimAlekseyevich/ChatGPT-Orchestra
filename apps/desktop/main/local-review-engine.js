"use strict";

const MAX_REVIEW_PATCH_CHARS = 18000;
const MAX_REVIEW_FILE_PATCH_CHARS = 6000;

function boundedLocalDiff(comparison = {}) {
  const sourceFiles = Array.isArray(comparison.files) ? comparison.files : [];
  const files = [];
  let patchBudget = MAX_REVIEW_PATCH_CHARS;
  let truncated = false;
  for (const file of sourceFiles) {
    const rawPatch = String(file?.patch || "");
    const fileLimit = Math.min(MAX_REVIEW_FILE_PATCH_CHARS, Math.max(0, patchBudget));
    let patch = rawPatch;
    if (rawPatch.length > fileLimit) {
      patch = fileLimit > 0 ? `${rawPatch.slice(0, fileLimit)}…` : "";
      truncated = true;
    }
    patchBudget -= Math.min(rawPatch.length, fileLimit);
    files.push({
      filename: String(file?.filename || ""),
      previousFilename: file?.previousFilename || file?.previous_filename || null,
      status: file?.status || "modified",
      additions: Number(file?.additions) || 0,
      deletions: Number(file?.deletions) || 0,
      changes: Number(file?.changes) || 0,
      patch: patch || null
    });
    if (patchBudget <= 0 && files.length < sourceFiles.length) { truncated = true; break; }
  }
  if (files.length < sourceFiles.length) truncated = true;
  return {
    status: comparison.status || null,
    aheadBy: Number(comparison.ahead_by ?? comparison.aheadBy) || 0,
    behindBy: Number(comparison.behind_by ?? comparison.behindBy) || 0,
    totalCommits: Number(comparison.total_commits ?? comparison.totalCommits) || 0,
    files,
    truncatedForReviewPacket: truncated
  };
}

function createLocalReviewEngine(BaseReviewEngine) {
  if (typeof BaseReviewEngine !== "function") throw new TypeError("base_review_engine_required");
  return class LocalReviewEngine extends BaseReviewEngine {
    constructor(options = {}) {
      super(options);
      this.repositoryService = options.repositoryService || null;
    }

    async reviewDiff(project, artifact) {
      if (artifact?.localOnly === true) {
        if (!this.repositoryService?.workspaceReviewComparison || !artifact.repositoryId || !artifact.workspaceId) {
          return { ok: false, reason: "local_review_diff_unavailable" };
        }
        const result = await this.repositoryService.workspaceReviewComparison({
          projectId: project?.projectId,
          repositoryId: artifact.repositoryId,
          workspaceId: artifact.workspaceId
        });
        if (!result?.ok) return result || { ok: false, reason: "local_review_diff_unavailable" };
        const diff = boundedLocalDiff(result.comparison || {});
        if (diff.truncatedForReviewPacket) return { ok: false, reason: "review_diff_too_large", diff };
        return { ok: true, diff };
      }
      return super.reviewDiff(project, artifact);
    }
  };
}

module.exports = { createLocalReviewEngine, boundedLocalDiff, MAX_REVIEW_PATCH_CHARS, MAX_REVIEW_FILE_PATCH_CHARS };
