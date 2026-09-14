(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra;
  const transport = new root.DesktopDashboardTransport();
  const onboardingRoot = document.querySelector("#managedBrowserOnboarding");
  if (onboardingRoot && root.ManagedBrowserOnboarding) {
    const onboarding = new root.ManagedBrowserOnboarding({ rootElement: onboardingRoot, transport, pollMs: 2500 });
    onboarding.start();
  }
  const projectRoot = document.querySelector("#desktopProjectOnboarding");
  if (projectRoot && root.DesktopProjectOnboarding) {
    const projectOnboarding = new root.DesktopProjectOnboarding({ rootElement: projectRoot, transport, pollMs: 3000 });
    projectOnboarding.start();
  }
  const bundleRoot = document.querySelector("#desktopProjectBundleImport");
  if (bundleRoot && root.DesktopProjectBundleImport) {
    const bundleImport = new root.DesktopProjectBundleImport({ rootElement: bundleRoot, transport, pollMs: 3000 });
    bundleImport.start();
  }
  const app = new root.DashboardApp({ rootElement: document.querySelector("#orchestraDashboard"), transport, pollMs: 3000 });
  app.start();
})();
