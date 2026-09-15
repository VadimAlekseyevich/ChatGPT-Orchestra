"use strict";

const { API_COMMANDS, API_QUERIES } = require("../../../platform/contracts.js");

const IPC_QUERY_CHANNEL = "orchestra:query";
const IPC_EXECUTE_CHANNEL = "orchestra:execute";
const ALLOWED_QUERY_NAMES = new Set(API_QUERIES);
const ALLOWED_COMMAND_NAMES = new Set(API_COMMANDS);

function portableClone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeApiName(value) {
  return String(value || "").trim();
}

function rejected(reason, name) {
  return { apiVersion: 4, ok: false, reason, name: name || null };
}

class DesktopIpcRouter {
  constructor({ host } = {}) {
    if (!host?.query || !host?.execute) throw new TypeError("desktop_host_api_required");
    this.host = host;
  }

  async query(request = {}) {
    const name = normalizeApiName(request.name);
    if (!ALLOWED_QUERY_NAMES.has(name)) return rejected("desktop_ipc_query_not_allowed", name);
    try {
      return portableClone(await this.host.query(name, portableClone(request.payload || {})));
    } catch (error) {
      return { apiVersion: 4, ok: false, reason: "desktop_ipc_query_failed", message: error?.message || String(error) };
    }
  }

  async execute(request = {}) {
    const name = normalizeApiName(request.name);
    if (!ALLOWED_COMMAND_NAMES.has(name)) return rejected("desktop_ipc_command_not_allowed", name);
    try {
      return portableClone(await this.host.execute(name, portableClone(request.payload || {})));
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

module.exports = {
  IPC_QUERY_CHANNEL,
  IPC_EXECUTE_CHANNEL,
  ALLOWED_QUERY_NAMES,
  ALLOWED_COMMAND_NAMES,
  normalizeApiName,
  DesktopIpcRouter,
  registerElectronIpc,
  portableClone
};
