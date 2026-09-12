(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function list(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
  }

  function scopePrefixes(task) {
    return list(task?.scope?.allow).map((pattern) => {
      const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
      const wildcard = normalized.search(/[?*\[]/);
      return (wildcard >= 0 ? normalized.slice(0, wildcard) : normalized).replace(/\/+$/g, "");
    }).filter(Boolean);
  }

  function prefixesOverlap(left, right) {
    const a = String(left || "").replace(/\/+$/g, "");
    const b = String(right || "").replace(/\/+$/g, "");
    if (!a || !b) return false;
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }

  function fileScopeOverlap(a, b) {
    const left = scopePrefixes(a);
    const right = scopePrefixes(b);
    return left.some((x) => right.some((y) => prefixesOverlap(x, y)));
  }

  function explicitResourceLocks(task) {
    return [...new Set([
      ...list(task?.resourceLocks),
      ...list(task?.scope?.resourceLocks)
    ])].sort();
  }

  function inferredResourceLocks(task) {
    const haystack = [
      task?.title,
      task?.objective,
      task?.kind,
      ...(task?.scope?.allow || [])
    ].filter(Boolean).join(" ").toLowerCase();
    const locks = [];
    if (/migration|schema|database|db\b/.test(haystack)) locks.push("shared:schema");
    if (/config|manifest|package\.json|lockfile|package-lock|yarn\.lock|pnpm-lock/.test(haystack)) locks.push("shared:config");
    if (/api|contract|interface|protocol/.test(haystack) && String(task?.risk || "").toLowerCase() === "high") locks.push("shared:public-contract");
    return [...new Set(locks)].sort();
  }

  function resourceKeys(task) {
    return [...new Set([...explicitResourceLocks(task), ...inferredResourceLocks(task)])].sort();
  }

  function sharedResourceLocks(a, b) {
    const left = new Set(resourceKeys(a));
    return resourceKeys(b).filter((key) => left.has(key));
  }

  function conflictScore(a, b) {
    let score = 0;
    const reasons = [];
    if (fileScopeOverlap(a, b)) {
      score += 100;
      reasons.push("file_scope_overlap");
    }
    const sharedLocks = sharedResourceLocks(a, b);
    if (sharedLocks.length) {
      score += 100;
      reasons.push(`resource_lock:${sharedLocks.join(",")}`);
    }
    const subsystemA = String(a?.subsystem || "").trim();
    const subsystemB = String(b?.subsystem || "").trim();
    if (subsystemA && subsystemA === subsystemB) {
      score += 25;
      reasons.push("shared_subsystem");
    }
    return { score, mutuallyExclusive: score >= 100, reasons };
  }

  root.SchedulerConflictPolicy = Object.freeze({
    scopePrefixes,
    prefixesOverlap,
    fileScopeOverlap,
    explicitResourceLocks,
    inferredResourceLocks,
    resourceKeys,
    sharedResourceLocks,
    conflictScore
  });

  if (typeof module !== "undefined" && module.exports) module.exports = root.SchedulerConflictPolicy;
})();
