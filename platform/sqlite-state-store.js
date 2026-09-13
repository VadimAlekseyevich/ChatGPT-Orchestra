"use strict";

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function loadDatabaseSync() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch (error) {
    const wrapped = new Error("sqlite_runtime_unavailable: Node.js with node:sqlite support is required");
    wrapped.cause = error;
    throw wrapped;
  }
}

class SQLiteStateStore {
  constructor({ filename = ":memory:", database = null, table = "orchestra_kv", clock = () => Date.now(), ownsDatabase = null } = {}) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new TypeError("invalid_sqlite_table_name");
    this.table = table;
    this.clock = clock;
    this.ownsDatabase = database ? ownsDatabase === true : true;
    this.db = database || new (loadDatabaseSync())(filename);
    this.writeChain = Promise.resolve();
    this.ensureSchema();
  }

  ensureSchema() {
    try { this.db.exec("PRAGMA journal_mode=WAL;"); } catch (_) {}
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    this.db.exec("CREATE TABLE IF NOT EXISTS orchestra_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.prepare("INSERT OR REPLACE INTO orchestra_meta(key, value) VALUES (?, ?)").run("state_store_schema_version", "1");
  }

  encode(value) { return JSON.stringify(value === undefined ? null : value); }
  decode(text) { return clone(JSON.parse(text)); }

  enqueueWrite(operation) {
    const next = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async _getDirect(selector = null) {
    if (typeof selector === "string") {
      const row = this.db.prepare(`SELECT value FROM ${this.table} WHERE key = ?`).get(selector);
      return { [selector]: row ? this.decode(row.value) : undefined };
    }
    if (Array.isArray(selector)) {
      const output = {};
      const statement = this.db.prepare(`SELECT value FROM ${this.table} WHERE key = ?`);
      for (const key of selector) {
        const row = statement.get(String(key));
        output[key] = row ? this.decode(row.value) : undefined;
      }
      return output;
    }
    if (selector && typeof selector === "object") {
      const output = {};
      const statement = this.db.prepare(`SELECT value FROM ${this.table} WHERE key = ?`);
      for (const [key, fallback] of Object.entries(selector)) {
        const row = statement.get(key);
        output[key] = row ? this.decode(row.value) : clone(fallback);
      }
      return output;
    }
    const output = {};
    for (const row of this.db.prepare(`SELECT key, value FROM ${this.table} ORDER BY key`).all()) output[row.key] = this.decode(row.value);
    return output;
  }

  async _setDirect(values) {
    const entries = Object.entries(values || {});
    if (!entries.length) return;
    const statement = this.db.prepare(`INSERT INTO ${this.table}(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
    for (const [key, value] of entries) statement.run(String(key), this.encode(value), this.clock());
  }

  async _removeDirect(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const statement = this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`);
    for (const key of list) if (key !== undefined && key !== null) statement.run(String(key));
  }

  async _clearDirect() { this.db.exec(`DELETE FROM ${this.table}`); }

  async get(selector = null) {
    await this.writeChain.catch(() => {});
    return this._getDirect(selector);
  }

  async atomicWrite(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch (_) {}
      throw error;
    }
  }

  async set(values) { return this.enqueueWrite(() => this.atomicWrite(() => this._setDirect(values))); }
  async remove(keys) { return this.enqueueWrite(() => this.atomicWrite(() => this._removeDirect(keys))); }
  async clear() { return this.enqueueWrite(() => this.atomicWrite(() => this._clearDirect())); }

  async transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("transaction_callback_required");
    return this.enqueueWrite(() => this.atomicWrite(async () => {
      const tx = {
        get: (selector = null) => this._getDirect(selector),
        set: (values) => this._setDirect(values),
        remove: (keys) => this._removeDirect(keys),
        clear: () => this._clearDirect()
      };
      return callback(tx);
    }));
  }

  async snapshot() { return this.get(null); }

  close() {
    if (this.ownsDatabase && this.db?.close) this.db.close();
  }
}

module.exports = { SQLiteStateStore, loadDatabaseSync };
