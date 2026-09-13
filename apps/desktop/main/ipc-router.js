"use strict";

const IPC_QUERY_CHANNEL = "orchestra:query";
const IPC_EXECUTE_CHANNEL = "orchestra:execute";

function portableClone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

class DesktopIpcRouter {
  constructor({ host } = {}) {
    if (!host?.query || !host?.execute) throw new TypeError("desktop_host_api_required");
    this.host = host;
  }

  async query(request = {}) {
    try {
      return portableClone(await this.host.query(String(request.name || ""), portableClone(request.payload || {})));
    } catch (error) {
      return { apiVersion: 4, ok: false, reason: "desktop_ipc_query_failed", message: error?.message || String(error) };
    }
  }

  async execute(request = {}) {
    try {
      return portableClone(await this.host.execute(String(request.name || ""), portableClone(request.payload || {})));
    } catch (error) {
      return { apiVersion: 4, ok: false, reason: "desktop_ipc_command_failed", message: error?.message || String(error) };
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

module.exports = { IPC_QUERY_CHANNEL, IPC_EXECUTE_CHANNEL, DesktopIpcRouter, registerElectronIpc, portableClone };
