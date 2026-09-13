#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const { resolveDesktopDataDirectory, ensureDesktopPaths } = require("../desktop/main/app-data.js");
const {
  ensureCompanionSecret,
  createClientAuth,
  verifyServerAck
} = require("../desktop/main/companion-auth.js");

const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

class NativeMessageDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) throw new Error("native_message_too_large");
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      this.onMessage(JSON.parse(payload.toString("utf8")));
    }
  }
}

function writeNative(stream, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error("native_message_too_large");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  stream.write(Buffer.concat([header, payload]));
}

function dataDirectoryFromEnvironment() {
  return process.env.ORCHESTRA_DATA_DIR || resolveDesktopDataDirectory();
}

async function main() {
  const paths = ensureDesktopPaths({ dataDirectory: dataDirectoryFromEnvironment() });
  const endpoint = JSON.parse(fs.readFileSync(paths.companionEndpointFile, "utf8"));
  const secret = ensureCompanionSecret({ paths });
  const auth = createClientAuth(secret);
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  socket.setEncoding("utf8");

  let authenticated = false;
  let lineBuffer = "";
  const queued = [];
  const forward = (message) => {
    if (!authenticated) queued.push(message);
    else socket.write(`${JSON.stringify(message)}\n`);
  };
  const decoder = new NativeMessageDecoder(forward);
  process.stdin.on("data", (chunk) => {
    try { decoder.push(chunk); } catch (error) { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; }
  });

  socket.on("connect", () => socket.write(`${JSON.stringify(auth)}\n`));
  socket.on("data", (chunk) => {
    lineBuffer += chunk;
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!authenticated) {
        if (!verifyServerAck(secret, auth.clientNonce, message)) throw new Error("companion_server_auth_failed");
        authenticated = true;
        for (const item of queued.splice(0)) socket.write(`${JSON.stringify(item)}\n`);
        continue;
      }
      writeNative(process.stdout, message);
    }
  });
  socket.on("error", (error) => { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; });
  socket.on("close", () => process.exit());
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { NativeMessageDecoder, writeNative, MAX_NATIVE_MESSAGE_BYTES, dataDirectoryFromEnvironment };
