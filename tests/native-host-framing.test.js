const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { NativeMessageDecoder, writeNative } = require("../apps/companion/native-host.js");

test("native messaging relay uses Chrome length-prefixed JSON framing", () => {
  const stream = new PassThrough();
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  writeNative(stream, { v: 1, hello: "world" });
  const encoded = Buffer.concat(chunks);

  let decoded = null;
  const decoder = new NativeMessageDecoder((message) => { decoded = message; });
  decoder.push(encoded.subarray(0, 3));
  assert.equal(decoded, null);
  decoder.push(encoded.subarray(3));
  assert.deepEqual(decoded, { v: 1, hello: "world" });
});
