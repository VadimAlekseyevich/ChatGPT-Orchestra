(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra;
  if (!root?.ChatGPTAdapter || !root?.LegacyController) {
    console.error("[ChatGPT Orchestra] bootstrap_failed", {
      reason: "content_modules_missing"
    });
    return;
  }

  const adapter = new root.ChatGPTAdapter();
  const controller = new root.LegacyController({ adapter });

  function bindRuntimeCommands() {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.onMessage?.addListener) return;

    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const type = message?.type;
      const payload = message?.payload || {};

      if (type === root.MESSAGE_TYPES.PING) {
        sendResponse({
          type: root.MESSAGE_TYPES.PONG,
          payload: adapter.getStatus()
        });
        return false;
      }

      if (type === root.MESSAGE_TYPES.STOP_GENERATION) {
        sendResponse(adapter.stopGeneration());
        return false;
      }

      if (type === root.MESSAGE_TYPES.SEND_PROMPT) {
        adapter.sendPrompt(payload.prompt)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({
            ok: false,
            reason: "adapter_exception",
            message: error?.message || String(error)
          }));
        return true;
      }

      return false;
    });
  }

  bindRuntimeCommands();

  controller.start().catch((error) => {
    root.Logger?.error?.("bootstrap_start_failed", error);
  });

  // Deliberately exposed only as a debug/recovery hook during the alpha.
  root.runtime = { adapter, controller };
})();
