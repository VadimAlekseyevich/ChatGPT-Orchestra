"use strict";

const IPC_QUERY_CHANNEL = "orchestra:query";
const IPC_EXECUTE_CHANNEL = "orchestra:execute";

function portableClone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function portableErrorReason(error, fallback, command = "") {
  const message = String(error?.message || error || "").trim();
  if (/^[a-z][a-z0-9_:-]{2,160}$/i.test(message)) return message;
  if (["openLocalRepository", "cloneRepository"].includes(String(command || ""))
    && /(?:rev-parse[^\r\n]*HEAD|unknown revision[^\r\n]*HEAD|ambiguous argument ['"]?HEAD)/i.test(message)) {
    return "git_repository_has_no_commits";
  }
  return fallback;
}

class DesktopIpcRouter {
  constructor({ host } = {}) {
    if (!host?.query || !host?.execute) throw new TypeError("desktop_host_api_required");
    this.host = host;
  }

  async query(request = {}) {
    const name = String(request.name || "");
    try {
      return portableClone(await this.host.query(name, portableClone(request.payload || {})));
    } catch (error) {
      return {
        apiVersion: 4,
        ok: false,
        reason: portableErrorReason(error, "desktop_ipc_query_failed", name),
        message: error?.message || String(error)
      };
    }
  }

  async execute(request = {}) {
    const name = String(request.name || "");
    try {
      return portableClone(await this.host.execute(name, portableClone(request.payload || {})));
    } catch (error) {
      return {
        apiVersion: 4,
        ok: false,
        reason: portableErrorReason(error, "desktop_ipc_command_failed", name),
        message: error?.message || String(error)
      };
    }
  }
}

function registerElectronIpc({ ipcMain, router } = {}) {
  if (!ipcMain?.handle || !router) throw new TypeError("electron_ipc_registration_requires_ipc_main_and_router");
  ipcMain.removeHandler?.(IPC_QUERY_CHANNEL);
  ipcMain.removeHandler?.(IPC_EXECUTE_CHANNEL);
  ipcMain.handle(IPC_QUERY_CHANNEL, (_event, request) => router.query(request));
  ipcMain.handle(IPC_EXECUTE_CHANNEL, (_event, request) => router.execute(request));
  return () => {
    ipcMain.removeHandler?.(IPC_QUERY_CHANNEL);
    ipcMain.removeHandler?.(IPC_EXECUTE_CHANNEL);
  };
}

module.exports = {
  IPC_QUERY_CHANNEL,
  IPC_EXECUTE_CHANNEL,
  DesktopIpcRouter,
  registerElectronIpc,
  portableClone,
  portableErrorReason
};
