const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const Contracts = require("../platform/contracts.js");
const Protocol = require("../platform/companion-protocol.js");
const { ensureDesktopPaths } = require("../apps/desktop/main/app-data.js");
const {
  ensureCompanionSecret,
  createClientAuth,
  verifyServerAck
} = require("../apps/desktop/main/companion-auth.js");
const { CompanionServerTransport } = require("../apps/desktop/main/companion-server-transport.js");

function nextLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, index)));
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => { socket.off("data", onData); socket.off("error", onError); };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

test("desktop companion server rejects unauthenticated control and transports frames after HMAC pairing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-companion-server-"));
  const paths = ensureDesktopPaths({ dataDirectory: root });
  const transport = new CompanionServerTransport({ paths, logger: { warn() {} } });
  Contracts.assertCompanionTransport(transport);
  await transport.connect();

  const endpoint = JSON.parse(fs.readFileSync(paths.companionEndpointFile, "utf8"));
  const secret = ensureCompanionSecret({ paths });
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  socket.setEncoding("utf8");
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });

  const hello = createClientAuth(secret);
  socket.write(`${JSON.stringify(hello)}\n`);
  const ack = await nextLine(socket);
  assert.equal(verifyServerAck(secret, hello.clientNonce, ack), true);
  await transport.waitForConnection(1000);
  assert.equal(transport.getStatus().connected, true);

  const receivedPromise = new Promise((resolve) => transport.subscribe((frame) => resolve(frame)));
  socket.write(`${JSON.stringify(Protocol.event("e1", "extension.ready", { ok: true }))}\n`);
  const received = await receivedPromise;
  assert.equal(received.event, "extension.ready");

  const fromDesktop = nextLine(socket);
  await transport.send(Protocol.event("e2", "desktop.ready", { ok: true }));
  assert.equal((await fromDesktop).event, "desktop.ready");

  socket.end();
  await transport.disconnect();
  assert.equal(fs.existsSync(paths.companionEndpointFile), false);
});
