(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra;
  const transport = new root.FakeDashboardTransport();
  const app = new root.DashboardApp({ rootElement: document.querySelector("#orchestraDashboard"), transport, pollMs: 5000 });
  app.start();
})();
