(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra;
  const transport = new root.DesktopDashboardTransport();
  const app = new root.DashboardApp({ rootElement: document.querySelector("#orchestraDashboard"), transport, pollMs: 3000 });
  app.start();
})();
