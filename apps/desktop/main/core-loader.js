"use strict";

const path = require("node:path");

let loaded = false;

function load(relativePath) {
  require(path.resolve(__dirname, "../../..", relativePath));
}

function loadDesktopCore() {
  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  if (loaded) return root;

  [
    "content/message-types.js",
    "protocol/orchestra-protocol.js",
    "prompts/planning-prompts.js",
    "prompts/worker-prompts.js",
    "prompts/review-prompts.js",
    "prompts/integration-prompts.js",
    "context/context-packets.js",
    "platform/contracts.js",
    "platform/fake-runtime.js",
    "platform/node-timer-runtime.js",
    "platform/transactional-state-store.js",
    "persistence/migration-registry.js",
    "persistence/portable-state.js",
    "persistence/project-bundle.js",
    "background/tab-registry.js",
    "background/event-store.js",
    "background/event-bus.js",
    "background/project-store.js",
    "background/context-store.js",
    "background/dag-validator.js",
    "background/planning-engine.js",
    "background/conflict-policy.js",
    "background/git-provider.js",
    "background/scheduler-store.js",
    "background/review-store.js",
    "background/review-engine.js",
    "background/integration-policy.js",
    "background/integration-store.js",
    "background/integration-engine.js",
    "background/integration-recovery.js",
    "background/scheduler-engine.js",
    "background/orchestrator.js",
    "background/recovery-store.js",
    "background/recovery-controller.js",
    "background/recovery-hooks.js",
    "background/recovery-stop-guards.js",
    "background/observability-service.js",
    "background/task-control-service.js",
    "background/orchestrator-api.js"
  ].forEach(load);

  loaded = true;
  return root;
}

module.exports = { loadDesktopCore };
