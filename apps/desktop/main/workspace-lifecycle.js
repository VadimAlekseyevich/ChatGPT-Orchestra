"use strict";

const DEFAULT_ABANDONED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class WorkspaceLifecyclePolicy {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
  }

  records(adapter) {
    return [...(adapter?.workspaces?.values?.() || [])].map((record) => ({ ...record }));
  }

  async scan(adapter, { activeWorkspaceIds = [], retentionMs = DEFAULT_ABANDONED_RETENTION_MS } = {}) {
    const active = new Set((activeWorkspaceIds || []).map(String));
    const now = this.clock();
    const items = [];
    for (const record of this.records(adapter)) {
      const ageMs = Math.max(0, now - (Number(record.createdAt) || now));
      let status = null;
      let missing = false;
      try {
        status = await adapter.status(record.workspaceId);
      } catch (error) {
        if (["git_workspace_missing", "git_workspace_not_found"].includes(String(error?.message || ""))) missing = true;
        else throw error;
      }
      let classification;
      if (active.has(record.workspaceId)) classification = "active";
      else if (missing) classification = "missing";
      else if (status?.clean !== true) classification = "salvage";
      else if (ageMs >= Math.max(0, Number(retentionMs) || DEFAULT_ABANDONED_RETENTION_MS)) classification = "cleanup-eligible";
      else classification = "retained";
      items.push({
        workspaceId: record.workspaceId,
        kind: record.kind,
        taskId: record.taskId || null,
        runId: record.runId,
        branch: record.branch,
        startSha: record.startSha,
        createdAt: record.createdAt,
        ageMs,
        classification,
        clean: status?.clean ?? null,
        head: status?.head || null,
        changedFiles: status?.changedFiles || []
      });
    }
    return {
      ok: true,
      retentionMs,
      counts: items.reduce((acc, item) => { acc[item.classification] = (acc[item.classification] || 0) + 1; return acc; }, {}),
      items
    };
  }

  async cleanup(adapter, options = {}) {
    const report = await this.scan(adapter, options);
    const cleaned = [];
    const failed = [];
    for (const item of report.items.filter((entry) => entry.classification === "cleanup-eligible")) {
      try {
        await adapter.cleanup(item.workspaceId, { force: false, deleteBranch: true });
        cleaned.push(item.workspaceId);
      } catch (error) {
        failed.push({ workspaceId: item.workspaceId, reason: String(error?.message || "cleanup_failed") });
      }
    }
    return {
      ok: failed.length === 0,
      cleaned,
      failed,
      salvage: report.items.filter((item) => item.classification === "salvage"),
      retained: report.items.filter((item) => ["active", "retained"].includes(item.classification)),
      missing: report.items.filter((item) => item.classification === "missing")
    };
  }
}

module.exports = { WorkspaceLifecyclePolicy, DEFAULT_ABANDONED_RETENTION_MS };
