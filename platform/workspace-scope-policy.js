"use strict";

function normalizeScopePattern(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.includes("\0")) throw new Error("workspace_scope_path_invalid");
  if (normalized.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error("workspace_scope_path_invalid");
  return normalized;
}

function escapeRegex(value) {
  return String(value).replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globRegex(pattern) {
  const normalized = normalizeScopePattern(pattern);
  let output = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      const next = normalized[index + 1];
      if (next === "*") {
        const after = normalized[index + 2];
        if (after === "/") {
          output += "(?:.*/)?";
          index += 2;
        } else {
          output += ".*";
          index += 1;
        }
      } else output += "[^/]*";
    } else if (char === "?") output += "[^/]";
    else output += escapeRegex(char);
  }
  output += "$";
  return new RegExp(output);
}

function matchesScope(changedPath, pattern) {
  const path = normalizeScopePattern(changedPath);
  const scope = normalizeScopePattern(pattern);
  if (!/[?*]/.test(scope)) return path === scope || path.startsWith(`${scope}/`);
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return globRegex(scope).test(path);
}

function evaluateScope(changedFiles = [], scope = {}) {
  const allow = (Array.isArray(scope) ? scope : scope?.allow || []).map(normalizeScopePattern);
  const deny = (Array.isArray(scope?.deny) ? scope.deny : []).map(normalizeScopePattern);
  const normalizedChanged = [...new Set((changedFiles || []).map(normalizeScopePattern))].sort();
  const outsideAllow = normalizedChanged.filter((file) => !allow.some((pattern) => matchesScope(file, pattern)));
  const denied = normalizedChanged.filter((file) => deny.some((pattern) => matchesScope(file, pattern)));
  const violations = [...new Set([...outsideAllow, ...denied])].sort();
  return { ok: violations.length === 0, changedFiles: normalizedChanged, allowedPaths: allow, deniedPaths: deny, outsideAllow, denied, violations };
}

module.exports = { normalizeScopePattern, globRegex, matchesScope, evaluateScope };
