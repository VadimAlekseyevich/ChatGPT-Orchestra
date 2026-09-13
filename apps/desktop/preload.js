"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const IPC_QUERY_CHANNEL = "orchestra:query";
const IPC_EXECUTE_CHANNEL = "orchestra:execute";

function clone(value) {
  if (value === undefined) return {};
  return JSON.parse(JSON.stringify(value));
}

contextBridge.exposeInMainWorld("orchestraDesktop", Object.freeze({
  query(name, payload = {}) {
    return ipcRenderer.invoke(IPC_QUERY_CHANNEL, { name: String(name || ""), payload: clone(payload) });
  },
  execute(name, payload = {}) {
    return ipcRenderer.invoke(IPC_EXECUTE_CHANNEL, { name: String(name || ""), payload: clone(payload) });
  }
}));
