"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_ENV_KEYS = Object.freeze([
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL"
]);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExistingDirectory(value, label) {
  const resolved = path.resolve(String(value || ""));
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error(`${label}_missing`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label}_not_directory`);
  return real;
}

function sanitizedEnvironment(source = process.env, extra = {}, allowedKeys = DEFAULT_ENV_KEYS) {
  const env = {};
  for (const key of allowedKeys) {
    if (source[key] !== undefined) env[key] = String(source[key]);
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("command_environment_key_invalid");
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

function redactKnownSecrets(value) {
  let output = String(value || "");
  output = output.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  output = output.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]");
  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}={0,2}\b/gi, "$1[REDACTED_TOKEN]");
  output = output.replace(/\b((?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|SECRET)\s*[=:]\s*)[^\s\"'`]+/gi, "$1[REDACTED_SECRET]");
  return output;
}

function appendBounded(chunks, state, chunk, maxBytes) {
  if (state.truncated) return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maxBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (buffer.length <= remaining) {
    chunks.push(buffer);
    state.bytes += buffer.length;
    return;
  }
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += remaining;
  state.truncated = true;
}

class NodeCommandRunner {
  constructor({ workspaceRoot, spawnImpl = spawn, clock = () => Date.now(), environment = process.env } = {}) {
    this.workspaceRoot = resolveExistingDirectory(workspaceRoot, "command_workspace_root");
    this.spawnImpl = spawnImpl;
    this.clock = clock;
    this.environment = environment;
    this.active = new Map();
    this.sequence = 0;
  }

  assertApprovedCwd(cwd) {
    const realCwd = resolveExistingDirectory(cwd, "command_cwd");
    if (!isInside(this.workspaceRoot, realCwd)) throw new Error("command_cwd_outside_workspace_root");
    return realCwd;
  }

  run(command, args = [], cwd, policy = {}) {
    if (policy.trusted !== true) return Promise.reject(new Error("repository_execution_not_trusted"));
    if (typeof command !== "string" || !command.trim()) return Promise.reject(new Error("command_missing"));
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return Promise.reject(new Error("command_args_invalid"));
    if (policy.shell === true) return Promise.reject(new Error("command_shell_not_allowed"));

    let approvedCwd;
    try {
      approvedCwd = this.assertApprovedCwd(cwd);
    } catch (error) {
      return Promise.reject(error);
    }

    const timeoutMs = Math.max(1, Math.min(Number(policy.timeoutMs) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
    const maxOutputBytes = Math.max(1024, Math.min(Number(policy.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES));
    const runId = String(policy.runId || `cmd-${this.clock()}-${++this.sequence}`);
    const startedAt = this.clock();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const stdout = [];
      const stderr = [];
      const stdoutState = { bytes: 0, truncated: false };
      const stderrState = { bytes: 0, truncated: false };
      let child;

      try {
        child = this.spawnImpl(command, args, {
          cwd: approvedCwd,
          shell: false,
          windowsHide: true,
          env: sanitizedEnvironment(this.environment, policy.environment || {})
        });
      } catch (error) {
        reject(error);
        return;
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(runId);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
      }, timeoutMs);

      this.active.set(runId, {
        cancel: () => {
          cancelled = true;
          try { child.kill(); } catch {}
        }
      });

      child.stdout?.on("data", (chunk) => appendBounded(stdout, stdoutState, chunk, maxOutputBytes));
      child.stderr?.on("data", (chunk) => appendBounded(stderr, stderrState, chunk, maxOutputBytes));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(runId);
        reject(error);
      });
      child.on("close", (code, signal) => {
        finish({
          runId,
          ok: !timedOut && !cancelled && code === 0,
          status: timedOut ? "timeout" : cancelled ? "cancelled" : code === 0 ? "passed" : "failed",
          exitCode: Number.isInteger(code) ? code : null,
          signal: signal || null,
          stdout: redactKnownSecrets(Buffer.concat(stdout).toString("utf8")),
          stderr: redactKnownSecrets(Buffer.concat(stderr).toString("utf8")),
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
          startedAt,
          finishedAt: this.clock()
        });
      });
    });
  }

  cancel(runId) {
    const active = this.active.get(String(runId || ""));
    if (!active) return false;
    active.cancel();
    return true;
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_ENV_KEYS,
  NodeCommandRunner,
  isInside,
  sanitizedEnvironment,
  redactKnownSecrets
};
