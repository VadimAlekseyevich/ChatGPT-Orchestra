"use strict";

const MAX_LOCAL_VERIFICATION_COMMANDS = 12;
const MAX_LOCAL_VERIFICATION_ARGS = 64;
const MAX_LOCAL_VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiresLocalVerification(task) {
  const kind = String(task?.kind || "code").trim().toLowerCase();
  return !["analysis", "research", "planning", "manual", "no-code", "nocode"].includes(kind);
}

function normalizeLocalVerificationPlan(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    return required
      ? { ok: false, reason: "local_verification_plan_missing", commands: [] }
      : { ok: true, commands: [] };
  }
  if (!Array.isArray(value)) return { ok: false, reason: "local_verification_plan_not_array", commands: [] };
  if (!value.length) {
    return required
      ? { ok: false, reason: "local_verification_plan_empty", commands: [] }
      : { ok: true, commands: [] };
  }
  if (value.length > MAX_LOCAL_VERIFICATION_COMMANDS) {
    return { ok: false, reason: "local_verification_plan_too_large", commands: [] };
  }

  const commands = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item)) return { ok: false, reason: "local_verification_command_not_object", index, commands: [] };
    const command = String(item.command || "").trim();
    if (!command || command.length > 512 || /[\0\r\n]/.test(command)) {
      return { ok: false, reason: "local_verification_command_invalid", index, commands: [] };
    }
    if (!Array.isArray(item.args) || item.args.length > MAX_LOCAL_VERIFICATION_ARGS || item.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) {
      return { ok: false, reason: "local_verification_args_invalid", index, commands: [] };
    }
    if (Object.prototype.hasOwnProperty.call(item, "shell") || Object.prototype.hasOwnProperty.call(item, "environment") || Object.prototype.hasOwnProperty.call(item, "env")) {
      return { ok: false, reason: "local_verification_unsafe_fields", index, commands: [] };
    }
    let timeoutMs = null;
    if (item.timeoutMs !== undefined && item.timeoutMs !== null) {
      timeoutMs = Number(item.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_LOCAL_VERIFICATION_TIMEOUT_MS) {
        return { ok: false, reason: "local_verification_timeout_invalid", index, commands: [] };
      }
    }
    commands.push({
      command,
      args: [...item.args],
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(item.label ? { label: String(item.label).slice(0, 200) } : {})
    });
  }
  return { ok: true, commands };
}

module.exports = {
  MAX_LOCAL_VERIFICATION_COMMANDS,
  MAX_LOCAL_VERIFICATION_ARGS,
  MAX_LOCAL_VERIFICATION_TIMEOUT_MS,
  requiresLocalVerification,
  normalizeLocalVerificationPlan
};
