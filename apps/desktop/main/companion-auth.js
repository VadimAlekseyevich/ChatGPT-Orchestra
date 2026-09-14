"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { ensureDesktopPaths } = require("./app-data.js");

const AUTH_VERSION = 1;
const SECRET_BYTES = 32;

function safeSecret(value) {
  const secret = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("companion_secret_invalid");
  return secret;
}

function ensureCompanionSecret({ paths = null, dataDirectory = null } = {}) {
  const resolved = paths || ensureDesktopPaths({ dataDirectory });
  try {
    const existing = fs.readFileSync(resolved.companionSecretFile, "utf8").trim();
    try { fs.chmodSync(resolved.companionSecretFile, 0o600); } catch (_) {}
    return safeSecret(existing);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const secret = crypto.randomBytes(SECRET_BYTES).toString("hex");
  fs.writeFileSync(resolved.companionSecretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.chmodSync(resolved.companionSecretFile, 0o600); } catch (_) {}
  return secret;
}

function nonce() { return crypto.randomBytes(24).toString("hex"); }

function material(label, values) {
  return JSON.stringify([AUTH_VERSION, String(label || ""), ...values.map((value) => String(value ?? ""))]);
}

function proof(secret, label, ...values) {
  return crypto.createHmac("sha256", Buffer.from(safeSecret(secret), "hex")).update(material(label, values)).digest("hex");
}

function equalHex(left, right) {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createClientAuth(secret, clientNonce = nonce()) {
  return {
    kind: "auth",
    authVersion: AUTH_VERSION,
    clientNonce,
    proof: proof(secret, "client", clientNonce)
  };
}

function verifyClientAuth(secret, frame = {}) {
  if (frame.kind !== "auth" || Number(frame.authVersion) !== AUTH_VERSION || !/^[0-9a-f]{48}$/.test(String(frame.clientNonce || ""))) return false;
  return equalHex(frame.proof, proof(secret, "client", frame.clientNonce));
}

function createServerAck(secret, clientNonce, serverNonce = nonce()) {
  return {
    kind: "auth_ack",
    authVersion: AUTH_VERSION,
    clientNonce: String(clientNonce || ""),
    serverNonce,
    proof: proof(secret, "server", clientNonce, serverNonce)
  };
}

function verifyServerAck(secret, clientNonce, frame = {}) {
  if (frame.kind !== "auth_ack" || Number(frame.authVersion) !== AUTH_VERSION || String(frame.clientNonce || "") !== String(clientNonce || "")) return false;
  if (!/^[0-9a-f]{48}$/.test(String(frame.serverNonce || ""))) return false;
  return equalHex(frame.proof, proof(secret, "server", clientNonce, frame.serverNonce));
}

module.exports = {
  AUTH_VERSION,
  SECRET_BYTES,
  ensureCompanionSecret,
  nonce,
  proof,
  createClientAuth,
  verifyClientAuth,
  createServerAck,
  verifyServerAck
};
