const DEFAULT_RULES = [
  {
    id: "done",
    enabled: true,
    marker: "DONE",
    action: "prompt",
    prompt: "Делай следующее задание"
  },
  {
    id: "fail",
    enabled: true,
    marker: "FAIL",
    action: "notify",
    prompt: "Требуется ваше участие. Откройте чат ChatGPT."
  },
  {
    id: "error",
    enabled: true,
    marker: "ERROR",
    action: "prompt",
    prompt: "Исправь ошибку и продолжи работу. Если без моего участия продолжить нельзя, заверши ответ флагом FAIL."
  }
];

const DEFAULTS = {
  enabled: true,
  delayMs: 1200
};

const LEGACY_DEFAULT_MARKER = "DONE";
const LEGACY_DEFAULT_FOLLOW_UP = "Делай следующее задание";
const MAX_RULES = 50;

const elements = {
  enabled: document.querySelector("#enabled"),
  rulesList: document.querySelector("#rulesList"),
  ruleTemplate: document.querySelector("#ruleTemplate"),
  addRule: document.querySelector("#addRule"),
  delayMs: document.querySelector("#delayMs"),
  save: document.querySelector("#save"),
  reset: document.querySelector("#reset"),
  status: document.querySelector("#status")
};

let rules = [];

function cloneDefaultRules() {
  return DEFAULT_RULES.map((rule) => ({ ...rule }));
}

function createRuleId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== "object") return null;

  const marker = String(rule.marker || "").trim();
  if (!marker) return null;

  return {
    id: String(rule.id || `rule-${index}-${marker}`),
    enabled: rule.enabled !== false,
    marker,
    action: rule.action === "notify" ? "notify" : "prompt",
    prompt: String(rule.prompt || "").trim()
  };
}

function normalizeRules(storedRules, legacyMarker, legacyFollowUp) {
  if (Array.isArray(storedRules)) {
    return storedRules.map(normalizeRule).filter(Boolean);
  }

  const migrated = cloneDefaultRules();
  migrated[0].marker = String(legacyMarker || LEGACY_DEFAULT_MARKER).trim() || LEGACY_DEFAULT_MARKER;
  migrated[0].prompt = String(legacyFollowUp || LEGACY_DEFAULT_FOLLOW_UP).trim() || LEGACY_DEFAULT_FOLLOW_UP;
  return migrated;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => {
    elements.status.textContent = "";
    elements.status.classList.remove("error");
  }, 2600);
}

function updatePayloadLabel(card, action) {
  const label = card.querySelector('[data-role="payloadLabel"]');
  const textarea = card.querySelector('[data-field="prompt"]');

  if (action === "notify") {
    label.textContent = "Текст уведомления";
    textarea.placeholder = "Требуется ваше участие. Откройте чат ChatGPT.";
  } else {
    label.textContent = "Промпт";
    textarea.placeholder = "Что автоматически отправить в ChatGPT";
  }
}

function renderRules() {
  elements.rulesList.replaceChildren();

  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Правил нет. Добавьте флаг, чтобы расширение могло реагировать на ответы.";
    elements.rulesList.appendChild(empty);
    return;
  }

  for (const rule of rules) {
    const fragment = elements.ruleTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".rule-card");
    card.dataset.ruleId = rule.id;

    card.querySelector('[data-field="enabled"]').checked = rule.enabled;
    card.querySelector('[data-field="marker"]').value = rule.marker;
    card.querySelector('[data-field="action"]').value = rule.action;
    card.querySelector('[data-field="prompt"]').value = rule.prompt;
    updatePayloadLabel(card, rule.action);

    elements.rulesList.appendChild(fragment);
  }
}

function updateRuleFromField(field) {
  const card = field.closest(".rule-card");
  if (!card) return;

  const rule = rules.find((item) => item.id === card.dataset.ruleId);
  if (!rule) return;

  const key = field.dataset.field;
  if (key === "enabled") {
    rule.enabled = field.checked;
  } else {
    rule[key] = field.value;
  }

  if (key === "action") updatePayloadLabel(card, field.value);
}

function validateRules() {
  const markers = new Set();

  for (const rule of rules) {
    rule.marker = String(rule.marker || "").trim();
    rule.prompt = String(rule.prompt || "").trim();

    if (!rule.marker) return { ok: false, message: "У каждого правила должен быть флаг", rule };
    if (rule.marker.includes("\n")) return { ok: false, message: "Флаг должен занимать одну строку", rule };
    if (markers.has(rule.marker)) return { ok: false, message: `Флаг ${rule.marker} указан дважды`, rule };
    markers.add(rule.marker);

    if (rule.action === "prompt" && !rule.prompt) {
      return { ok: false, message: `Для ${rule.marker} укажите промпт`, rule };
    }
  }

  return { ok: true };
}

function focusRule(rule) {
  const card = Array.from(elements.rulesList.querySelectorAll(".rule-card"))
    .find((item) => item.dataset.ruleId === rule.id);
  card?.querySelector('[data-field="marker"]')?.focus();
}

async function load() {
  try {
    const settings = await chrome.storage.local.get([
      "enabled",
      "rules",
      "marker",
      "followUp",
      "delayMs"
    ]);

    elements.enabled.checked = settings.enabled ?? DEFAULTS.enabled;
    elements.delayMs.value = Number(settings.delayMs) || DEFAULTS.delayMs;
    rules = normalizeRules(settings.rules, settings.marker, settings.followUp);
    renderRules();
  } catch (error) {
    setStatus("Не удалось загрузить настройки", true);
    console.error(error);
  }
}

async function save() {
  const validation = validateRules();
  if (!validation.ok) {
    setStatus(validation.message, true);
    focusRule(validation.rule);
    return;
  }

  const delayMs = Math.min(30000, Math.max(300, Number(elements.delayMs.value) || DEFAULTS.delayMs));

  try {
    await chrome.storage.local.set({
      enabled: elements.enabled.checked,
      rules: rules.map((rule) => ({ ...rule })),
      delayMs
    });
    await chrome.storage.local.remove(["marker", "followUp"]);
    elements.delayMs.value = delayMs;
    renderRules();
    setStatus("Сохранено");
  } catch (error) {
    setStatus("Ошибка сохранения", true);
    console.error(error);
  }
}

async function saveEnabledState() {
  try {
    await chrome.storage.local.set({ enabled: elements.enabled.checked });
    setStatus(elements.enabled.checked ? "Обработка включена" : "Обработка выключена");
  } catch (error) {
    setStatus("Ошибка сохранения", true);
    console.error(error);
  }
}

function addRule() {
  if (rules.length >= MAX_RULES) {
    setStatus(`Можно создать не более ${MAX_RULES} правил`, true);
    return;
  }

  const rule = {
    id: createRuleId(),
    enabled: true,
    marker: "",
    action: "prompt",
    prompt: ""
  };

  rules.push(rule);
  renderRules();
  focusRule(rule);
}

function resetRules() {
  rules = cloneDefaultRules();
  renderRules();
  setStatus("Базовые правила восстановлены. Нажмите «Сохранить».");
}

elements.rulesList.addEventListener("input", (event) => {
  const field = event.target.closest("[data-field]");
  if (field) updateRuleFromField(field);
});

elements.rulesList.addEventListener("change", (event) => {
  const field = event.target.closest("[data-field]");
  if (field) updateRuleFromField(field);
});

elements.rulesList.addEventListener("click", (event) => {
  const removeButton = event.target.closest('[data-action="remove"]');
  if (!removeButton) return;

  const card = removeButton.closest(".rule-card");
  rules = rules.filter((rule) => rule.id !== card?.dataset.ruleId);
  renderRules();
});

elements.addRule.addEventListener("click", addRule);
elements.save.addEventListener("click", save);
elements.reset.addEventListener("click", resetRules);
elements.enabled.addEventListener("change", saveEnabledState);

load();
