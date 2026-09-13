"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REGISTRY_KEY = "orchestraLocalRepositoriesV1";
const TRUST_STATES = Object.freeze({ UNTRUSTED: "UNTRUSTED", TRUSTED: "TRUSTED" });

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRepositoryId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("repository_id_invalid");
  return id;
}

function normalizeTrust(value) {
  const trust = String(value || TRUST_STATES.UNTRUSTED).toUpperCase();
  if (!Object.values(TRUST_STATES).includes(trust)) throw new Error("repository_trust_invalid");
  return trust;
}

function resolveRepositoryPath(value) {
  const resolved = path.resolve(String(value || ""));
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error("repository_path_missing");
  }
  if (!fs.statSync(real).isDirectory()) throw new Error("repository_path_not_directory");
  return real;
}

class LocalRepositoryRegistry {
  constructor({ stateStore, key = REGISTRY_KEY, clock = () => Date.now() } = {}) {
    if (!stateStore || typeof stateStore.get !== "function" || typeof stateStore.set !== "function") throw new TypeError("repository_registry_state_store_required");
    this.stateStore = stateStore;
    this.key = key;
    this.clock = clock;
  }

  async load() {
    const raw = await this.stateStore.get(this.key);
    const stored = raw?.[this.key];
    return stored && stored.schemaVersion === 1 && stored.repositories && typeof stored.repositories === "object"
      ? clone(stored)
      : { schemaVersion: 1, repositories: {}, updatedAt: 0 };
  }

  async save(state) {
    const next = {
      schemaVersion: 1,
      repositories: clone(state.repositories || {}),
      updatedAt: this.clock()
    };
    await this.stateStore.set({ [this.key]: next });
    return clone(next);
  }

  async list() {
    const state = await this.load();
    return Object.values(state.repositories).sort((a, b) => a.repositoryId.localeCompare(b.repositoryId)).map(clone);
  }

  async get(repositoryId) {
    const id = normalizeRepositoryId(repositoryId);
    const state = await this.load();
    return state.repositories[id] ? clone(state.repositories[id]) : null;
  }

  async registerLocal({ repositoryId, repositoryPath, trust = TRUST_STATES.UNTRUSTED } = {}) {
    const id = normalizeRepositoryId(repositoryId);
    const now = this.clock();
    const resolvedPath = resolveRepositoryPath(repositoryPath);
    const state = await this.load();
    const previous = state.repositories[id] || null;
    state.repositories[id] = {
      schemaVersion: 1,
      repositoryId: id,
      mode: "local",
      path: resolvedPath,
      sourceUrl: null,
      trust: normalizeTrust(trust),
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    await this.save(state);
    return clone(state.repositories[id]);
  }

  async registerClone({ repositoryId, repositoryPath, sourceUrl, trust = TRUST_STATES.UNTRUSTED } = {}) {
    const id = normalizeRepositoryId(repositoryId);
    const url = String(sourceUrl || "").trim();
    if (!url || /[\r\n\0]/.test(url)) throw new Error("repository_source_url_invalid");
    const now = this.clock();
    const resolvedPath = resolveRepositoryPath(repositoryPath);
    const state = await this.load();
    const previous = state.repositories[id] || null;
    state.repositories[id] = {
      schemaVersion: 1,
      repositoryId: id,
      mode: "clone",
      path: resolvedPath,
      sourceUrl: url,
      trust: normalizeTrust(trust),
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    await this.save(state);
    return clone(state.repositories[id]);
  }

  async setTrust(repositoryId, trust) {
    const id = normalizeRepositoryId(repositoryId);
    const state = await this.load();
    if (!state.repositories[id]) throw new Error("repository_not_registered");
    state.repositories[id].trust = normalizeTrust(trust);
    state.repositories[id].updatedAt = this.clock();
    await this.save(state);
    return clone(state.repositories[id]);
  }

  async remove(repositoryId) {
    const id = normalizeRepositoryId(repositoryId);
    const state = await this.load();
    if (!state.repositories[id]) return false;
    delete state.repositories[id];
    await this.save(state);
    return true;
  }
}

module.exports = {
  REGISTRY_KEY,
  TRUST_STATES,
  LocalRepositoryRegistry,
  normalizeRepositoryId,
  normalizeTrust,
  resolveRepositoryPath
};
