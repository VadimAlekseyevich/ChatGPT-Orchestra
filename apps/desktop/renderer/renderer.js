(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra;
  const transport = new root.DesktopDashboardTransport();
  const onboardingRoot = document.querySelector("#managedBrowserOnboarding");
  if (onboardingRoot && root.ManagedBrowserOnboarding) {
    const onboarding = new root.ManagedBrowserOnboarding({ rootElement: onboardingRoot, transport, pollMs: 2500 });
    onboarding.start();
  }
  const app = new root.DashboardApp({ rootElement: document.querySelector("#orchestraDashboard"), transport, pollMs: 3000 });
  app.start();
})();
