(() => {
  "use strict";

  const CONTENT_VERSION = "1.0.0";
  if (window.top !== window) return;
  try { globalThis.__chatGptMultiAccountController?.dispose?.(); } catch { /* stale extension context */ }
  globalThis.__chatGptMultiAccountLoaded = CONTENT_VERSION;
  const UI_LOCALE = browser.i18n.getUILanguage();

  // A temporary add-on reload can leave the old closed Shadow DOM behind.
  // Remove those inert hosts before mounting the new version.
  document.querySelectorAll(
    '[data-cgpt-multi-account="launcher"], [data-cgpt-account-panel]'
  ).forEach((node) => node.remove());

  const state = {
    actionHost: null,
    actionButton: null,
    actionLabel: null,
    panelHost: null,
    panelRoot: null,
    panelElement: null,
    fileInput: null,
    open: false,
    loading: false,
    usageRefreshing: false,
    busy: "",
    message: "",
    messageType: "info",
    search: "",
    expandedId: null,
    renamingId: null,
    deleteConfirmId: null,
    data: { current: null, accounts: [] },
    avatarColors: new Map(),
    avatarColorLoads: new Set(),
    mountTimer: null,
    disposed: false,
    hostObservers: []
  };

  const observer = new MutationObserver(scheduleMount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });

  browser.runtime.onMessage.addListener(onRuntimeMessage);
  globalThis.__chatGptMultiAccountController = { version: CONTENT_VERSION, dispose };

  function onRuntimeMessage(message) {
    if (message?.type === "PING_ACCOUNT_EXTENSION") {
      ensureLauncher();
      return Promise.resolve({ ready: true });
    }
    if (message?.type === "OPEN_ACCOUNT_PANEL") {
      return openPanel().then(() => ({ opened: true }));
    }
    if (message?.type === "GET_ACCOUNT_PROFILE_HINT") {
      return Promise.resolve(readProfileHint());
    }
    return false;
  }

  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", positionUi);
  window.addEventListener("scroll", positionUi, true);

  function scheduleMount() {
    if (state.disposed || state.mountTimer) return;
    state.mountTimer = setTimeout(() => {
      state.mountTimer = null;
      ensureLauncher();
      syncTheme();
      positionUi();
    }, 120);
  }

  function ensureLauncher() {
    if (state.actionHost?.isConnected) {
      syncTheme();
      positionLauncher();
      return;
    }

    const host = document.createElement("span");
    host.dataset.cgptAccountAction = "";
    host.setAttribute("data-cgpt-multi-account", "launcher");
    host.style.position = "fixed";
    host.style.zIndex = "2147483646";
    host.style.display = "block";
    host.style.pointerEvents = "auto";
    host.style.visibility = "visible";
    host.style.opacity = "1";
    const root = host.attachShadow({ mode: "closed" });
    addStylesheet(root);

    const button = element("button", {
      className: "launcher",
      type: "button",
      title: t("switchAccount"),
      ariaLabel: t("actionTitle")
    });
    const label = element("span", { className: "launcher-label", text: t("accounts") });
    button.append(accountsIcon(), label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.open ? closePanel() : openPanel();
    });
    root.append(button);

    (document.body || document.documentElement).append(host);
    protectFromSiteModal(host);
    state.actionHost = host;
    state.actionButton = button;
    state.actionLabel = label;
    syncTheme();
    positionLauncher();
  }

  function positionLauncher() {
    const host = state.actionHost;
    if (!host?.isConnected) return;
    const temporaryButton = findTemporaryChatButton();

    if (temporaryButton) {
      const rect = temporaryButton.getBoundingClientRect();
      const buttonWidth = 36;
      host.dataset.placement = "temporary-chat";
      host.style.right = "auto";
      host.style.top = `${Math.max(6, Math.min(window.innerHeight - 42, rect.bottom + 5))}px`;
      host.style.left = `${Math.max(8, Math.min(window.innerWidth - buttonWidth - 8, rect.left + (rect.width - buttonWidth) / 2))}px`;
    } else {
      host.dataset.placement = "fallback";
      host.style.left = "auto";
      host.style.right = "14px";
      host.style.top = "62px";
    }
  }

  function positionUi() {
    positionLauncher();
    if (state.open) positionPanel();
  }

  function findTemporaryChatButton() {
    const exact = document.querySelector(
      'button[aria-label="Временный чат"], button[aria-label="Temporary chat"]'
    );
    if (exact) return exact;

    return Array.from(document.querySelectorAll("button[aria-label]")).find((button) => {
      const label = button.getAttribute("aria-label")?.toLowerCase() || "";
      return /временн.*чат|temporary\s+chat|chat\s+tempor/.test(label);
    }) || null;
  }

  async function openPanel() {
    ensureLauncher();
    if (!state.actionHost?.isConnected) {
      state.message = t("popupReloadHint");
      state.messageType = "error";
      return;
    }

    state.open = true;
    state.actionButton?.setAttribute("aria-expanded", "true");
    ensurePanel();
    showPanelHost();
    renderPanel();
    positionPanel();
    await refreshState();
  }

  function closePanel() {
    state.open = false;
    state.actionButton?.setAttribute("aria-expanded", "false");
    hidePanelHost();
    state.expandedId = null;
    state.renamingId = null;
    state.deleteConfirmId = null;
  }

  function ensurePanel() {
    if (state.panelHost?.isConnected) return;

    const host = document.createElement("div");
    host.dataset.cgptAccountPanel = "";
    host.hidden = true;
    if (typeof host.showPopover === "function") host.setAttribute("popover", "manual");
    const root = host.attachShadow({ mode: "closed" });
    addStylesheet(root);

    const panel = element("section", {
      className: "panel",
      role: "dialog",
      ariaLabel: t("actionTitle")
    });
    panel.addEventListener("click", onPanelClick);
    panel.addEventListener("input", onPanelInput);
    root.append(panel);

    const fileInput = element("input", {
      className: "visually-hidden",
      type: "file",
      accept: ".json,application/json"
    });
    fileInput.addEventListener("change", onImportFile);
    root.append(fileInput);

    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto";
    host.style.margin = "0";
    host.style.padding = "0";
    host.style.border = "0";
    host.style.background = "transparent";
    host.style.overflow = "visible";
    (document.body || document.documentElement).append(host);
    protectFromSiteModal(host);
    state.panelHost = host;
    state.panelRoot = root;
    state.panelElement = panel;
    state.fileInput = fileInput;
    syncTheme();
  }

  function syncTheme() {
    const root = document.documentElement;
    const explicitDark = root.classList.contains("dark") || root.dataset.theme === "dark";
    const explicitLight = root.classList.contains("light") || root.dataset.theme === "light";
    const computedScheme = getComputedStyle(root).colorScheme.trim();
    const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    const dark = explicitDark || (!explicitLight && (computedScheme === "dark" || prefersDark));
    const theme = dark ? "dark" : "light";
    if (state.actionHost) state.actionHost.dataset.theme = theme;
    if (state.panelHost) state.panelHost.dataset.theme = theme;
  }

  function showPanelHost() {
    const host = state.panelHost;
    if (!host) return;
    clearSiteAriaHiding(host);
    host.hidden = false;
    if (typeof host.showPopover === "function") {
      try { host.showPopover(); } catch { /* fallback display remains active */ }
    }
  }

  function hidePanelHost() {
    const host = state.panelHost;
    if (!host) return;
    if (typeof host.hidePopover === "function") {
      try { host.hidePopover(); } catch { /* it may already be closed */ }
    }
    host.hidden = true;
  }

  function protectFromSiteModal(host) {
    clearSiteAriaHiding(host);
    const hostObserver = new MutationObserver(() => clearSiteAriaHiding(host));
    hostObserver.observe(host, {
      attributes: true,
      attributeFilter: ["aria-hidden", "data-aria-hidden"]
    });
    state.hostObservers.push(hostObserver);
  }

  function clearSiteAriaHiding(host) {
    if (!host?.isConnected) return;
    if (host.getAttribute("aria-hidden") === "true") host.removeAttribute("aria-hidden");
    if (host.hasAttribute("data-aria-hidden")) host.removeAttribute("data-aria-hidden");
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    observer.disconnect();
    themeObserver.disconnect();
    for (const hostObserver of state.hostObservers) hostObserver.disconnect();
    if (state.mountTimer) clearTimeout(state.mountTimer);
    try { browser.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* old context */ }
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
    window.removeEventListener("resize", positionUi);
    window.removeEventListener("scroll", positionUi, true);
    state.actionHost?.remove();
    state.panelHost?.remove();
  }

  async function refreshState(options = {}) {
    state.loading = true;
    if (!options.keepMessage) state.message = "";
    renderPanel();

    try {
      state.data = await sendMessage("GET_ACCOUNT_STATE", { profileHint: readProfileHint() });
    } catch (error) {
      state.message = error.message;
      state.messageType = "error";
    } finally {
      state.loading = false;
      renderPanel();
      positionPanel();
    }
    if (state.data.accounts.some((account) => usageNeedsRefresh(account.usage))) {
      void refreshUsage(false);
    }
  }

  function renderPanel() {
    if (!state.panelElement) return;
    const panel = state.panelElement;
    panel.replaceChildren();

    const header = element("header", { className: "panel-header" });
    const titleWrap = element("div", { className: "title-wrap" });
    titleWrap.append(
      element("h2", { text: t("menuHeading") }),
      element("p", { text: accountCountLabel(state.data.accounts.length) })
    );
    const headerActions = element("div", { className: "header-actions" });
    headerActions.append(
      actionButton("refresh-usage", "", refreshIcon(), "icon-button", {
        disabled: state.usageRefreshing || !state.data.accounts.length,
        ariaLabel: t("refreshUsage"),
        title: t("refreshUsage")
      }),
      actionButton("close", "", closeIcon(), "icon-button", {
        ariaLabel: t("close"),
        title: t("close")
      })
    );
    header.append(titleWrap, headerActions);
    panel.append(header);

    if (state.message) {
      panel.append(element("div", {
        className: `notice notice--${state.messageType}`,
        text: state.message,
        role: state.messageType === "error" ? "alert" : "status"
      }));
    }

    if (state.loading && !state.data.current) {
      panel.append(renderLoading());
      return;
    }

    panel.append(renderCurrentAccount());

    if (state.data.accounts.length > 4) {
      const searchWrap = element("label", { className: "search" });
      searchWrap.append(searchIcon(), element("input", {
        type: "search",
        value: state.search,
        placeholder: t("searchAccounts"),
        ariaLabel: t("searchAccounts"),
        dataset: { role: "search" }
      }));
      panel.append(searchWrap);
    }

    const list = element("div", { className: "account-list", role: "list" });
    const filtered = filteredAccounts();
    if (!filtered.length) {
      list.append(element("div", {
        className: "empty",
        text: state.data.accounts.length ? t("nothingFound") : t("noSavedAccounts")
      }));
    } else {
      for (const account of filtered) list.append(renderAccount(account));
    }
    panel.append(list);

    const footer = element("footer", { className: "panel-footer" });
    footer.append(
      actionButton("import", t("importJson"), importIcon(), "footer-button"),
      actionButton("export-all", t("export"), exportIcon(), "footer-button", {
        disabled: !state.data.accounts.length || Boolean(state.busy)
      })
    );
    panel.append(footer);
  }

  function renderCurrentAccount() {
    const current = state.data.current;
    const card = element("section", { className: "current-card" });
    const eyebrow = element("div", { className: "eyebrow", text: t("currentAccount") });
    card.append(eyebrow);

    if (!current?.loggedIn) {
      const loggedOut = element("div", { className: "logged-out" });
      loggedOut.append(
        element("div", { className: "logged-out-icon", text: "?" }),
        element("div", {}, [
          element("strong", { text: t("signedOut") }),
          element("small", { text: t("signedOutHint") })
        ])
      );
      card.append(loggedOut);
      return card;
    }

    const row = element("div", { className: "current-row" });
    row.append(
      renderAvatar(current.name, current.avatarColor, current.avatarUrl),
      renderIdentity(current.name, current.email),
      element("span", { className: "active-pill", text: t("active") })
    );
    card.append(row);

    if (!current.savedAccountId) {
      card.append(actionButton(
        "save-current",
        state.busy === "save-current" ? t("saving") : t("addThisAccount"),
        plusIcon(),
        "primary-button",
        { disabled: Boolean(state.busy) }
      ));
    } else {
      const saved = element("div", { className: "saved-note" });
      saved.append(checkIcon(), element("span", { text: t("alreadySaved") }));
      card.append(saved);
      const currentAccount = state.data.accounts.find((account) => account.id === current.savedAccountId);
      if (currentAccount?.usage) card.append(renderUsage(currentAccount.usage, true));
    }
    return card;
  }

  function renderAccount(account) {
    const item = element("article", { className: "account-item", role: "listitem" });
    const main = actionButton("switch", "", null, "account-main", {
      accountId: account.id,
      disabled: account.isCurrent || account.expired || Boolean(state.busy)
    });
    const details = renderIdentity(
      account.name,
      account.email || (account.expired ? t("sessionExpired") : lastUsedLabel(account.lastUsedAt))
    );
    if (account.usage) details.append(renderUsage(account.usage, false));
    main.append(renderAvatar(account.name, account.avatarColor, account.avatarUrl), details);

    if (account.isCurrent) main.append(element("span", { className: "current-mark", text: t("current") }));
    else if (state.busy === `switch:${account.id}`) main.append(element("span", { className: "spinner", ariaLabel: t("switching") }));
    else main.append(chevronIcon());

    const more = actionButton("toggle-more", "", moreIcon(), "more-button", {
      accountId: account.id,
      disabled: Boolean(state.busy),
      ariaExpanded: state.expandedId === account.id ? "true" : "false",
      ariaLabel: t("actions"),
      title: t("actions")
    });
    const top = element("div", { className: "account-top" }, [main, more]);
    item.append(top);

    if (state.expandedId === account.id) item.append(renderAccountActions(account));
    return item;
  }

  function renderAccountActions(account) {
    const wrap = element("div", { className: "account-actions" });

    if (state.renamingId === account.id) {
      const form = element("div", { className: "rename-form" });
      form.append(
        element("input", {
          type: "text",
          value: account.name,
          maxLength: 80,
          ariaLabel: t("newAccountName"),
          dataset: { role: "rename-input", accountId: account.id }
        }),
        actionButton("rename-save", t("save"), checkIcon(), "mini-button mini-button--accent", {
          accountId: account.id
        })
      );
      queueMicrotask(() => form.querySelector("input")?.select());
      return form;
    }

    if (account.isCurrent) {
      wrap.append(actionButton("save-current", "", refreshIcon(), "mini-button mini-button--icon", {
        disabled: Boolean(state.busy),
        ariaLabel: t("update"),
        title: t("update")
      }));
    }
    wrap.append(
      actionButton("rename-start", "", editIcon(), "mini-button mini-button--icon", {
        accountId: account.id,
        ariaLabel: t("rename"),
        title: t("rename")
      }),
      actionButton("export-one", "JSON", exportIcon(), "mini-button", { accountId: account.id })
    );

    const confirming = state.deleteConfirmId === account.id;
    wrap.append(actionButton(
      confirming ? "delete-confirm" : "delete-start",
      confirming ? t("deleteConfirm") : t("delete"),
      trashIcon(),
      confirming ? "mini-button mini-button--danger" : "mini-button",
      { accountId: account.id }
    ));
    return wrap;
  }

  function renderLoading() {
    const wrap = element("div", { className: "loading" });
    wrap.append(
      element("div", { className: "skeleton skeleton--wide" }),
      element("div", { className: "skeleton" }),
      element("div", { className: "skeleton" })
    );
    return wrap;
  }

  async function onPanelClick(event) {
    const control = event.target.closest("[data-action]");
    if (!control || control.disabled) return;
    const action = control.dataset.action;
    const accountId = control.dataset.accountId;

    if (action === "close") return closePanel();
    if (action === "toggle-more") {
      state.expandedId = state.expandedId === accountId ? null : accountId;
      state.renamingId = null;
      state.deleteConfirmId = null;
      return renderPanel();
    }
    if (action === "rename-start") {
      state.renamingId = accountId;
      state.deleteConfirmId = null;
      return renderPanel();
    }
    if (action === "delete-start") {
      state.deleteConfirmId = accountId;
      return renderPanel();
    }
    if (action === "import") {
      state.fileInput.value = "";
      return state.fileInput.click();
    }

    if (action === "save-current") return saveCurrent();
    if (action === "refresh-usage") return refreshUsage(true);
    if (action === "switch") return switchToAccount(accountId);
    if (action === "rename-save") return saveRename(accountId);
    if (action === "delete-confirm") return deleteAccount(accountId);
    if (action === "export-one") return exportAccounts(accountId);
    if (action === "export-all") return exportAccounts(null);
  }

  function onPanelInput(event) {
    if (event.target.dataset.role !== "search") return;
    state.search = event.target.value;
    const list = state.panelElement.querySelector(".account-list");
    if (!list) return;
    list.replaceChildren();
    const filtered = filteredAccounts();
    if (!filtered.length) {
      list.append(element("div", { className: "empty", text: t("nothingFound") }));
    } else {
      for (const account of filtered) list.append(renderAccount(account));
    }
  }

  async function saveCurrent() {
    await runBusy("save-current", async () => {
      const result = await sendMessage("SAVE_CURRENT_ACCOUNT", { profileHint: readProfileHint() });
      state.message = result.updated ? t("accountSnapshotUpdated") : t("accountAdded");
      state.messageType = "success";
      state.expandedId = null;
      await reloadDataKeepingMessage();
    });
  }

  async function switchToAccount(accountId) {
    await runBusy(`switch:${accountId}`, async () => {
      const result = await sendMessage("SWITCH_ACCOUNT", {
        accountId,
        profileHint: readProfileHint()
      });
      if (result.alreadyActive) {
        state.message = t("alreadyActive");
        state.messageType = "info";
        return;
      }
      state.message = result.warningCount
        ? t("switchedWithWarnings", String(result.warningCount))
        : t("switchedReloading");
      state.messageType = result.warningCount ? "warning" : "success";
      renderPanel();
      setTimeout(() => window.location.reload(), 180);
    });
  }

  async function saveRename(accountId) {
    const input = state.panelElement.querySelector(
      `[data-role="rename-input"][data-account-id="${cssEscape(accountId)}"]`
    );
    const name = input?.value || "";
    await runBusy(`rename:${accountId}`, async () => {
      await sendMessage("RENAME_ACCOUNT", { accountId, name });
      state.message = t("nameChanged");
      state.messageType = "success";
      state.renamingId = null;
      await reloadDataKeepingMessage();
    });
  }

  async function deleteAccount(accountId) {
    await runBusy(`delete:${accountId}`, async () => {
      await sendMessage("DELETE_ACCOUNT", { accountId });
      state.message = t("accountDeleted");
      state.messageType = "success";
      state.expandedId = null;
      state.deleteConfirmId = null;
      await reloadDataKeepingMessage();
    });
  }

  async function onImportFile() {
    const file = state.fileInput.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      state.message = t("jsonTooLarge");
      state.messageType = "error";
      return renderPanel();
    }

    await runBusy("import", async () => {
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error(t("invalidJsonFile"));
      }
      const result = await sendMessage("IMPORT_ACCOUNTS", { payload });
      state.message = t("importSummary", [String(result.imported), String(result.updated), String(result.skipped)]);
      state.messageType = result.skipped ? "warning" : "success";
      await reloadDataKeepingMessage();
    });
  }

  async function exportAccounts(accountId) {
    await runBusy(accountId ? `export:${accountId}` : "export-all", async () => {
      const result = await sendMessage("EXPORT_ACCOUNTS", { accountId });
      downloadJson(result.filename, result.payload);
      state.message = t("exportDone");
      state.messageType = "warning";
    });
  }

  async function runBusy(key, operation) {
    if (state.busy) return;
    state.busy = key;
    state.message = "";
    renderPanel();
    try {
      await operation();
    } catch (error) {
      state.message = error.message;
      state.messageType = "error";
    } finally {
      state.busy = "";
      renderPanel();
      positionPanel();
    }
  }

  async function reloadDataKeepingMessage() {
    state.data = await sendMessage("GET_ACCOUNT_STATE", { profileHint: readProfileHint() });
  }

  async function refreshUsage(force) {
    if (state.usageRefreshing || !state.data.accounts.length) return;
    state.usageRefreshing = true;
    state.message = force ? t("checkingUsageAll") : t("autoUpdatingUsage");
    state.messageType = "info";
    renderPanel();
    try {
      const result = await sendMessage("REFRESH_ALL_USAGE", { force });
      state.data = await sendMessage("GET_ACCOUNT_STATE", { profileHint: readProfileHint() });
      state.message = result.failed
        ? t("usagePartial", [String(result.succeeded), String(result.failed)])
        : t("usageUpdated", String(result.succeeded));
      state.messageType = result.failed ? "warning" : "success";
    } catch (error) {
      state.message = error.message;
      state.messageType = "error";
    } finally {
      state.usageRefreshing = false;
      renderPanel();
      positionPanel();
    }
  }

  function renderUsage(usage, detailed) {
    const wrap = element("span", { className: `usage${detailed ? " usage--detailed" : ""}` });
    if (usage.error) {
      wrap.append(element("span", { className: "usage-error", text: t("usagePrefix", usage.error) }));
      return wrap;
    }
    const weekly = usage.weekly;
    const primary = usage.primary;
    const hasWeekly = weekly?.usedPercent != null && Number.isFinite(Number(weekly.usedPercent));
    const hasPrimary = primary?.usedPercent != null && Number.isFinite(Number(primary.usedPercent));
    if (!hasWeekly && !hasPrimary) {
      wrap.append(element("span", { className: "usage-error", text: t("usageDataMissing") }));
      return wrap;
    }
    if (hasWeekly) {
      wrap.append(renderUsageWindow("", weekly));
    }
    if (hasPrimary && (detailed || !hasWeekly)) {
      wrap.append(renderUsageWindow(windowLabel(primary, t("limit")), primary));
    }
    return wrap;
  }

  function renderUsageWindow(label, usageWindow) {
    const row = element("span", { className: "usage-window" });
    const used = clampPercent(usageWindow.usedPercent);
    const remaining = Number.isFinite(Number(usageWindow.remainingPercent))
      ? clampPercent(usageWindow.remainingPercent)
      : clampPercent(100 - used);
    row.style.setProperty("--usage-color", usageColor(remaining));
    const summary = element("span", { className: "usage-summary" });
    if (label) summary.append(element("span", { className: "usage-label", text: label }));
    summary.append(
      element("strong", { className: "usage-remaining", text: t("availablePercent", formatPercent(remaining)) }),
      element("span", { className: "usage-used", text: t("usedPercent", formatPercent(used)) })
    );
    if (usageWindow.resetAt) summary.title = t("resetAt", formatReset(usageWindow.resetAt));
    const meter = element("span", { className: "usage-meter" });
    const fill = element("span", { className: "usage-meter-fill" });
    fill.style.width = `${remaining}%`;
    meter.append(fill);
    row.append(summary, meter);
    return row;
  }

  function filteredAccounts() {
    const query = state.search.trim().toLocaleLowerCase(UI_LOCALE);
    if (!query) return state.data.accounts;
    return state.data.accounts.filter((account) =>
      `${account.name} ${account.email || ""}`.toLocaleLowerCase(UI_LOCALE).includes(query)
    );
  }

  function positionPanel() {
    if (!state.open || !state.panelHost || !state.actionHost?.isConnected) return;
    const anchor = state.actionHost.getBoundingClientRect();
    const viewportGap = 8;
    const panelWidth = Math.min(380, window.innerWidth - viewportGap * 2);
    const left = Math.max(viewportGap, Math.min(anchor.right - panelWidth, window.innerWidth - panelWidth - viewportGap));
    let top = anchor.bottom + 8;

    state.panelHost.style.width = `${panelWidth}px`;
    state.panelHost.style.left = `${left}px`;
    state.panelHost.style.top = `${top}px`;

    requestAnimationFrame(() => {
      if (!state.open || !state.panelElement) return;
      const height = Math.min(state.panelElement.getBoundingClientRect().height, window.innerHeight - 16);
      if (top + height > window.innerHeight - viewportGap && anchor.top > height + 16) {
        top = Math.max(viewportGap, anchor.top - height - 8);
        state.panelHost.style.top = `${top}px`;
      }
    });
  }

  function onDocumentPointerDown(event) {
    if (!state.open) return;
    const path = event.composedPath();
    if (!path.includes(state.actionHost) && !path.includes(state.panelHost)) closePanel();
  }

  function onDocumentKeyDown(event) {
    if (state.open && event.key === "Escape") closePanel();
  }

  function readProfileHint() {
    const profiles = Array.from(document.querySelectorAll('[data-testid="accounts-profile-button"]'));
    const labeled = profiles
      .map((profile) => ({ profile, label: profile.getAttribute("aria-label") || "" }))
      .filter((entry) => entry.label);
    const visible = labeled.filter(({ profile }) => {
      const rect = profile.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const pool = visible.length ? visible : labeled;
    const selected = pool.find(({ label }) => label.includes(","))
      || pool.sort((left, right) => right.label.length - left.label.length)[0]
      || { profile: profiles[0] || null, label: "" };
    const generic = /^(?:открыть меню профиля|open profile menu)$/i;
    const plan = /^(?:Free|Plus|Pro|Team|Business|Enterprise)$/i;
    const parts = selected.label.split(",").map((part) => part.trim()).filter(Boolean);
    const name = (parts.find((part) => !generic.test(part) && !plan.test(part)) || "")
      .replace(/\s+(?:Free|Plus|Pro|Team|Business|Enterprise)$/i, "")
      .trim();
    const detectedColor = readAvatarColor(selected.profile, name);
    const imageSource = avatarImageSource(selected.profile);
    const avatarColor = detectedColor || state.avatarColors.get(imageSource) || "";
    if (!avatarColor && imageSource) void loadAvatarColor(imageSource);
    return { name, avatarColor, avatarUrl: imageSource };
  }

  function readAvatarColor(profile, name) {
    if (!(profile instanceof Element)) return "";
    const expected = initials(name);
    let best = { color: "", score: -1 };

    for (const candidate of [profile, ...profile.querySelectorAll("*")]) {
      const style = getComputedStyle(candidate);
      const color = renderedAvatarColor(style.backgroundColor);
      if (!color) continue;

      const text = (candidate.textContent || "").trim().replace(/\s+/g, " ");
      const descriptor = `${candidate.getAttribute("class") || ""} ${candidate.getAttribute("data-testid") || ""}`;
      const rect = candidate.getBoundingClientRect();
      const width = rect.width || Number.parseFloat(style.width) || 0;
      const height = rect.height || Number.parseFloat(style.height) || 0;
      const shortestSide = Math.min(width, height);
      const radius = Number.parseFloat(style.borderRadius) || 0;
      let score = 0;

      if (expected && text.toLocaleUpperCase(UI_LOCALE) === expected) score += 8;
      else if (/^[\p{L}\p{N}]{1,3}$/u.test(text)) score += 3;
      if (/avatar|profile[-_ ]?(?:image|picture)|user[-_ ]?(?:image|picture)/i.test(descriptor)) score += 6;
      if (shortestSide >= 20 && shortestSide <= 64 && Math.max(width, height) / shortestSide <= 1.3) score += 3;
      if (shortestSide > 0 && radius >= shortestSide * .35) score += 4;
      if (candidate === profile) score -= 4;

      if (score > best.score) best = { color, score };
    }
    if (best.score >= 6) return best.color;
    return sampleAvatarImage(profile);
  }

  function renderedAvatarColor(value) {
    const color = String(value || "").trim();
    if (!color || color === "transparent") return "";
    const alpha = color.match(/^rgba\([^)]*,\s*(0(?:\.0+)?)\s*\)$/i);
    if (alpha) return "";
    const rgb = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgb && !usefulAvatarRgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))) return "";
    return rgb || /^#[0-9a-f]{3,8}$/i.test(color) ? color : "";
  }

  function sampleAvatarImage(profile) {
    for (const image of profile.querySelectorAll("img")) {
      const color = sampleImageElement(image);
      if (color) return color;
    }
    return "";
  }

  function sampleImageElement(image) {
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) return "";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 24;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return "";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const buckets = new Map();

      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3];
        if (alpha < 128) continue;
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        if (!usefulAvatarRgb(red, green, blue)) continue;
        const key = `${Math.round(red / 16)},${Math.round(green / 16)},${Math.round(blue / 16)}`;
        const bucket = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        bucket.count += 1;
        buckets.set(key, bucket);
      }

      const dominant = [...buckets.values()].sort((left, right) => right.count - left.count)[0];
      if (dominant?.count >= 8) {
        return `rgb(${Math.round(dominant.red / dominant.count)}, ${Math.round(dominant.green / dominant.count)}, ${Math.round(dominant.blue / dominant.count)})`;
      }
    } catch {
      // Cross-origin images can block direct canvas sampling.
    }
    return "";
  }

  function avatarImageSource(profile) {
    const image = profile?.querySelector("img");
    const source = image?.currentSrc || image?.src || "";
    if (!source || source.length > 4096) return "";
    try {
      const url = new URL(source, location.href);
      return ["https:", "blob:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  async function loadAvatarColor(source) {
    if (state.avatarColors.has(source) || state.avatarColorLoads.has(source)) return;
    state.avatarColorLoads.add(source);
    try {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error("avatar timeout")), 5_000);
        image.onload = () => {
          clearTimeout(timeoutId);
          resolve();
        };
        image.onerror = () => {
          clearTimeout(timeoutId);
          reject(new Error("avatar unavailable"));
        };
        image.src = source;
      });
      const color = sampleImageElement(image);
      if (color) {
        state.avatarColors.set(source, color);
        if (state.open) void refreshState({ keepMessage: true });
      }
    } catch {
      // The fallback avatar colors remain when the source disallows CORS.
    } finally {
      state.avatarColorLoads.delete(source);
    }
  }

  /*
   * Prefer a real ChatGPT avatar color. Dark neutral surfaces are ignored,
   * because they are usually the profile-button background rather than the
   * colored initials badge.
   */
  function usefulAvatarRgb(red, green, blue) {
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const spread = maximum - minimum;
    if (spread <= 18) return false;
    if (maximum <= 38 || minimum >= 245) return false;
    return true;
  }

  async function sendMessage(type, data = {}) {
    const response = await browser.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw new Error(response?.error || t("extensionNoResponse"));
    return response.data;
  }

  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function addStylesheet(root) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = browser.runtime.getURL("content.css");
    root.append(link);
  }

  function renderAvatar(name, color, imageUrl) {
    const avatar = element("span", { className: "avatar", text: initials(name) });
    lockAvatarFrame(avatar, 38);
    if (color) avatar.style.setProperty("--avatar-color", color);
    if (imageUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.width = 38;
      image.height = 38;
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.draggable = false;
      image.setAttribute("aria-hidden", "true");
      lockAvatarImage(image);
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = imageUrl;
      avatar.append(image);
    }
    return avatar;
  }

  function lockAvatarFrame(avatar, size) {
    const pixels = `${size}px`;
    avatar.style.setProperty("position", "relative", "important");
    avatar.style.setProperty("display", "grid", "important");
    avatar.style.setProperty("width", pixels, "important");
    avatar.style.setProperty("height", pixels, "important");
    avatar.style.setProperty("min-width", pixels, "important");
    avatar.style.setProperty("max-width", pixels, "important");
    avatar.style.setProperty("min-height", pixels, "important");
    avatar.style.setProperty("max-height", pixels, "important");
    avatar.style.setProperty("flex", `0 0 ${pixels}`, "important");
    avatar.style.setProperty("border-radius", "50%", "important");
    avatar.style.setProperty("overflow", "hidden", "important");
    avatar.style.setProperty("contain", "size paint", "important");
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

  function renderIdentity(name, secondary) {
    return element("span", { className: "identity" }, [
      element("strong", { text: name || t("defaultAccount") }),
      element("small", { text: secondary || t("savedSession") })
    ]);
  }

  function actionButton(action, label, icon, className, options = {}) {
    const button = element("button", {
      className,
      type: "button",
      text: icon ? "" : label,
      title: options.title || "",
      ariaLabel: options.ariaLabel || (icon && !label ? action : label),
      disabled: options.disabled,
      dataset: { action, accountId: options.accountId }
    });
    if (options.ariaExpanded) button.setAttribute("aria-expanded", options.ariaExpanded);
    if (icon) {
      button.append(icon);
      if (label) button.append(element("span", { text: label }));
    }
    return button;
  }

  function element(tagName, options = {}, children = []) {
    const node = document.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.type) node.type = options.type;
    if (options.role) node.setAttribute("role", options.role);
    if (options.ariaLabel) node.setAttribute("aria-label", options.ariaLabel);
    if (options.placeholder) node.placeholder = options.placeholder;
    if (options.value !== undefined) node.value = options.value;
    if (options.accept) node.accept = options.accept;
    if (options.title) node.title = options.title;
    if (options.maxLength) node.maxLength = options.maxLength;
    if (options.disabled) node.disabled = true;
    if (options.dataset) {
      for (const [key, value] of Object.entries(options.dataset)) {
        if (value !== undefined && value !== null) node.dataset[key] = value;
      }
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function svgIcon(paths, viewBox = "0 0 24 24") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const definition of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", definition.tag || "path");
      const attributes = definition.attrs || {};
      for (const name in attributes) path.setAttribute(name, attributes[name]);
      svg.append(path);
    }
    return svg;
  }

  const icon = (d) => svgIcon([{ attrs: { d } }]);
  const accountsIcon = () => svgIcon([
    { tag: "circle", attrs: { cx: "9", cy: "8", r: "3" } },
    { attrs: { d: "M3.5 18c.5-3 2.3-4.5 5.5-4.5s5 1.5 5.5 4.5" } },
    { attrs: { d: "M15 5.5a3 3 0 0 1 0 5.8M16 13.5c2.5.3 3.9 1.8 4.3 4.5" } }
  ]);
  const closeIcon = () => icon("M6 6l12 12M18 6 6 18");
  const plusIcon = () => icon("M12 5v14M5 12h14");
  const checkIcon = () => icon("m5 12 4 4L19 6");
  const chevronIcon = () => icon("m9 18 6-6-6-6");
  const moreIcon = () => svgIcon([
    { tag: "circle", attrs: { cx: "5", cy: "12", r: "1", fill: "currentColor", stroke: "none" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "1", fill: "currentColor", stroke: "none" } },
    { tag: "circle", attrs: { cx: "19", cy: "12", r: "1", fill: "currentColor", stroke: "none" } }
  ]);
  const searchIcon = () => icon("m21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z");
  const importIcon = () => icon("M12 3v12m0 0 4-4m-4 4-4-4M5 19h14");
  const exportIcon = () => icon("M12 15V3m0 0 4 4m-4-4L8 7M5 15v4h14v-4");
  const editIcon = () => icon("m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20ZM14 7l3 3");
  const trashIcon = () => icon("M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5");
  const refreshIcon = () => icon("M20 6v5h-5M4 18v-5h5m9.5-4A7 7 0 0 0 6 7m-.5 8A7 7 0 0 0 18 17");

  function initials(value) {
    const parts = String(value || "?").trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase(UI_LOCALE) || "?";
  }

  function accountCountLabel(count) {
    return t("savedCount", String(count));
  }

  function lastUsedLabel(value) {
    if (!value) return t("neverSwitched");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("savedSession");
    return t("lastLogin", new Intl.DateTimeFormat(UI_LOCALE, { day: "2-digit", month: "short" }).format(date));
  }

  function usageNeedsRefresh(usage) {
    const checkedAt = Date.parse(usage?.checkedAt || "");
    return usage?.schemaVersion !== 2 || !Number.isFinite(checkedAt) || Date.now() - checkedAt >= 10 * 60_000;
  }

  function formatPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    return `${Math.round(numeric)}%`;
  }

  function clampPercent(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
  }

  function usageColor(remaining) {
    if (remaining <= 15) return "var(--cas-critical)";
    if (remaining <= 40) return "var(--cas-warning)";
    return "var(--cas-accent)";
  }

  function windowLabel(usageWindow, fallback) {
    const seconds = Number(usageWindow?.durationSeconds);
    if (!Number.isFinite(seconds)) return fallback;
    if (seconds >= 6 * 86400) return fallback;
    if (seconds >= 3600) return t("hours", String(Math.round(seconds / 3600)));
    return t("minutes", String(Math.round(seconds / 60)));
  }

  function formatReset(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("unknown");
    return new Intl.DateTimeFormat(UI_LOCALE, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function cssEscape(value) {
    return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function t(key, substitutions) {
    return browser.i18n.getMessage(key, substitutions) || key;
  }

  // Icon helpers above use const bindings, so the first mount must happen only
  // after the whole script has finished initializing them.
  ensureLauncher();
})();
