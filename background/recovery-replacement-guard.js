(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  if (root.__recoveryReplacementGuardInstalled) return;
  root.__recoveryReplacementGuardInstalled = true;

  if (root.RecoveryController?.prototype) {
    const proto = root.RecoveryController.prototype;
    const originalSetActions = proto.setActions;
    proto.setActions = function recoveryAwareSetActions(actions = {}) {
      const wrapped = { ...actions };
      if (typeof actions.createWorkers === "function") {
        wrapped.createWorkers = async (...args) => {
          const result = await actions.createWorkers(...args);
          this.recreatedAgentIds = Array.isArray(result?.created) ? [...result.created] : [];
          return result;
        };
      }
      return originalSetActions.call(this, wrapped);
    };

    const originalResume = proto.resume;
    proto.resume = function recoveryAwareResume(...args) {
      this.recreatedAgentIds = [];
      return originalResume.apply(this, args);
    };
  }

  if (root.SchedulerEngine?.prototype?.reconcileForResume) {
    const proto = root.SchedulerEngine.prototype;
    const originalReconcile = proto.reconcileForResume;
    proto.reconcileForResume = async function replacementAwareReconcile(...args) {
      const replaced = new Set(root.RecoveryRuntime?.controller?.recreatedAgentIds || []);
      if (!replaced.size || !this.registry?.getAgent) return originalReconcile.apply(this, args);
      const originalGetAgent = this.registry.getAgent.bind(this.registry);
      this.registry.getAgent = (agentId) => replaced.has(agentId) ? null : originalGetAgent(agentId);
      try {
        return await originalReconcile.apply(this, args);
      } finally {
        this.registry.getAgent = originalGetAgent;
      }
    };
  }
})();
