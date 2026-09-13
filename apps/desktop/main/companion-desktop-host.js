"use strict";

const { DesktopHost } = require("./desktop-host.js");
const { ensureDesktopPaths } = require("./app-data.js");
const { CompanionServerTransport } = require("./companion-server-transport.js");
const { bindCompanionAgentRuntime } = require("./companion-host-binding.js");
const { CompanionRpcPeer } = require("../../../platform/companion-rpc.js");
const { DesktopBridgeAgentRuntime } = require("../../../platform/desktop-bridge-runtime.js");

class CompanionDesktopHost extends DesktopHost {
  constructor(options = {}) {
    if (typeof options.agentRuntime?.bindHostHandlers !== "function") throw new TypeError("companion_agent_runtime_required");
    super({ ...options, autoSeedFakeLead: false });
    this.companionUnbind = bindCompanionAgentRuntime(this);
  }

  async close() {
    try { this.companionUnbind?.(); } catch (_) {}
    this.companionUnbind = null;
    try { await this.agentRuntime.close?.(); } finally { await super.close(); }
  }
}

async function createNativeCompanionDesktopHost({ dataDirectory = null, paths = null, logger = null, requestTimeoutMs = 15000, ...options } = {}) {
  const resolvedPaths = paths || ensureDesktopPaths({ dataDirectory });
  const transport = new CompanionServerTransport({ paths: resolvedPaths, logger: logger || console });
  const rpc = new CompanionRpcPeer({ transport, requestTimeoutMs, logger: logger || console });
  const agentRuntime = new DesktopBridgeAgentRuntime({ rpc, clock: options.clock || (() => Date.now()) });
  const host = new CompanionDesktopHost({ ...options, paths: resolvedPaths, agentRuntime, logger });
  await host.init();
  return host;
}

module.exports = { CompanionDesktopHost, createNativeCompanionDesktopHost };
