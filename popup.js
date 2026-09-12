const DEFAULTS = {
  enabled: true,
  marker: "DONE",
  followUp: "Делай следующее задание",
  delayMs: 1200
};

const elements = {
  enabled: document.querySelector("#enabled"),
  marker: document.querySelector("#marker"),
  followUp: document.querySelector("#followUp"),
  delayMs: document.querySelector("#delayMs"),
  save: document.querySelector("#save"),
  status: document.querySelector("#status")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => {
    elements.status.textContent = "";
    elements.status.classList.remove("error");
  }, 2200);
}

async function load() {
  try {
    const settings = await chrome.storage.local.get(DEFAULTS);
    elements.enabled.checked = Boolean(settings.enabled);
    elements.marker.value = settings.marker || DEFAULTS.marker;
    elements.followUp.value = settings.followUp || DEFAULTS.followUp;
    elements.delayMs.value = Number(settings.delayMs) || DEFAULTS.delayMs;
  } catch (error) {
    setStatus("Не удалось загрузить настройки", true);
    console.error(error);
  }
}

async function save() {
  const marker = elements.marker.value.trim();
  const followUp = elements.followUp.value.trim();
  const delayMs = Math.min(30000, Math.max(300, Number(elements.delayMs.value) || DEFAULTS.delayMs));

  if (!marker) {
    setStatus("Укажи маркер", true);
    elements.marker.focus();
    return;
  }

  if (!followUp) {
    setStatus("Укажи сообщение", true);
    elements.followUp.focus();
    return;
  }

  try {
    await chrome.storage.local.set({
      enabled: elements.enabled.checked,
      marker,
      followUp,
      delayMs
    });
    elements.delayMs.value = delayMs;
    setStatus("Сохранено");
  } catch (error) {
    setStatus("Ошибка сохранения", true);
    console.error(error);
  }
}

elements.save.addEventListener("click", save);
elements.enabled.addEventListener("change", save);

document.addEventListener("DOMContentLoaded", load);
load();
