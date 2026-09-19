(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra;
  const transport = new root.DesktopDashboardTransport();
  const i18n = new root.DesktopI18n();
  const t = (key, fallback = "", params = {}) => i18n.t(key, params, fallback);

  const workflowRoot = document.querySelector("#desktopWorkflowGuide");
  function renderWorkflowGuide() {
    if (!workflowRoot) return;
    const steps = [
      t("workflow.connect", "Connect ChatGPT"),
      t("workflow.lead", "Lead plans"),
      t("workflow.project", "Choose project and goal"),
      t("workflow.workers", "Workers implement"),
      t("workflow.review", "Reviewer checks"),
      t("workflow.integration", "Integrator combines")
    ];
    workflowRoot.innerHTML = `<section class="dashboard-section desktop-workflow-guide">
      <div class="dashboard-section-head"><h2>${t("workflow.title", "How Orchestra works")}</h2></div>
      <p class="dashboard-muted">${t("workflow.summary", "You describe the outcome. Orchestra plans the work, runs tasks in parallel, reviews changes and prepares a verified integration.")}</p>
      <div class="desktop-workflow-steps">${steps.map((step, index) => `<span><strong>${index + 1}</strong> ${step}</span>`).join("<b aria-hidden=\"true\">→</b>")}</div>
      <div class="desktop-role-guide">
        <span>${t("roles.lead", "Lead — understands the goal and builds the task plan.")}</span>
        <span>${t("roles.worker", "Workers — implement independent tasks in isolated Git worktrees.")}</span>
        <span>${t("roles.reviewer", "Reviewer — independently checks completed work before it can unlock dependencies.")}</span>
        <span>${t("roles.integrator", "Integrator — combines approved changes and verifies the integrated result.")}</span>
      </div>
    </section>`;
  }

  const onboardingRoot = document.querySelector("#managedBrowserOnboarding");
  const onboarding = onboardingRoot && root.ManagedBrowserOnboarding
    ? new root.ManagedBrowserOnboarding({ rootElement: onboardingRoot, transport, pollMs: 2500, t })
    : null;
  onboarding?.start();

  const projectRoot = document.querySelector("#desktopProjectOnboarding");
  const projectOnboarding = projectRoot && root.DesktopProjectOnboarding
    ? new root.DesktopProjectOnboarding({ rootElement: projectRoot, transport, pollMs: 3000, t })
    : null;
  projectOnboarding?.start();

  const bundleRoot = document.querySelector("#desktopProjectBundleImport");
  const bundleImport = bundleRoot && root.DesktopProjectBundleImport
    ? new root.DesktopProjectBundleImport({ rootElement: bundleRoot, transport, pollMs: 3000, t })
    : null;
  bundleImport?.start();

  const app = new root.DashboardApp({
    rootElement: document.querySelector("#orchestraDashboard"),
    transport,
    pollMs: 3000,
    t
  });
  app.start();

  const localeSelect = document.querySelector("#desktopLocaleSelect");
  if (localeSelect) {
    localeSelect.value = i18n.locale;
    localeSelect.addEventListener("change", () => i18n.setLocale(localeSelect.value));
  }

  function rerenderLocale() {
    i18n.apply(document);
    if (localeSelect) localeSelect.value = i18n.locale;
    renderWorkflowGuide();
    onboarding?.render();
    projectOnboarding?.render();
    bundleImport?.render();
    app.render();
  }

  i18n.subscribe(rerenderLocale);
  rerenderLocale();
})();
