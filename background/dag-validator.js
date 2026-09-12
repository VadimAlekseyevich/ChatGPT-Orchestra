(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function asStrings(value) {
    return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
  }

  function validateTaskGraph(graph) {
    const errors = [];
    const warnings = [];
    if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
      return { ok: false, errors: [{ code: "graph_not_object" }], warnings, topologicalOrder: [], stats: { tasks: 0 } };
    }

    const tasks = Array.isArray(graph.tasks) ? graph.tasks : [];
    if (!tasks.length) errors.push({ code: "tasks_empty" });
    if (tasks.length > 100) errors.push({ code: "tasks_limit_exceeded", count: tasks.length });

    const byId = new Map();
    for (const raw of tasks) {
      const task = raw && typeof raw === "object" ? raw : {};
      const id = String(task.id || "").trim();
      if (!id) { errors.push({ code: "task_id_missing" }); continue; }
      if (byId.has(id)) { errors.push({ code: "task_id_duplicate", taskId: id }); continue; }
      byId.set(id, task);
      if (!String(task.title || "").trim()) errors.push({ code: "task_title_missing", taskId: id });
      if (!String(task.objective || "").trim()) errors.push({ code: "task_objective_missing", taskId: id });
      const acceptance = asStrings(task.acceptanceCriteria);
      if (!acceptance.length) errors.push({ code: "acceptance_criteria_missing", taskId: id });
      const allow = asStrings(task.scope?.allow);
      if (!allow.length) errors.push({ code: "scope_allow_missing", taskId: id });
      const kind = String(task.kind || "code").toLowerCase();
      const verification = asStrings(task.verification);
      if (kind === "code" && !verification.length && !String(task.verificationWaiver || "").trim()) {
        errors.push({ code: "verification_missing", taskId: id });
      }
      if (kind === "code" && verification.length > 12) warnings.push({ code: "verification_large", taskId: id });
      if (acceptance.length > 12) warnings.push({ code: "task_maybe_oversized", taskId: id });
    }

    const indegree = new Map();
    const outgoing = new Map();
    for (const id of byId.keys()) { indegree.set(id, 0); outgoing.set(id, []); }
    for (const [id, task] of byId) {
      const dependencies = asStrings(task.dependencies);
      const unique = new Set();
      for (const dep of dependencies) {
        if (unique.has(dep)) { warnings.push({ code: "dependency_duplicate", taskId: id, dependencyId: dep }); continue; }
        unique.add(dep);
        if (dep === id) { errors.push({ code: "self_dependency", taskId: id }); continue; }
        if (!byId.has(dep)) { errors.push({ code: "dependency_missing", taskId: id, dependencyId: dep }); continue; }
        indegree.set(id, (indegree.get(id) || 0) + 1);
        outgoing.get(dep).push(id);
      }
    }

    const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id).sort();
    const topologicalOrder = [];
    while (queue.length) {
      const id = queue.shift();
      topologicalOrder.push(id);
      for (const next of outgoing.get(id) || []) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) { queue.push(next); queue.sort(); }
      }
    }
    if (topologicalOrder.length !== byId.size) {
      const cyclic = [...byId.keys()].filter((id) => !topologicalOrder.includes(id));
      errors.push({ code: "dependency_cycle", taskIds: cyclic });
    }

    const coverage = asStrings(graph.objectiveCoveredBy);
    if (!coverage.length) errors.push({ code: "objective_coverage_missing" });
    for (const id of coverage) if (!byId.has(id)) errors.push({ code: "objective_coverage_unknown_task", taskId: id });
    const terminalIds = [...byId.keys()].filter((id) => (outgoing.get(id) || []).length === 0);
    if (coverage.length && !coverage.some((id) => terminalIds.includes(id))) {
      warnings.push({ code: "objective_coverage_has_no_terminal_task" });
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      topologicalOrder,
      stats: {
        tasks: byId.size,
        roots: [...byId.keys()].filter((id) => (asStrings(byId.get(id).dependencies)).length === 0).length,
        terminals: terminalIds.length
      }
    };
  }

  root.validateTaskGraph = validateTaskGraph;
  if (typeof module !== "undefined" && module.exports) module.exports = { validateTaskGraph };
})();