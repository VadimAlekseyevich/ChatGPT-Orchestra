(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROTOCOL_VERSION = 1;
  const MAX_FRAME_BYTES = 256 * 1024;
  const MAX_NAME_LENGTH = 160;
  const KINDS = Object.freeze(["request", "response", "event"]);

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function byteLength(value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof Buffer !== "undefined") return Buffer.byteLength(serialized, "utf8");
    return new TextEncoder().encode(serialized).length;
  }

  function token(value, field) {
    const result = String(value || "").trim();
    if (!result || result.length > MAX_NAME_LENGTH) throw new TypeError(`companion_${field}_invalid`);
    return result;
  }

  function jsonPayload(value, field) {
    if (value === undefined) return null;
    let result;
    try { result = clone(value); } catch (_) { throw new TypeError(`companion_${field}_not_serializable`); }
    return result;
  }

  function validateFrame(frame, { maxBytes = MAX_FRAME_BYTES } = {}) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new TypeError("companion_frame_invalid");
    if (Number(frame.v) !== PROTOCOL_VERSION) throw new TypeError("companion_protocol_version_mismatch");
    if (!KINDS.includes(frame.kind)) throw new TypeError("companion_frame_kind_invalid");
    if (byteLength(frame) > maxBytes) throw new TypeError("companion_frame_too_large");

    if (frame.kind === "request") {
      token(frame.id, "request_id");
      token(frame.method, "method");
      jsonPayload(frame.payload, "payload");
    } else if (frame.kind === "response") {
      token(frame.replyTo, "reply_to");
      if (typeof frame.ok !== "boolean") throw new TypeError("companion_response_ok_invalid");
      if (frame.ok) jsonPayload(frame.result, "result");
      else {
        if (!frame.error || typeof frame.error !== "object" || Array.isArray(frame.error)) throw new TypeError("companion_response_error_invalid");
        token(frame.error.code || "remote_error", "error_code");
        if (String(frame.error.message || "").length > 2000) throw new TypeError("companion_error_message_too_large");
      }
    } else {
      token(frame.id, "event_id");
      token(frame.event, "event");
      jsonPayload(frame.payload, "payload");
    }
    return clone(frame);
  }

  function request(id, method, payload = null) {
    return validateFrame({ v: PROTOCOL_VERSION, kind: "request", id: token(id, "request_id"), method: token(method, "method"), payload: jsonPayload(payload, "payload") });
  }

  function response(replyTo, result = null) {
    return validateFrame({ v: PROTOCOL_VERSION, kind: "response", replyTo: token(replyTo, "reply_to"), ok: true, result: jsonPayload(result, "result") });
  }

  function errorResponse(replyTo, code, message = "") {
    return validateFrame({
      v: PROTOCOL_VERSION,
      kind: "response",
      replyTo: token(replyTo, "reply_to"),
      ok: false,
      error: { code: token(code || "remote_error", "error_code"), message: String(message || "").slice(0, 2000) }
    });
  }

  function event(id, name, payload = null) {
    return validateFrame({ v: PROTOCOL_VERSION, kind: "event", id: token(id, "event_id"), event: token(name, "event"), payload: jsonPayload(payload, "payload") });
  }

  function assertCompatibleVersion(version) {
    if (Number(version) !== PROTOCOL_VERSION) throw new TypeError(`companion_protocol_version_mismatch:${version}`);
    return true;
  }

  root.CompanionProtocol = Object.freeze({
    PROTOCOL_VERSION,
    MAX_FRAME_BYTES,
    MAX_NAME_LENGTH,
    KINDS,
    byteLength,
    validateFrame,
    request,
    response,
    errorResponse,
    event,
    assertCompatibleVersion
  });

  if (typeof module !== "undefined" && module.exports) module.exports = root.CompanionProtocol;
})();