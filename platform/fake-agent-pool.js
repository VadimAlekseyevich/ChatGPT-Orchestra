(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class FakeAgentPool {
    constructor({ runtime, maxWorkers = 4 } = {}) {
      if (!runtime) throw new TypeError("fake_agent_pool_runtime_required");
      this.runtime = runtime;
      this.maxWorkers = Math.max(1, Number(maxWorkers) || 4);
    }

    async reconcile() { return { ok: true }; }

    async registerActiveLead() {
      let lead = this.runtime.listAgents().find((agent) => agent.role === "lead") || null;
      if (!lead) lead = this.runtime.addAgent({ role: "lead", label: "Lead", status: "IDLE" });
      const ready = await this.runtime.pingAgent(lead.agentId);
      return ready?.ok
        ? { ok: true, agent: this.runtime.getAgent(lead.agentId) }
        : { ok: false, reason: ready?.reason || "lead_not_ready", agent: this.runtime.getAgent(lead.agentId) };
    }

    async ensureWorkers(targetCount = 3) {
      const target = Math.max(1, Math.min(this.maxWorkers, Number(targetCount) || 3));
      const workers = this.runtime.listAgents().filter((agent) => agent.role === "worker");
      const reusable = workers.filter((agent) => !this.runtime.isAgentConnected(agent));
      const live = workers.filter((agent) => this.runtime.isAgentConnected(agent));
      const created = [];

      for (let index = live.length; index < target; index += 1) {
        const existing = reusable.shift();
        if (existing) {
          await this.runtime.recoverAgent(existing.agentId, { status: "CONNECTING" });
          created.push(existing.agentId);
        } else {
          const agent = this.runtime.addAgent({ role: "worker", label: `Worker ${index + 1}`, status: "CONNECTING" });
          created.push(agent.agentId);
        }
      }
      await this.runtime.setRuntimeStatus("pool_active");
      return { ok: true, created };
    }
  }

  root.FakeAgentPool = FakeAgentPool;
  if (typeof module !== "undefined" && module.exports) module.exports = { FakeAgentPool };
})();
