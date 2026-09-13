"use strict";

const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");
const { ensureDesktopPaths } = require("./app-data.js");
const Protocol = require("../../../platform/companion-protocol.js");
const {
  AUTH_VERSION,
  ensureCompanionSecret,
  verifyClientAuth,
  createServerAck
} = require("./companion-auth.js");

const MAX_LINE_BYTES = Protocol.MAX_FRAME_BYTES + 4096;

class CompanionServerTransport {
  constructor({ dataDirectory = null, paths = null, host = "127.0.0.1", port = 0, logger = console } = {}) {
    this.paths = paths || ensureDesktopPaths({ dataDirectory });
    this.host = host;
    this.port = Number(port) || 0;
    this.logger = logger;
    this.secret = ensureCompanionSecret({ paths: this.paths });
    this.server = null;
    this.socket = null;
    this.listeners = new Set();
    this.waiters = new Set();
    this.status = { kind: "authenticated-loopback", connected: false, listening: false, host: this.host, port: null, clientId: null, lastError: null };
    this.usedNonces = new Set();
  }

  getStatus() { return { ...this.status }; }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("companion_transport_listener_invalid");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect() {
    if (this.server) return this.getStatus();
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server?.off("listening", onListen); reject(error); };
      const onListen = () => { this.server?.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListen);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    this.status = { ...this.status, listening: true, host: this.host, port: address.port, lastError: null };
    fs.writeFileSync(this.paths.companionEndpointFile, JSON.stringify({
      schemaVersion: 1,
      authVersion: AUTH_VERSION,
      protocolVersion: Protocol.PROTOCOL_VERSION,
      host: this.host,
      port: address.port,
      instanceId: crypto.randomUUID()
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(this.paths.companionEndpointFile, 0o600); } catch (_) {}
    return this.getStatus();
  }

  waitForConnection(timeoutMs = 15000) {
    if (this.socket && this.status.connected) return Promise.resolve(this.getStatus());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("companion_connection_timeout"));
      }, Math.max(100, Number(timeoutMs) || 15000));
      this.waiters.add(waiter);
    });
  }

  resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timeout);
      waiter.resolve(this.getStatus());
      this.waiters.delete(waiter);
    }
  }

  rejectWaiters(error) {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      this.waiters.delete(waiter);
    }
  }

  accept(socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;

    const reject = (reason) => {
      this.logger.warn?.("companion_auth_rejected", reason);
      try { socket.end(); } catch (_) {}
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES * 2) return reject("frame_buffer_too_large");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return reject("frame_too_large");
        let parsed;
        try { parsed = JSON.parse(line); } catch (_) { return reject("invalid_json"); }

        if (!authenticated) {
          if (!verifyClientAuth(this.secret, parsed) || this.usedNonces.has(parsed.clientNonce)) return reject("invalid_auth");
          const clientNonce = parsed.clientNonce;
          this.usedNonces.add(clientNonce);
          if (this.usedNonces.size > 256) this.usedNonces.delete(this.usedNonces.values().next().value);
          if (this.socket && this.socket !== socket) return reject("bridge_busy");
          authenticated = true;
          this.socket = socket;
          this.status = { ...this.status, connected: true, clientId: clientNonce.slice(0, 12), lastError: null };
          socket.write(`${JSON.stringify(createServerAck(this.secret, clientNonce))}\n`);
          this.resolveWaiters();
          continue;
        }

        let frame;
        try { frame = Protocol.validateFrame(parsed); } catch (error) { return reject(error?.message || "invalid_frame"); }
        for (const listener of [...this.listeners]) listener(frame);
      }
    });

    socket.on("error", (error) => {
      if (this.socket === socket) this.status = { ...this.status, connected: false, clientId: null, lastError: error?.message || String(error) };
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.status = { ...this.status, connected: false, clientId: null };
      }
    });
  }

  async send(input) {
    if (!this.socket || !this.status.connected) throw new Error("companion_transport_disconnected");
    const frame = Protocol.validateFrame(input);
    await new Promise((resolve, reject) => this.socket.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve()));
    return { ok: true };
  }

  async disconnect() {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.end(); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
    }
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    this.status = { ...this.status, connected: false, listening: false, port: null, clientId: null };
    this.rejectWaiters(new Error("companion_transport_stopped"));
    try { fs.unlinkSync(this.paths.companionEndpointFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return this.getStatus();
  }
}

module.exports = { CompanionServerTransport, MAX_LINE_BYTES };
