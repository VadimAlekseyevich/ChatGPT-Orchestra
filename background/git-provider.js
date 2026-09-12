(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROVIDER_ID = "github-rest-v1";
  const API_BASE = "https://api.github.com";
  const CLEANUP_POLICY = "retain_until_review_or_manual_cleanup";

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isCommitSha(value) {
    return /^[0-9a-f]{40}$/i.test(String(value || "").trim());
  }

  function slugBranchComponent(value) {
    const normalized = String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/\.{2,}/g, ".")
      .slice(0, 72);
    return normalized || "unknown";
  }

  function taskBranchName(projectId, taskId, runId) {
    return `orchestra/${slugBranchComponent(projectId)}/${slugBranchComponent(taskId)}/${slugBranchComponent(runId)}`;
  }

  function normalizePath(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\/+/, "");
  }

  function normalizePattern(value) {
    return normalizePath(value).replace(/\/+$/g, "");
  }

  function escapeRegex(character) {
    return /[\\^$+?.()|{}\[\]]/.test(character) ? `\\${character}` : character;
  }

  function globToRegExp(pattern) {
    const source = normalizePattern(pattern);
    let output = "^";
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (char === "*") {
        if (source[index + 1] === "*") {
          output += ".*";
          index += 1;
        } else {
          output += "[^/]*";
        }
      } else if (char === "?") {
        output += "[^/]";
      } else {
        output += escapeRegex(char);
      }
    }
    output += "$";
    return new RegExp(output);
  }

  function matchesPattern(path, pattern) {
    const normalizedPath = normalizePath(path);
    const normalizedPattern = normalizePattern(pattern);
    if (!normalizedPath || !normalizedPattern) return false;
    if (normalizedPattern === "**" || normalizedPattern === "**/*" || normalizedPattern === "*") return true;
    try {
      return globToRegExp(normalizedPattern).test(normalizedPath);
    } catch (_) {
      return false;
    }
  }

  function validateChangedFiles(files, scope = {}) {
    const allow = Array.isArray(scope?.allow) ? scope.allow.filter(Boolean) : [];
    const deny = Array.isArray(scope?.deny) ? scope.deny.filter(Boolean) : [];
    const normalizedFiles = [...new Set((files || []).map(normalizePath).filter(Boolean))].sort();
    if (!allow.length) return { ok: false, reason: "task_scope_allow_missing", files: normalizedFiles, outsideScope: normalizedFiles, denied: [] };

    const outsideScope = [];
    const denied = [];
    for (const file of normalizedFiles) {
      if (deny.some((pattern) => matchesPattern(file, pattern))) denied.push(file);
      if (!allow.some((pattern) => matchesPattern(file, pattern))) outsideScope.push(file);
    }
    if (denied.length) return { ok: false, reason: "changed_file_denied", files: normalizedFiles, outsideScope, denied };
    if (outsideScope.length) return { ok: false, reason: "changed_file_outside_scope", files: normalizedFiles, outsideScope, denied };
    return { ok: true, files: normalizedFiles, outsideScope: [], denied: [] };
  }

  function requiresGitArtifact(task) {
    const kind = String(task?.kind || "code").trim().toLowerCase();
    return !["analysis", "research", "planning", "manual", "no-code", "nocode"].includes(kind);
  }

  function repoIdentity(project) {
    const owner = String(project?.repository?.owner || "").trim();
    const repo = String(project?.repository?.repo || "").trim();
    if (!owner || !repo) return null;
    return { owner, repo, fullName: `${owner}/${repo}` };
  }

  function normalizeReportedArtifact(payload = {}) {
    const candidate = isPlainObject(payload?.git) ? payload.git : payload;
    if (!isPlainObject(candidate)) return null;
    return {
      branch: String(candidate.branch || "").trim(),
      commit: String(candidate.commit || candidate.headCommit || "").trim().toLowerCase(),
      baseSha: String(candidate.baseSha || "").trim().toLowerCase(),
      targetBranch: String(candidate.targetBranch || "").trim(),
      changedFiles: Array.isArray(candidate.changedFiles) ? [...new Set(candidate.changedFiles.map(normalizePath).filter(Boolean))].sort() : null
    };
  }

  class GitHubRestProvider {
    constructor({ fetchImpl = globalThis.fetch, clock = () => Date.now(), apiBase = API_BASE, logger = console } = {}) {
      this.fetchImpl = fetchImpl;
      this.clock = clock;
      this.apiBase = apiBase.replace(/\/+$/g, "");
      this.logger = logger;
    }

    branchName(projectId, taskId, runId) {
      return taskBranchName(projectId, taskId, runId);
    }

    async request(path) {
      if (typeof this.fetchImpl !== "function") return { ok: false, reason: "git_provider_unavailable" };
      let response;
      try {
        response = await this.fetchImpl(`${this.apiBase}${path}`, {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
          },
          cache: "no-store"
        });
      } catch (error) {
        return { ok: false, reason: "git_provider_network_error", message: error?.message || String(error) };
      }

      if (!response?.ok) {
        const status = Number(response?.status) || 0;
        const remaining = response?.headers?.get?.("x-ratelimit-remaining");
        if (status === 403 && remaining === "0") return { ok: false, reason: "git_provider_rate_limited", status };
        if (status === 401) return { ok: false, reason: "git_provider_auth_required", status };
        if (status === 404) return { ok: false, reason: "git_repository_or_ref_unavailable", status };
        return { ok: false, reason: "git_provider_http_error", status };
      }

      try {
        return { ok: true, data: await response.json() };
      } catch (_) {
        return { ok: false, reason: "git_provider_invalid_json" };
      }
    }

    async getRepository(project) {
      const repo = repoIdentity(project);
      if (!repo) return { ok: false, reason: "git_repository_identity_missing" };
      const result = await this.request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`);
      if (!result.ok) return result;
      return { ok: true, repository: result.data };
    }

    async getBranchHead(project, branch) {
      const repo = repoIdentity(project);
      const normalizedBranch = String(branch || "").trim();
      if (!repo || !normalizedBranch) return { ok: false, reason: "git_branch_identity_missing" };
      const ref = normalizedBranch.split("/").map(encodeURIComponent).join("/");
      const result = await this.request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/ref/heads/${ref}`);
      if (!result.ok) return result;
      const sha = String(result.data?.object?.sha || "").toLowerCase();
      if (!isCommitSha(sha)) return { ok: false, reason: "git_branch_head_invalid" };
      return { ok: true, branch: normalizedBranch, sha };
    }

    async compare(project, baseSha, headSha) {
      const repo = repoIdentity(project);
      if (!repo || !isCommitSha(baseSha) || !isCommitSha(headSha)) return { ok: false, reason: "git_compare_identity_invalid" };
      const result = await this.request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/compare/${baseSha}...${headSha}`);
      if (!result.ok) return result;
      return { ok: true, comparison: result.data };
    }

    async captureBase(project) {
      const repository = await this.getRepository(project);
      if (!repository.ok) return repository;
      const defaultBranch = String(repository.repository?.default_branch || "").trim();
      if (!defaultBranch) return { ok: false, reason: "git_default_branch_missing" };
      const head = await this.getBranchHead(project, defaultBranch);
      if (!head.ok) return head;
      return {
        ok: true,
        snapshot: {
          provider: PROVIDER_ID,
          repositoryFullName: repoIdentity(project)?.fullName || "",
          defaultBranch,
          baseSha: head.sha,
          capturedAt: this.clock(),
          cleanupPolicy: CLEANUP_POLICY,
          lastCheckedAt: this.clock(),
          currentTargetSha: head.sha
        }
      };
    }

    async checkBaseFresh(project, snapshot) {
      if (!snapshot?.defaultBranch || !isCommitSha(snapshot?.baseSha)) return { ok: false, reason: "git_base_snapshot_missing" };
      const head = await this.getBranchHead(project, snapshot.defaultBranch);
      if (!head.ok) return head;
      if (head.sha !== String(snapshot.baseSha).toLowerCase()) {
        return {
          ok: false,
          reason: "target_branch_moved",
          expectedBaseSha: String(snapshot.baseSha).toLowerCase(),
          currentTargetSha: head.sha,
          checkedAt: this.clock()
        };
      }
      return { ok: true, currentTargetSha: head.sha, checkedAt: this.clock() };
    }

    async validateArtifact({ project, task, run, snapshot, payload } = {}) {
      if (!requiresGitArtifact(task)) return { ok: true, skipped: true, reason: "git_artifact_not_required" };
      if (!snapshot?.defaultBranch || !isCommitSha(snapshot?.baseSha)) return { ok: false, reason: "git_base_snapshot_missing" };
      const reported = normalizeReportedArtifact(payload);
      if (!reported) return { ok: false, reason: "git_artifact_missing" };

      const expectedBranch = String(run?.git?.branch || this.branchName(project?.projectId, task?.id, run?.runId)).trim();
      if (reported.branch !== expectedBranch) return { ok: false, reason: "git_branch_mismatch", expectedBranch, receivedBranch: reported.branch };
      if (!isCommitSha(reported.commit)) return { ok: false, reason: "git_commit_sha_invalid" };
      if (reported.baseSha && reported.baseSha !== String(snapshot.baseSha).toLowerCase()) {
        return { ok: false, reason: "git_reported_base_mismatch", expectedBaseSha: String(snapshot.baseSha).toLowerCase(), receivedBaseSha: reported.baseSha };
      }
      if (reported.targetBranch && reported.targetBranch !== snapshot.defaultBranch) {
        return { ok: false, reason: "git_target_branch_mismatch", expectedTargetBranch: snapshot.defaultBranch, receivedTargetBranch: reported.targetBranch };
      }
      if (!reported.changedFiles) return { ok: false, reason: "git_changed_files_missing" };

      const freshness = await this.checkBaseFresh(project, snapshot);
      if (!freshness.ok) return freshness;

      const branchHead = await this.getBranchHead(project, expectedBranch);
      if (!branchHead.ok) return { ...branchHead, reason: branchHead.reason === "git_repository_or_ref_unavailable" ? "git_task_branch_missing" : branchHead.reason };
      if (branchHead.sha !== reported.commit) {
        return { ok: false, reason: "git_branch_head_mismatch", expectedCommit: reported.commit, actualCommit: branchHead.sha };
      }

      const compared = await this.compare(project, snapshot.baseSha, reported.commit);
      if (!compared.ok) return compared;
      const comparison = compared.comparison || {};
      const mergeBaseSha = String(comparison?.merge_base_commit?.sha || "").toLowerCase();
      if (mergeBaseSha !== String(snapshot.baseSha).toLowerCase()) {
        return { ok: false, reason: "git_branch_not_based_on_snapshot", expectedBaseSha: String(snapshot.baseSha).toLowerCase(), mergeBaseSha };
      }
      if ((Number(comparison.ahead_by) || 0) < 1 || (Number(comparison.behind_by) || 0) !== 0) {
        return { ok: false, reason: "git_branch_not_fresh", aheadBy: Number(comparison.ahead_by) || 0, behindBy: Number(comparison.behind_by) || 0 };
      }

      const actualFiles = [];
      const scopePaths = [];
      for (const file of Array.isArray(comparison.files) ? comparison.files : []) {
        const filename = normalizePath(file?.filename);
        const previous = normalizePath(file?.previous_filename);
        if (filename) {
          actualFiles.push(filename);
          scopePaths.push(filename);
        }
        if (previous) scopePaths.push(previous);
      }
      const uniqueActualFiles = [...new Set(actualFiles)].sort();
      const uniqueScopePaths = [...new Set(scopePaths)].sort();
      if (!uniqueActualFiles.length) return { ok: false, reason: "git_no_changed_files" };
      if (uniqueActualFiles.length >= 300) return { ok: false, reason: "git_changed_files_may_be_truncated", changedFileCount: uniqueActualFiles.length };

      const scopeValidation = validateChangedFiles(uniqueScopePaths, task?.scope || {});
      if (!scopeValidation.ok) return { ...scopeValidation, actualChangedFiles: uniqueActualFiles };

      const reportedFiles = [...reported.changedFiles].sort();
      if (JSON.stringify(reportedFiles) !== JSON.stringify(uniqueActualFiles)) {
        return {
          ok: false,
          reason: "git_reported_changed_files_mismatch",
          reportedChangedFiles: reportedFiles,
          actualChangedFiles: uniqueActualFiles
        };
      }

      return {
        ok: true,
        artifact: {
          provider: PROVIDER_ID,
          branch: expectedBranch,
          commit: reported.commit,
          baseSha: String(snapshot.baseSha).toLowerCase(),
          targetBranch: snapshot.defaultBranch,
          changedFiles: uniqueActualFiles,
          aheadBy: Number(comparison.ahead_by) || 0,
          behindBy: Number(comparison.behind_by) || 0,
          verifiedAt: this.clock(),
          cleanupPolicy: snapshot.cleanupPolicy || CLEANUP_POLICY
        },
        freshness
      };
    }
  }

  root.GitProvider = Object.freeze({
    PROVIDER_ID,
    CLEANUP_POLICY,
    isCommitSha,
    slugBranchComponent,
    taskBranchName,
    normalizePath,
    globToRegExp,
    matchesPattern,
    validateChangedFiles,
    requiresGitArtifact,
    normalizeReportedArtifact,
    GitHubRestProvider
  });

  if (typeof module !== "undefined" && module.exports) module.exports = root.GitProvider;
})();
