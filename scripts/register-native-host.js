#!/usr/bin/env node
"use strict";

const {
  SUPPORTED_BROWSERS,
  registerNativeHost,
  unregisterNativeHost
} = require("../apps/companion/native-host-registration.js");

function parseArgs(argv = process.argv.slice(2)) {
  const [command = ""] = argv;
  const options = {};
  for (const raw of argv.slice(1)) {
    if (!raw.startsWith("--")) continue;
    const index = raw.indexOf("=");
    const key = index >= 0 ? raw.slice(2, index) : raw.slice(2);
    const value = index >= 0 ? raw.slice(index + 1) : true;
    options[key] = value;
  }
  return { command, options };
}

function usage() {
  return [
    "ChatGPT Orchestra Native Messaging host registration",
    "",
    "Register:",
    "  node scripts/register-native-host.js register --extension-id=<32-char-id> --host-path=<packaged-desktop-executable> [--browsers=edge,chrome] [--data-dir=<path>]",
    "",
    "Unregister:",
    "  node scripts/register-native-host.js unregister [--browsers=edge,chrome] [--data-dir=<path>]",
    "",
    `Supported browsers: ${SUPPORTED_BROWSERS.join(", ")}`,
    "",
    "The host path should be the packaged ChatGPT Orchestra desktop executable. Do not point Windows registration at a .js/.cmd wrapper."
  ].join("\n");
}

function browsersFrom(options) {
  return String(options.browsers || "edge").split(",").map((item) => item.trim()).filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const browsers = browsersFrom(options);
  const dataDirectory = options["data-dir"] || process.env.ORCHESTRA_DATA_DIR || null;

  if (command === "register") {
    const extensionId = options["extension-id"] || process.env.ORCHESTRA_EXTENSION_ID;
    const hostPath = options["host-path"] || process.env.ORCHESTRA_NATIVE_HOST_PATH;
    if (!extensionId || !hostPath) throw new Error(`native_host_registration_arguments_missing\n\n${usage()}`);
    return registerNativeHost({ extensionId, hostPath, browsers, dataDirectory });
  }
  if (command === "unregister") return unregisterNativeHost({ browsers, dataDirectory });
  throw new Error(`native_host_registration_command_invalid\n\n${usage()}`);
}

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, browsersFrom, usage, main };
