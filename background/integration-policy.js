(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function text(value) { return String(value || "").trim(); }

  function categoryRank(task) {
    const haystack = [task?.id, task?.title, task?.objective, task?.subsystem, task?.kind]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    if (/\b(schema|migration|database|db|api|interface|contract|protocol|core|model)\b/.test(haystack)) return 0;
    if (/\b(test|tests|fixture|docs|documentation|readme|changelog)\b/.test(haystack)) return 2;
    return 1;
  }

  function taskDefinition(task) { return task?.definition || task || {}; }

  function deterministicIntegrationOrder(tasks = []) {
    const entries = tasks.map((task) => ({ ...clone(task), definition: clone(taskDefinition(task)) }));
    const byId = new Map(entries.map((task) => [String(task.id), task]));
    const indegree = new Map(entries.map((task) => [String(task.id), 0]));
    const children = new Map(entries.map((task) => [String(task.id), []]));

    for (const task of entries) {
      const id = String(task.id);
      for (const dependency of task.dependencies || task.definition?.dependencies || []) {
        const dep = String(dependency);
        if (!byId.has(dep)) continue;
        indegree.set(id, (indegree.get(id) || 0) + 1);
        children.get(dep).push(id);
      }
    }

    const sortReady = (ids) => ids.sort((a, b) => {
      const left = byId.get(a);
      const right = byId.get(b);
      return categoryRank(taskDefinition(left)) - categoryRank(taskDefinition(right))
        || (Number(right?.priority) || Number(right?.definition?.priority) || 0) - (Number(left?.priority) || Number(left?.definition?.priority) || 0)
        || a.localeCompare(b);
    });

    const ready = sortReady([...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id));
    const order = [];
    while (ready.length) {
      const id = ready.shift();
      order.push(id);
      for (const child of children.get(id) || []) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) {
          ready.push(child);
          sortReady(ready);
        }
      }
    }
    if (order.length !== entries.length) return { ok: false, reason: "integration_dag_cycle" };
    return { ok: true, order };
  }

  function approvedArtifacts(tasks, order) {
    const byId = new Map(tasks.map((task) => [String(task.id), task]));
    const artifacts = [];
    for (const taskId of order) {
      const task = byId.get(taskId);
      const artifact = task?.lastArtifact || null;
      if (!artifact?.commit || !artifact?.branch) continue;
      artifacts.push({
        taskId,
        branch: String(artifact.branch),
        commit: String(artifact.commit).toLowerCase(),
        changedFiles: [...new Set((artifact.changedFiles || []).map(String).filter(Boolean))].sort()
      });
    }
    return artifacts;
  }

  function commandValue(value) {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") return String(value.command || value.cmd || "").trim();
    return "";
  }

  function verificationCommands(project, tasks = []) {
    const values = [];
    const add = (value) => {
      const command = commandValue(value);
      if (command && !values.includes(command)) values.push(command);
    };
    const discovery = project?.artifacts?.DISCOVERY || {};
    for (const key of ["testCommands", "lintCommands", "typecheckCommands"]) {
      for (const value of Array.isArray(discovery?.[key]) ? discovery[key] : []) add(value);
    }
    for (const task of tasks) {
      for (const value of Array.isArray(task?.verification) ? task.verification : []) add(value);
    }
    return values.slice(0, 24);
  }

  function integrationBranchName(projectId, runId) {
    const slug = root.GitProvider?.slugBranchComponent || ((value) => String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-"));
    return `orchestra/${slug(projectId)}/integration/${slug(runId)}`;
  }

  function normalizeConflictPayload(payload, expectedTaskIds = []) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "integration_conflict_payload_invalid" };
    const conflictType = text(payload.conflictType).toLowerCase();
    if (!new Set(["text", "semantic"]).has(conflictType)) return { ok: false, reason: "integration_conflict_type_invalid" };
    const expected = new Set(expectedTaskIds.map(String));
    const currentTaskId = text(payload.currentTaskId) || null;
    if (currentTaskId && !expected.has(currentTaskId)) return { ok: false, reason: "integration_conflict_current_task_invalid" };
    const mergedTaskIds = Array.isArray(payload.mergedTaskIds) ? payload.mergedTaskIds.map(String) : [];
    if (mergedTaskIds.some((id) => !expected.has(id))) return { ok: false, reason: "integration_conflict_progress_invalid" };
    const responsibleTaskIds = [...new Set((Array.isArray(payload.responsibleTaskIds) ? payload.responsibleTaskIds : []).map(String).filter((id) => expected.has(id)))];
    const files = [...new Set((Array.isArray(payload.files) ? payload.files : []).map(String).filter(Boolean))].sort();
    const failedChecks = (Array.isArray(payload.failedChecks) ? payload.failedChecks : []).map((item) => {
      if (typeof item === "string") return { command: item, evidence: "" };
      return { command: text(item?.command), evidence: text(item?.evidence || item?.summary) };
    }).filter((item) => item.command);
    if (conflictType === "text" && !files.length) return { ok: false, reason: "integration_text_conflict_files_missing" };
    if (conflictType === "semantic" && !failedChecks.length) return { ok: false, reason: "integration_semantic_failed_checks_missing" };
    return {
      ok: true,
      conflict: {
        conflictType,
        currentTaskId,
        mergedTaskIds,
        responsibleTaskIds,
        files,
        failedChecks,
        summary: text(payload.summary),
        repairHint: text(payload.repairHint)
      }
    };
  }

  function identifyResponsibleTasks(conflict, tasks = [], order = []) {
    const byId = new Map(tasks.map((task) => [String(task.id), task]));
    const responsible = new Set((conflict?.responsibleTaskIds || []).filter((id) => byId.has(id)));
    if (conflict?.currentTaskId && byId.has(conflict.currentTaskId)) responsible.add(conflict.currentTaskId);
    if (conflict?.conflictType === "text") {
      const files = new Set(conflict.files || []);
      for (const task of tasks) {
        const changed = task?.lastArtifact?.changedFiles || [];
        if (changed.some((file) => files.has(String(file)))) responsible.add(String(task.id));
      }
    }
    const index = new Map(order.map((id, position) => [id, position]));
    return [...responsible].sort((a, b) => (index.get(a) ?? Number.MAX_SAFE_INTEGER) - (index.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
  }

  function validateMergeProgress(conflict, mergeTaskIds) {
    const merged = conflict?.mergedTaskIds || [];
    for (let index = 0; index < merged.length; index += 1) {
      if (merged[index] !== mergeTaskIds[index]) return { ok: false, reason: "integration_merge_progress_not_prefix" };
    }
    if (conflict?.currentTaskId) {
      const expectedCurrent = mergeTaskIds[merged.length];
      if (expectedCurrent && conflict.currentTaskId !== expectedCurrent) return { ok: false, reason: "integration_conflict_current_task_out_of_order", expectedCurrent };
    }
    return { ok: true };
  }

  function validateDonePayload(payload, run) {
    const integration = payload?.integration;
    if (!integration || typeof integration !== "object" || Array.isArray(integration)) return { ok: false, reason: "integration_result_missing" };
    const mergedTaskIds = Array.isArray(integration.mergedTaskIds) ? integration.mergedTaskIds.map(String) : [];
    if (JSON.stringify(mergedTaskIds) !== JSON.stringify(run.mergeTaskIds || [])) return { ok: false, reason: "integration_merge_order_mismatch" };
    const checks = Array.isArray(integration.checks) ? integration.checks : [];
    const byCommand = new Map(checks.map((item) => [text(item?.command), item]));
    for (const command of run.verificationCommands || []) {
      const check = byCommand.get(command);
      if (!check || String(check.status || "").toUpperCase() !== "PASS" || !text(check.evidence || check.summary)) {
        return { ok: false, reason: "integration_verification_incomplete", command };
      }
    }
    return {
      ok: true,
      result: {
        branch: text(integration.branch),
        commit: text(integration.commit).toLowerCase(),
        baseSha: text(integration.baseSha).toLowerCase(),
        targetBranch: text(integration.targetBranch),
        mergedTaskIds,
        changedFiles: [...new Set((Array.isArray(integration.changedFiles) ? integration.changedFiles : []).map(String).filter(Boolean))].sort(),
        checks: checks.map((item) => ({ command: text(item?.command), status: String(item?.status || "").toUpperCase(), evidence: text(item?.evidence || item?.summary) })),
        summary: text(integration.summary)
      }
    };
  }

  root.IntegrationPolicy = Object.freeze({
    categoryRank,
    deterministicIntegrationOrder,
    approvedArtifacts,
    verificationCommands,
    integrationBranchName,
    normalizeConflictPayload,
    identifyResponsibleTasks,
    validateMergeProgress,
    validateDonePayload
  });

  if (typeof module !== "undefined" && module.exports) module.exports = root.IntegrationPolicy;
})();
