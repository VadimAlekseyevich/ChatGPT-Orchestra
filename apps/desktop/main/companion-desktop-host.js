"use strict";

const { DesktopHost } = require("./desktop-host.js");
const { ensureDesktopPaths } = require("./app-data.js");
const { StructuredLogger } = require("./structured-logger.js");
const { CompanionServerTransport } = require("./companion-server-transport.js");
const { bindCompanionAgentRuntime } = require("./companion-host-binding.js");
const { applyPendingCompanionMigration } = require("./companion-migration.js");
const { CompanionRpcPeer } = require("../../../platform/companion-rpc.js");
const { DesktopBridgeAgentRuntime } = require("../../../platform/desktop-bridge-runtime.js");

class CompanionDesktopHost extends DesktopHost {
  constructor(options = {}) {
    if (typeof options.agentRuntime?.bindHostHandlers !== "function") throw new TypeError("companion_agent_runtime_required");
    super({ ...options, autoSeedFakeLead: false });
    this.companionUnbind = bindCompanionAgentRuntime(this);
    this.migrationBootResult = options.migrationBootResult || null;
  }

  async close() {
    try { this.companionUnbind?.(); } catch (_) {}
    this.companionUnbind = null;
    try { await this.agentRuntime.close?.(); } finally { await super.close(); }
  }
}

async function createNativeCompanionDesktopHost({ dataDirectory = null, paths = null, logger = null, requestTimeoutMs = 15000, ...options } = {}) {
  const resolvedPaths = paths || ensureDesktopPaths({ dataDirectory });
  const clock = options.clock || (() => Date.now());
  const rootLogger = logger || new StructuredLogger({ filename: resolvedPaths.logFile, clock });
  const companionLogger = rootLogger.child?.("companion") || rootLogger;
  const migrationBootResult = await applyPendingCompanionMigration({
    paths: resolvedPaths,
    clock,
    logger: companionLogger
  });
  if (!migrationBootResult.ok) {
    const error = new Error(migrationBootResult.reason || "companion_migration_boot_failed");
    error.migration = migrationBootResult;
    throw error;
  }

  const transport = new CompanionServerTransport({ paths: resolvedPaths, logger: companionLogger });
  const rpc = new CompanionRpcPeer({ transport, requestTimeoutMs, logger: companionLogger });
  const agentRuntime = new DesktopBridgeAgentRuntime({ rpc, clock });
  const host = new CompanionDesktopHost({ ...options, paths: resolvedPaths, agentRuntime, logger: rootLogger, migrationBootResult });
  await host.init();
  return host;
}

module.exports = { CompanionDesktopHost, createNativeCompanionDesktopHost };
