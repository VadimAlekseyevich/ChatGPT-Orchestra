(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.context.v1";
  const SCHEMA_VERSION = 1;
  const MAX_DECISIONS = 120;
  const MAX_PACKET_AUDIT = 200;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: null,
      leadSummary: null,
      decisions: [],
      packetAudit: [],
      updatedAt: 0
    };
  }

  class ContextStore {
    constructor({ storageArea = globalThis.chrome?.storage?.local, clock = () => Date.now() } = {}) {
      this.storageArea = storageArea;
      this.clock = clock;
      this.state = defaultState();
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.storageArea?.get) return this.snapshot();
      const stored = await this.storageArea.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION) {
        this.state = {
          ...defaultState(),
          ...candidate,
          decisions: Array.isArray(candidate.decisions) ? candidate.decisions.slice(-MAX_DECISIONS) : [],
          packetAudit: Array.isArray(candidate.packetAudit) ? candidate.packetAudit.slice(-MAX_PACKET_AUDIT) : []
        };
      }
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }

    summary() {
      return {
        schemaVersion: SCHEMA_VERSION,
        projectId: this.state.projectId,
        leadSummary: clone(this.state.leadSummary),
        decisionCount: this.state.decisions.length,
        packetCount: this.state.packetAudit.length,
        lastPacket: clone(this.state.packetAudit.at(-1) || null),
        updatedAt: this.state.updatedAt
      };
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.storageArea?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.storageArea.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    ensureProjectInMemory(projectId) {
      const id = String(projectId || "").trim();
      if (!id) return false;
      if (this.state.projectId !== id) {
        this.state = { ...defaultState(), projectId: id, updatedAt: this.clock() };
      }
      return true;
    }

    async ensureProject(projectId) {
      if (!this.ensureProjectInMemory(projectId)) return null;
      await this.persist();
      return this.snapshot();
    }

    updateContextInMemory(projectId, { leadSummary = null, decisions = [] } = {}) {
      if (!this.ensureProjectInMemory(projectId)) return null;
      if (leadSummary) this.state.leadSummary = clone(leadSummary);
      if (Array.isArray(decisions)) this.state.decisions = clone(decisions.slice(-MAX_DECISIONS));
      this.state.updatedAt = this.clock();
      return this.snapshot();
    }

    async setContext(projectId, payload = {}) {
      const snapshot = this.updateContextInMemory(projectId, payload);
      if (!snapshot) return null;
      await this.persist();
      return this.snapshot();
    }

    recordPacketInMemory(projectId, metadata) {
      if (!this.ensureProjectInMemory(projectId) || !metadata) return null;
      this.state.packetAudit.push(clone(metadata));
      if (this.state.packetAudit.length > MAX_PACKET_AUDIT) this.state.packetAudit.splice(0, this.state.packetAudit.length - MAX_PACKET_AUDIT);
      this.state.updatedAt = this.clock();
      return clone(metadata);
    }

    async recordPacket(projectId, metadata) {
      const record = this.recordPacketInMemory(projectId, metadata);
      if (!record) return null;
      await this.persist();
      return record;
    }
  }

  root.ContextStore = ContextStore;
  root.CONTEXT_STORE_STORAGE_KEY = STORAGE_KEY;
  if (typeof module !== "undefined" && module.exports) module.exports = { ContextStore, STORAGE_KEY, SCHEMA_VERSION, MAX_DECISIONS, MAX_PACKET_AUDIT };
})();
