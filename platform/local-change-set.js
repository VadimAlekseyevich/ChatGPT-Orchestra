"use strict";

const MAX_LOCAL_CHANGE_FILES = 64;
const MAX_LOCAL_CHANGE_BYTES = 256 * 1024;
const MAX_LOCAL_FILE_BYTES = 128 * 1024;
const FORMAT = "file-set-v1";

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function normalizeChangePath(value) {
  const path = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\0")) throw new Error("local_change_path_invalid");
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("local_change_path_invalid");
  return segments.join("/");
}

function normalizeLocalChangeSet(value, { required = true } = {}) {
  if (value === null || value === undefined) return required ? { ok: false, reason: "local_change_set_missing" } : { ok: true, changeSet: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "local_change_set_invalid" };
  if (String(value.format || "") !== FORMAT) return { ok: false, reason: "local_change_set_format_invalid" };
  if (!Array.isArray(value.files) || !value.files.length) return { ok: false, reason: "local_change_set_files_missing" };
  if (value.files.length > MAX_LOCAL_CHANGE_FILES) return { ok: false, reason: "local_change_set_too_many_files" };

  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  try {
    for (const raw of value.files) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "local_change_entry_invalid" };
      const path = normalizeChangePath(raw.path);
      if (seen.has(path)) return { ok: false, reason: "local_change_path_duplicate", path };
      seen.add(path);
      const operation = String(raw.operation || "write").toLowerCase();
      if (!new Set(["write", "delete"]).has(operation)) return { ok: false, reason: "local_change_operation_invalid", path };
      if (operation === "delete") {
        if (raw.content !== undefined && raw.content !== null && String(raw.content).length) return { ok: false, reason: "local_change_delete_has_content", path };
        files.push({ path, operation: "delete" });
        continue;
      }
      if (typeof raw.content !== "string") return { ok: false, reason: "local_change_content_invalid", path };
      const bytes = utf8Bytes(raw.content);
      if (bytes > MAX_LOCAL_FILE_BYTES) return { ok: false, reason: "local_change_file_too_large", path, bytes };
      totalBytes += bytes;
      if (totalBytes > MAX_LOCAL_CHANGE_BYTES) return { ok: false, reason: "local_change_set_too_large", bytes: totalBytes };
      files.push({ path, operation: "write", content: raw.content });
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message || "local_change_set_invalid") };
  }
  return { ok: true, changeSet: { format: FORMAT, files }, totalBytes };
}

function changeSetSummary(changeSet) {
  const normalized = normalizeLocalChangeSet(changeSet);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    format: FORMAT,
    fileCount: normalized.changeSet.files.length,
    writeCount: normalized.changeSet.files.filter((item) => item.operation === "write").length,
    deleteCount: normalized.changeSet.files.filter((item) => item.operation === "delete").length,
    totalBytes: normalized.totalBytes,
    paths: normalized.changeSet.files.map((item) => item.path)
  };
}

module.exports = {
  FORMAT,
  MAX_LOCAL_CHANGE_FILES,
  MAX_LOCAL_CHANGE_BYTES,
  MAX_LOCAL_FILE_BYTES,
  normalizeChangePath,
  normalizeLocalChangeSet,
  changeSetSummary
};