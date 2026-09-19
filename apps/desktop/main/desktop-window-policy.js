"use strict";

function revealDesktopMainWindow(window, { preserveExistingFocus = false } = {}) {
  if (!window || window.isDestroyed?.()) return { shown: false, mode: "missing" };
  if (preserveExistingFocus && typeof window.showInactive === "function") {
    window.showInactive();
    return { shown: true, mode: "inactive" };
  }
  window.show?.();
  window.focus?.();
  return { shown: true, mode: "active" };
}

module.exports = { revealDesktopMainWindow };
