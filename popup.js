"use strict";

const UI_LOCALE = browser.i18n.getUILanguage();
localizeDocument();

const status = document.querySelector("#status");
const openButton = document.querySelector("#open");
const pageButton = document.querySelector("#page");
const chatGptButton = document.querySelector("#chatgpt");
const manager = document.querySelector("#manager");
const notice = document.querySelector("#notice");
const currentRoot = document.querySelector("#current");
const accountsRoot = document.querySelector("#accounts");
const count = document.querySelector("#count");
const refreshButton = document.querySelector("#refresh");

refreshButton.setAttribute("aria-label", t("refreshUsage"));
refreshButton.title = t("refreshUsage");

let activeTab = null;
let accountState = null;
let activeProfileHint = {};
let busy = false;

initialize();

openButton.addEventListener("click", async () => {
  manager.hidden = !manager.hidden;
  openButton.textContent = manager.hidden ? t("popupOpenMenu") : t("popupHideMenu");
  if (!manager.hidden) await refreshManager();
});

pageButton.addEventListener("click", async () => {
  if (!activeTab?.id || busy) return;
  setBusy(true);
  setStatus(t("popupAttaching"));
  try {
    const ensured = await request("ENSURE_TAB_INJECTION", { tabId: activeTab.id });
    const response = await browser.tabs.sendMessage(activeTab.id, { type: "OPEN_ACCOUNT_PANEL" });
    if (!response?.opened) throw new Error(t("popupNoAck"));
    setStatus(ensured.injected ? t("popupInjectedOpened") : t("popupOpened"), "ready");
    setTimeout(() => window.close(), 280);
  } catch (error) {
    setStatus(error.message || t("popupOpenFailed"), "error");
    showNotice(t("popupReloadHint"), true);
  } finally {
    setBusy(false);
  }
});

refreshButton.addEventListener("click", () => refreshUsage(true));

chatGptButton.addEventListener("click", async () => {
  await browser.tabs.create({ url: "https://chatgpt.com/" });
  window.close();
});

currentRoot.addEventListener("click", async (event) => {
  if (!event.target.closest('[data-action="save"]') || busy) return;
  await perform(async () => {
    activeProfileHint = await readActiveProfileHint();
    const result = await request("SAVE_CURRENT_ACCOUNT", { tabId: activeTab.id, profileHint: activeProfileHint });
    showNotice(result.updated ? t("popupAccountUpdated") : t("accountAdded"));
    await refreshManager(true);
  });
});

accountsRoot.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="switch"]');
  if (!button || busy || button.disabled) return;
  const accountId = button.dataset.accountId;
  await perform(async () => {
    const result = await request("SWITCH_ACCOUNT", {
      tabId: activeTab.id,
      accountId,
      profileHint: activeProfileHint
    });
    if (result.alreadyActive) {
      showNotice(t("alreadyActive"));
      return;
    }
    showNotice(t("switchedReloading"));
    await browser.tabs.reload(activeTab.id);
    setTimeout(() => window.close(), 250);
  });
});

async function initialize() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
    if (!isChatGptUrl(activeTab?.url)) {
      setStatus(t("popupOpenTab"), "error");
      return;
    }

    openButton.disabled = false;
    pageButton.disabled = false;
    setStatus(t("popupReady"), "ready");

    try {
      const injected = await request("ENSURE_TAB_INJECTION", { tabId: activeTab.id });
      if (injected.injected) setStatus(t("popupConnected"), "ready");
    } catch (error) {
      setStatus(t("popupOnly"), "error");
    }
  } catch (error) {
    setStatus(error.message || t("popupGetTabFailed"), "error");
  }
}

async function refreshManager(keepNotice = false) {
  if (!activeTab?.id) return;
  if (!keepNotice) hideNotice();
  currentRoot.replaceChildren(loadingRow());
  accountsRoot.replaceChildren(loadingRow());
  try {
    activeProfileHint = await readActiveProfileHint();
    accountState = await request("GET_ACCOUNT_STATE", { tabId: activeTab.id, profileHint: activeProfileHint });
    renderManager();
    if (!keepNotice && accountState.accounts.some((account) => usageNeedsRefresh(account.usage))) {
      void refreshUsage(false);
    }
  } catch (error) {
    currentRoot.replaceChildren();
    accountsRoot.replaceChildren(empty(error.message));
    showNotice(error.message, true);
  }
}

function renderManager() {
  currentRoot.replaceChildren(renderCurrent());
  accountsRoot.replaceChildren();
  count.textContent = String(accountState.accounts.length);
  if (!accountState.accounts.length) {
    accountsRoot.append(empty(t("noSavedAccounts")));
    return;
  }
  for (const account of accountState.accounts) accountsRoot.append(renderAccount(account));
}

function renderCurrent() {
  const card = node("div", "current-card");
  card.append(node("div", "eyebrow", t("currentAccount")));
  const current = accountState.current;
  if (!current?.loggedIn) {
    card.append(node("div", "empty", t("loginNotDetected")));
    return card;
  }
  const row = node("div", "current-row");
  row.append(avatar(current.name, "current", current.avatarColor, current.avatarUrl), identity(current.name, current.email));
  card.append(row);
  const save = node("button", "save-button", current.savedAccountId ? t("updateSnapshot") : t("addThisAccount"));
  save.type = "button";
  save.dataset.action = "save";
  save.disabled = busy;
  card.append(save);
  return card;
}

function renderAccount(account) {
  const row = node("div", `account-row${account.isCurrent ? " current" : ""}`);
  const details = identity(account.name, account.email || (account.expired ? t("sessionExpired") : t("savedSession")));
  details.append(renderUsage(account.usage));
  row.append(avatar(account.name, "saved", account.avatarColor, account.avatarUrl), details);
  const button = node("button", "switch-button", account.isCurrent ? t("current") : t("enter"));
  button.type = "button";
  button.dataset.action = "switch";
  button.dataset.accountId = account.id;
  button.disabled = busy || account.isCurrent || account.expired;
  row.append(button);
  return row;
}

function renderUsage(usage) {
  const wrap = node("span", "usage");
  if (!usage) {
    wrap.append(node("span", "usage-line", t("usageNotChecked")));
    return wrap;
  }
  if (usage.error) {
    wrap.append(node("span", "usage-line error", usage.error));
    return wrap;
  }
  const weekly = usage.weekly;
  const primary = usage.primary;
  const hasWeekly = weekly?.usedPercent != null && Number.isFinite(Number(weekly.usedPercent));
  const hasPrimary = primary?.usedPercent != null && Number.isFinite(Number(primary.usedPercent));
  const shown = hasWeekly ? weekly : (hasPrimary ? primary : null);
  if (!shown) {
    wrap.append(node("span", "usage-line", t("serverNoUsage")));
    return wrap;
  }
  const used = clampPercent(shown.usedPercent);
  const remaining = Number.isFinite(Number(shown.remainingPercent))
    ? clampPercent(shown.remainingPercent)
    : clampPercent(100 - used);
  wrap.style.setProperty("--usage-color", usageColor(remaining));
  const line = node("span", "usage-line");
  line.append(
    node("span", "usage-available", t("availablePercent", `${Math.round(remaining)}%`)),
    node("span", "usage-used", t("usedPercent", `${Math.round(used)}%`))
  );
  if (shown.resetAt) line.title = t("resetAt", formatReset(shown.resetAt));
  const meter = node("span", "usage-meter");
  const fill = node("span");
  fill.style.width = `${remaining}%`;
  meter.append(fill);
  wrap.append(line, meter);
  return wrap;
}

async function refreshUsage(force) {
  if (busy || !accountState?.accounts.length) return;
  setBusy(true);
  refreshButton.classList.add("is-loading");
  refreshButton.setAttribute("aria-busy", "true");
  if (force) showNotice(t("checkingWeekly"));
  try {
    const result = await request("REFRESH_ALL_USAGE", { force });
    accountState = await request("GET_ACCOUNT_STATE", { tabId: activeTab.id });
    renderManager();
    if (result.failed) showNotice(t("checkedSummary", [String(result.succeeded), String(result.failed)]), true);
    else if (force) showNotice(t("limitsUpdatedShort", String(result.succeeded)));
  } catch (error) {
    showNotice(error.message || t("usageRefreshFailed"), true);
  } finally {
    setBusy(false);
    refreshButton.classList.remove("is-loading");
    refreshButton.removeAttribute("aria-busy");
  }
}

async function perform(operation) {
  setBusy(true);
  hideNotice();
  try {
    await operation();
  } catch (error) {
    showNotice(error.message || t("operationFailed"), true);
  } finally {
    setBusy(false);
    if (accountState) renderManager();
  }
}

async function request(type, data = {}) {
  const response = await browser.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || t("backgroundNoResponse"));
  return response.data;
}

function setBusy(value) {
  busy = value;
  openButton.disabled = value || !activeTab;
  pageButton.disabled = value || !activeTab;
  refreshButton.disabled = value || !accountState?.accounts.length;
}

function setStatus(message, kind = "") {
  status.textContent = message;
  status.className = kind;
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.className = isError ? "error" : "";
  notice.hidden = false;
}

function hideNotice() {
  notice.hidden = true;
  notice.textContent = "";
}

function loadingRow() {
  return node("div", "empty", t("loading"));
}

function empty(text) {
  return node("div", "empty", text);
}

function avatar(name, kind, color, imageUrl) {
  const element = node("span", `avatar avatar--${kind}`, initials(name));
  lockAvatarFrame(element, 34);
  if (color) element.style.setProperty("--avatar-color", color);
  if (imageUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.width = 34;
    image.height = 34;
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.draggable = false;
    image.setAttribute("aria-hidden", "true");
    lockAvatarImage(image);
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = imageUrl;
    element.append(image);
  }
  return element;
}

function lockAvatarFrame(element, size) {
  const pixels = `${size}px`;
  element.style.setProperty("position", "relative", "important");
  element.style.setProperty("display", "grid", "important");
  element.style.setProperty("width", pixels, "important");
  element.style.setProperty("height", pixels, "important");
  element.style.setProperty("min-width", pixels, "important");
  element.style.setProperty("max-width", pixels, "important");
  element.style.setProperty("min-height", pixels, "important");
  element.style.setProperty("max-height", pixels, "important");
  element.style.setProperty("flex", `0 0 ${pixels}`, "important");
  element.style.setProperty("border-radius", "50%", "important");
  element.style.setProperty("overflow", "hidden", "important");
  element.style.setProperty("contain", "size paint", "important");
}

function lockAvatarImage(image) {
  image.style.setProperty("position", "absolute", "important");
  image.style.setProperty("inset", "0", "important");
  image.style.setProperty("display", "block", "important");
  image.style.setProperty("width", "100%", "important");
  image.style.setProperty("height", "100%", "important");
  image.style.setProperty("min-width", "100%", "important");
  image.style.setProperty("max-width", "100%", "important");
  image.style.setProperty("min-height", "100%", "important");
  image.style.setProperty("max-height", "100%", "important");
  image.style.setProperty("margin", "0", "important");
  image.style.setProperty("padding", "0", "important");
  image.style.setProperty("border", "0", "important");
  image.style.setProperty("border-radius", "50%", "important");
  image.style.setProperty("object-fit", "cover", "important");
  image.style.setProperty("object-position", "center", "important");
}

async function readActiveProfileHint() {
  if (!activeTab?.id) return {};
  try {
    const hint = await browser.tabs.sendMessage(activeTab.id, { type: "GET_ACCOUNT_PROFILE_HINT" });
    return hint && typeof hint === "object" ? hint : {};
  } catch {
    return {};
  }
}

function identity(name, secondary) {
  const wrap = node("span", "identity");
  wrap.append(node("strong", "", name || t("defaultAccount")), node("small", "", secondary || ""));
  return wrap;
}

function node(tag, className = "", text = undefined) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function initials(value) {
  return String(value || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function usageNeedsRefresh(usage) {
  const checkedAt = Date.parse(usage?.checkedAt || "");
  return usage?.schemaVersion !== 2 || !Number.isFinite(checkedAt) || Date.now() - checkedAt >= 10 * 60_000;
}

function clampPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
}

function usageColor(remaining) {
  if (remaining <= 15) return "var(--popup-critical)";
  if (remaining <= 40) return "var(--popup-warning)";
  return "var(--popup-accent)";
}

function formatReset(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(UI_LOCALE, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function t(key, substitutions) {
  return browser.i18n.getMessage(key, substitutions) || key;
}

function localizeDocument() {
  document.documentElement.lang = browser.i18n.getUILanguage().split("-")[0] || "en";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const message = browser.i18n.getMessage(element.dataset.i18n);
    if (message) element.textContent = message;
  }
}

function isChatGptUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}
