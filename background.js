"use strict";

const STORAGE_KEY = "chatgptMultiAccount.accounts.v1";
const EXPORT_FORMAT = "ChatGPT Multi Account";
const MAX_ACCOUNTS = 100;
const MAX_COOKIES_PER_ACCOUNT = 500;
const MAX_COOKIE_VALUE_LENGTH = 100_000;
const AUTH_COOKIE_RE = /(?:session-token|__secure-oai|_uasid|_umsid)/i;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SESSION_URL = "https://chatgpt.com/api/auth/session";
const USAGE_MARKER_HEADER = "x-chatgpt-multi-account-usage";
const USAGE_ALARM = "chatgptMultiAccount.refreshUsage";
const USAGE_REFRESH_MINUTES = 30;
const USAGE_CACHE_MS = 10 * 60_000;
const USAGE_SCHEMA_VERSION = 2;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const pendingUsageRequests = new Map();
const protectedUsageRequestIds = new Set();

let mutationQueue = Promise.resolve();

initializeStorageAccess();
initializeUsageRequestIsolation();
scheduleUsageRefresh();
injectIntoExistingChatGptTabs();

browser.runtime.onInstalled.addListener(async () => {
  await initializeStorageAccess();
  await scheduleUsageRefresh();
  await injectIntoExistingChatGptTabs();
  await queueMutation(() => refreshAllUsage(false));
});
browser.runtime.onStartup.addListener(async () => {
  await initializeStorageAccess();
  await scheduleUsageRefresh();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== USAGE_ALARM) return;
  queueMutation(() => refreshAllUsage(false)).catch((error) => {
    console.warn("ChatGPT Multi Account: automatic usage refresh failed", error);
  });
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return false;

  return handleMessage(message, sender)
    .then((data) => ({ ok: true, data }))
    .catch((error) => {
      console.error("ChatGPT Multi Account:", error);
      return { ok: false, error: error?.message || t("unknownError") };
    });
});

browser.action.onClicked.addListener(async (tab) => {
  if (tab?.id && isChatGptUrl(tab.url)) {
    try {
      await ensureTabInjection(tab.id);
      await browser.tabs.sendMessage(tab.id, { type: "OPEN_ACCOUNT_PANEL" });
      return;
    } catch {
      // The page may have been open before the extension was loaded.
    }
  }
  await browser.tabs.create({ url: "https://chatgpt.com/" });
});

async function initializeStorageAccess() {
  try {
    if (typeof browser.storage.local.setAccessLevel === "function") {
      await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch (error) {
    console.warn("ChatGPT Multi Account: storage access could not be restricted", error);
  }

  const stored = await browser.storage.local.get(STORAGE_KEY);
  if (!Array.isArray(stored[STORAGE_KEY])) {
    await browser.storage.local.set({ [STORAGE_KEY]: [] });
  }
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case "ENSURE_TAB_INJECTION":
      return ensureTabInjection(message.tabId);
    case "GET_ACCOUNT_STATE":
      return queueMutation(() => getAccountState(sender, message.profileHint, message.tabId));
    case "SAVE_CURRENT_ACCOUNT":
      return queueMutation(() => saveCurrentAccount(sender, message.profileHint, message.tabId));
    case "SWITCH_ACCOUNT":
      return queueMutation(() => switchAccount(sender, message.accountId, message.profileHint, message.tabId));
    case "DELETE_ACCOUNT":
      return queueMutation(() => deleteAccount(message.accountId));
    case "RENAME_ACCOUNT":
      return queueMutation(() => renameAccount(message.accountId, message.name));
    case "IMPORT_ACCOUNTS":
      return queueMutation(() => importAccounts(message.payload));
    case "EXPORT_ACCOUNTS":
      return exportAccounts(message.accountId);
    case "REFRESH_ALL_USAGE":
      return queueMutation(() => refreshAllUsage(message.force === true));
    default:
      throw new Error(t("unknownCommand"));
  }
}

async function scheduleUsageRefresh() {
  try {
    await browser.alarms.create(USAGE_ALARM, { periodInMinutes: USAGE_REFRESH_MINUTES });
  } catch (error) {
    console.warn("ChatGPT Multi Account: usage alarm could not be scheduled", error);
  }
}

function initializeUsageRequestIsolation() {
  const urls = [
    "https://chatgpt.com/backend-api/wham/usage*",
    "https://chatgpt.com/api/auth/session*"
  ];

  browser.webRequest.onBeforeSendHeaders.addListener(
    isolateUsageRequestHeaders,
    { urls },
    ["blocking", "requestHeaders"]
  );
  browser.webRequest.onHeadersReceived.addListener(
    isolateUsageResponseHeaders,
    { urls },
    ["blocking", "responseHeaders"]
  );
  browser.webRequest.onCompleted.addListener(cleanupUsageRequest, { urls });
  browser.webRequest.onErrorOccurred.addListener(cleanupUsageRequest, { urls });
}

function isolateUsageRequestHeaders(details) {
  const headers = Array.isArray(details.requestHeaders) ? details.requestHeaders.slice() : [];
  const marker = headers.find((header) => header.name?.toLowerCase() === USAGE_MARKER_HEADER)?.value;
  const request = marker ? pendingUsageRequests.get(marker) : null;
  if (!request) return undefined;

  protectedUsageRequestIds.add(details.requestId);
  const next = headers.filter((header) => ![
    USAGE_MARKER_HEADER,
    "cookie",
    "authorization",
    "chatgpt-account-id",
    "origin",
    "referer"
  ].includes(header.name?.toLowerCase()));

  if (request.cookieHeader) next.push({ name: "Cookie", value: request.cookieHeader });
  if (request.accessToken) next.push({ name: "Authorization", value: `Bearer ${request.accessToken}` });
  if (request.accountId) next.push({ name: "ChatGPT-Account-Id", value: request.accountId });
  next.push({ name: "Referer", value: "https://chatgpt.com/" });
  return { requestHeaders: next };
}

function isolateUsageResponseHeaders(details) {
  if (!protectedUsageRequestIds.has(details.requestId)) return undefined;
  const responseHeaders = (details.responseHeaders || []).filter(
    (header) => header.name?.toLowerCase() !== "set-cookie"
  );
  return { responseHeaders };
}

function cleanupUsageRequest(details) {
  protectedUsageRequestIds.delete(details.requestId);
}

async function injectIntoExistingChatGptTabs() {
  try {
    const tabs = await browser.tabs.query({
      url: ["https://chatgpt.com/*", "https://*.chatgpt.com/*"]
    });
    await Promise.allSettled(tabs.map((tab) => tab.id ? ensureTabInjection(tab.id) : null));
  } catch (error) {
    console.warn("ChatGPT Multi Account: existing tabs could not be injected", error);
  }
}

async function ensureTabInjection(tabId) {
  if (!Number.isInteger(tabId)) throw new Error(t("tabNotFound"));
  try {
    const pong = await browser.tabs.sendMessage(tabId, { type: "PING_ACCOUNT_EXTENSION" });
    if (pong?.ready) return { ready: true, injected: false };
  } catch {
    // Inject below when the manifest content script is not present yet.
  }

  await browser.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content.js"]
  });
  return { ready: true, injected: true };
}

function queueMutation(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

async function getAccountState(sender, profileHint, tabId) {
  const tab = await resolveChatGptTab(sender, tabId);
  const accounts = await getAccounts();
  const snapshot = await captureCurrentSnapshot(tab, profileHint);
  let saved = snapshot.identityKey
    ? accounts.find((account) => account.identityKey === snapshot.identityKey)
    : null;

  const savedColor = normalizeAvatarColor(saved?.avatarColor);
  const nextColor = snapshot.avatarColor || savedColor;
  const savedAvatarUrl = accountAvatarUrl(saved);
  const nextAvatarUrl = snapshot.avatarUrl || savedAvatarUrl;
  if (saved && (saved.avatarColor !== nextColor || saved.avatarUrl !== nextAvatarUrl)) {
    const index = accounts.findIndex((account) => account.id === saved.id);
    saved = { ...saved, avatarColor: nextColor, avatarUrl: nextAvatarUrl };
    accounts[index] = saved;
    await setAccounts(accounts);
  }

  return {
    current: {
      loggedIn: snapshot.loggedIn,
      identityKey: snapshot.identityKey,
      name: snapshot.name,
      email: snapshot.email,
      avatarColor: snapshot.avatarColor || normalizeAvatarColor(saved?.avatarColor),
      avatarUrl: snapshot.avatarUrl || accountAvatarUrl(saved),
      savedAccountId: saved?.id || null
    },
    accounts: sortAccounts(accounts).map((account) => accountMetadata(account, snapshot.identityKey))
  };
}

async function saveCurrentAccount(sender, profileHint, tabId) {
  const tab = await resolveChatGptTab(sender, tabId);
  const snapshot = await captureCurrentSnapshot(tab, profileHint);
  if (!snapshot.loggedIn || !snapshot.identityKey) {
    throw new Error(t("activeAccountMissing"));
  }

  const accounts = await getAccounts();
  const existingIndex = accounts.findIndex((account) => account.identityKey === snapshot.identityKey);
  const now = new Date().toISOString();
  let account;

  if (existingIndex >= 0) {
    account = {
      ...accounts[existingIndex],
      name: snapshot.name || accounts[existingIndex].name,
      email: snapshot.email || accounts[existingIndex].email,
      avatarColor: snapshot.avatarColor || normalizeAvatarColor(accounts[existingIndex].avatarColor),
      avatarUrl: snapshot.avatarUrl || accountAvatarUrl(accounts[existingIndex]),
      cookies: snapshot.cookies,
      updatedAt: now,
      lastUsedAt: now
    };
    accounts[existingIndex] = account;
  } else {
    if (accounts.length >= MAX_ACCOUNTS) throw new Error(t("maxAccounts", String(MAX_ACCOUNTS)));
    account = {
      id: createId(),
      identityKey: snapshot.identityKey,
      name: snapshot.name,
      email: snapshot.email,
      avatarColor: snapshot.avatarColor,
      avatarUrl: snapshot.avatarUrl,
      cookies: snapshot.cookies,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    };
    accounts.push(account);
  }

  await setAccounts(accounts);
  return { account: accountMetadata(account, snapshot.identityKey), updated: existingIndex >= 0 };
}

async function switchAccount(sender, accountId, profileHint, tabId) {
  const tab = await resolveChatGptTab(sender, tabId);
  const accounts = await getAccounts();
  const targetIndex = accounts.findIndex((account) => account.id === accountId);
  if (targetIndex < 0) throw new Error(t("accountNotFound"));

  const target = accounts[targetIndex];
  const usableTargetCookies = target.cookies.filter(isUsableCookie);
  const targetAuthCookies = usableTargetCookies.filter((cookie) => AUTH_COOKIE_RE.test(cookie.name));
  if (!targetAuthCookies.length) {
    throw new Error(t("authCookiesExpired"));
  }

  const current = await captureCurrentSnapshot(tab, profileHint);
  if (current.identityKey === target.identityKey) {
    return { switched: false, alreadyActive: true, warningCount: 0 };
  }

  const now = new Date().toISOString();
  if (current.loggedIn && current.identityKey) {
    const currentIndex = accounts.findIndex((account) => account.identityKey === current.identityKey);
    if (currentIndex >= 0) {
      accounts[currentIndex] = {
        ...accounts[currentIndex],
        name: current.name || accounts[currentIndex].name,
        email: current.email || accounts[currentIndex].email,
        avatarColor: current.avatarColor || normalizeAvatarColor(accounts[currentIndex].avatarColor),
        avatarUrl: current.avatarUrl || accountAvatarUrl(accounts[currentIndex]),
        cookies: current.cookies,
        updatedAt: now,
        lastUsedAt: now
      };
    }
  }

  const backupCookies = current.cookies;
  await clearChatGptCookies(tab.cookieStoreId);
  const applied = await applyCookies(usableTargetCookies, tab.cookieStoreId);
  const failedAuthCookie = applied.failures.some((failure) => AUTH_COOKIE_RE.test(failure.cookie.name));

  if (!applied.applied || failedAuthCookie) {
    await clearChatGptCookies(tab.cookieStoreId);
    await applyCookies(backupCookies.filter(isUsableCookie), tab.cookieStoreId);
    throw new Error(t("cookieApplyFailed"));
  }

  accounts[targetIndex] = { ...target, lastUsedAt: now };
  await setAccounts(accounts);
  return { switched: true, alreadyActive: false, warningCount: applied.failures.length };
}

async function deleteAccount(accountId) {
  const accounts = await getAccounts();
  const next = accounts.filter((account) => account.id !== accountId);
  if (next.length === accounts.length) throw new Error(t("accountNotFound"));
  await setAccounts(next);
  return { deleted: true };
}

async function renameAccount(accountId, requestedName) {
  const name = normalizeText(requestedName, 80);
  if (!name) throw new Error(t("renameRequired"));
  const accounts = await getAccounts();
  const index = accounts.findIndex((account) => account.id === accountId);
  if (index < 0) throw new Error(t("accountNotFound"));
  accounts[index] = { ...accounts[index], name, updatedAt: new Date().toISOString() };
  await setAccounts(accounts);
  return { account: accountMetadata(accounts[index], null) };
}

async function importAccounts(payload) {
  const candidates = normalizeImportPayload(payload);
  if (!candidates.length) throw new Error(t("importNoAccounts"));
  if (candidates.length > MAX_ACCOUNTS) throw new Error(t("maxImport", String(MAX_ACCOUNTS)));

  const accounts = await getAccounts();
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      const cookies = sanitizeCookieList(candidate.cookies);
      const identity = await identifyCookies(cookies, {
        name: candidate.name,
        email: candidate.email,
        avatarColor: candidate.avatarColor,
        avatarUrl: candidate.avatarUrl
      });
      if (!identity.loggedIn || !identity.identityKey) {
        skipped += 1;
        continue;
      }

      const now = new Date().toISOString();
      const existingIndex = accounts.findIndex((account) => account.identityKey === identity.identityKey);
      if (existingIndex >= 0) {
        accounts[existingIndex] = {
          ...accounts[existingIndex],
          name: normalizeText(candidate.name, 80) || identity.name || accounts[existingIndex].name,
          email: normalizeEmail(candidate.email) || identity.email || accounts[existingIndex].email,
          avatarColor: identity.avatarColor || normalizeAvatarColor(accounts[existingIndex].avatarColor),
          avatarUrl: identity.avatarUrl || accountAvatarUrl(accounts[existingIndex]),
          cookies,
          updatedAt: now
        };
        updated += 1;
      } else if (accounts.length < MAX_ACCOUNTS) {
        accounts.push({
          id: createId(),
          identityKey: identity.identityKey,
          name: normalizeText(candidate.name, 80) || identity.name,
          email: normalizeEmail(candidate.email) || identity.email,
          avatarColor: identity.avatarColor,
          avatarUrl: identity.avatarUrl,
          cookies,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: candidate.lastUsedAt || null
        });
        imported += 1;
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  await setAccounts(accounts);
  return { imported, updated, skipped };
}

async function exportAccounts(accountId) {
  let accounts = await getAccounts();
  if (accountId) accounts = accounts.filter((account) => account.id === accountId);
  if (!accounts.length) throw new Error(t("exportNoAccounts"));

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    filename: accountId ? `chatgpt-account-${stamp}.json` : `chatgpt-accounts-${stamp}.json`,
    payload: {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      warning: t("exportWarning"),
      accounts: accounts.map((account) => ({
        name: account.name,
        email: account.email,
        avatarColor: normalizeAvatarColor(account.avatarColor),
        avatarUrl: accountAvatarUrl(account),
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        lastUsedAt: account.lastUsedAt,
        cookies: account.cookies
      }))
    }
  };
}

async function refreshAllUsage(force = false) {
  const accounts = await getAccounts();
  const now = Date.now();
  const targets = accounts.filter((account) =>
    force || account.usage?.schemaVersion !== USAGE_SCHEMA_VERSION ||
      !account.usage?.checkedAt || now - Date.parse(account.usage.checkedAt) >= USAGE_CACHE_MS
  );
  if (!targets.length) return { checked: 0, succeeded: 0, failed: 0, cached: accounts.length };

  const results = await mapWithConcurrency(targets, 3, async (account) => {
    try {
      return { id: account.id, usage: await checkAccountUsage(account), ok: true };
    } catch (error) {
      return {
        id: account.id,
        usage: {
          schemaVersion: USAGE_SCHEMA_VERSION,
          checkedAt: new Date().toISOString(),
          error: usageErrorMessage(error)
        },
        ok: false
      };
    }
  });

  const resultById = new Map(results.map((result) => [result.id, result]));
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < accounts.length; index += 1) {
    const result = resultById.get(accounts[index].id);
    if (!result) continue;
    accounts[index] = { ...accounts[index], usage: result.usage };
    if (result.ok) succeeded += 1;
    else failed += 1;
  }
  await setAccounts(accounts);
  return { checked: targets.length, succeeded, failed, cached: accounts.length - targets.length };
}

async function checkAccountUsage(account) {
  let sessionError = null;
  let authorizedError = null;

  // This is the same two-step flow used by the site: restore the selected
  // account's session from its cookie snapshot, then call Wham with the
  // resulting bearer token and account id. No visible tab is switched.
  try {
    const session = await fetchAccountJson(account, SESSION_URL);
    const accessToken = findAccessToken(session);
    if (!accessToken) throw new Error(t("tokenMissing"));
    const accountId = findAccountId(session, accessToken);
    try {
      const payload = await fetchAccountJson(account, USAGE_URL, { accessToken, accountId });
      return normalizeUsagePayload(payload);
    } catch (error) {
      authorizedError = error;
    }
  } catch (error) {
    sessionError = error;
  }

  // Some ChatGPT sessions allow the same endpoint directly by cookie. Keep
  // this as a compatibility fallback, but never prefer it over the site's
  // authenticated session flow above.
  try {
    const payload = await fetchAccountJson(account, USAGE_URL);
    return normalizeUsagePayload(payload);
  } catch (directError) {
    throw authorizedError || sessionError || directError;
  }
}

async function fetchAccountJson(account, url, authorization = {}) {
  const marker = createId();
  const cookieHeader = buildCookieHeader(account.cookies, url);
  if (!cookieHeader) throw new Error(t("cookiesMissing"));
  pendingUsageRequests.set(marker, {
    cookieHeader,
    accessToken: authorization.accessToken || "",
    accountId: authorization.accountId || ""
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        [USAGE_MARKER_HEADER]: marker
      }
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        const error = new Error(t("nonJsonResponse"));
        error.status = response.status;
        throw error;
      }
    }
    if (!response.ok) {
      const error = new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(t("requestTimeout"));
    throw error;
  } finally {
    clearTimeout(timeoutId);
    pendingUsageRequests.delete(marker);
  }
}

function buildCookieHeader(cookies, targetUrl) {
  const url = new URL(targetUrl);
  return cookies
    .filter((cookie) => isUsableCookie(cookie))
    .filter((cookie) => cookie.secure !== true || url.protocol === "https:")
    .filter((cookie) => cookieDomainMatches(cookie.domain, url.hostname))
    .filter((cookie) => url.pathname.startsWith(normalizePath(cookie.path)))
    .filter((cookie) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name))
    .filter((cookie) => !/[\r\n]/.test(cookie.value))
    .sort((left, right) => normalizePath(right.path).length - normalizePath(left.path).length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function cookieDomainMatches(domain, hostname) {
  const normalized = String(domain || "").replace(/^\./, "").toLowerCase();
  const target = hostname.toLowerCase();
  return target === normalized || target.endsWith(`.${normalized}`);
}

function findAccessToken(session) {
  const candidates = [
    session?.accessToken,
    session?.access_token,
    session?.token?.accessToken,
    session?.token?.access_token,
    session?.session?.accessToken
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 40) || "";
}

function findAccountId(session, accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"] || payload?.auth || {};
  const candidates = [
    session?.account?.id,
    session?.accountId,
    session?.chatgptAccountId,
    session?.user?.accountId,
    auth?.chatgpt_account_id,
    auth?.account_id,
    payload?.chatgpt_account_id,
    payload?.account_id
  ];
  return candidates.find((value) => typeof value === "string" && value.length >= 8) || "";
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function normalizeUsagePayload(payload) {
  const rateLimit = payload?.rate_limit || payload?.rateLimit;
  if (!rateLimit || typeof rateLimit !== "object") {
    throw new Error(t("usageResponseMissing"));
  }
  const first = normalizeUsageWindow(rateLimit.primary_window || rateLimit.primaryWindow);
  const second = normalizeUsageWindow(rateLimit.secondary_window || rateLimit.secondaryWindow);
  const windows = [first, second].filter(Boolean);

  // Wham does not promise that a weekly window is secondary. In current
  // ChatGPT responses it can be the only primary_window, so classify windows
  // by their server-provided duration instead of their JSON property name.
  let weekly = windows.find((windowData) => isWeeklyWindow(windowData.durationSeconds)) || null;
  if (!weekly && second && !Number.isFinite(second.durationSeconds)) weekly = second;
  const primary = windows.find((windowData) => windowData !== weekly) || null;

  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    planType: normalizeText(payload.plan_type || payload.planType, 80),
    allowed: rateLimit.allowed !== false,
    limitReached: rateLimit.limit_reached === true || rateLimit.limitReached === true,
    primary,
    weekly
  };
}

function isWeeklyWindow(durationSeconds) {
  const duration = Number(durationSeconds);
  return Number.isFinite(duration) && Math.abs(duration - WEEK_SECONDS) <= WEEK_SECONDS * 0.05;
}

function normalizeUsageWindow(windowData) {
  if (!windowData || typeof windowData !== "object") return null;
  const usedPercent = Number(windowData.used_percent ?? windowData.usedPercent);
  const durationSeconds = Number(windowData.limit_window_seconds ?? windowData.limitWindowSeconds);
  const resetAtRaw = windowData.reset_at ?? windowData.resetAt;
  const resetAfterSeconds = Number(windowData.reset_after_seconds ?? windowData.resetAfterSeconds);
  let resetAt = Number(resetAtRaw);
  if (Number.isFinite(resetAt) && resetAt < 10_000_000_000) resetAt *= 1000;
  if (!Number.isFinite(resetAt) && Number.isFinite(resetAfterSeconds)) resetAt = Date.now() + resetAfterSeconds * 1000;
  return {
    usedPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(999, usedPercent)) : null,
    remainingPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, 100 - usedPercent)) : null,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    resetAt: Number.isFinite(resetAt) ? new Date(resetAt).toISOString() : null
  };
}

function usageErrorMessage(error) {
  if (error?.status === 401 || error?.status === 403) return t("usageDenied");
  if (error?.status === 404) return t("usageNotAvailable");
  return normalizeText(error?.message, 180) || t("usageCheckFailed");
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function captureCurrentSnapshot(tab, profileHint) {
  const cookies = await getChatGptCookies(tab.cookieStoreId);
  const identity = await identifyCookies(cookies, profileHint);
  return { ...identity, cookies };
}

async function identifyCookies(cookies, profileHint = {}) {
  const clientInfo = parseClientAuthCookie(cookies);
  const email = normalizeEmail(clientInfo?.user?.email || profileHint?.email);
  const name = normalizeText(
    clientInfo?.user?.name || findCookieValue(cookies, "oai-gn") || profileHint?.name || email?.split("@")[0],
    80
  ) || t("defaultAccount");
  const authCookies = cookies.filter((cookie) => AUTH_COOKIE_RE.test(cookie.name) && isUsableCookie(cookie));
  const profileId = findProfileId(cookies);
  const loggedIn = Boolean(email || profileId || authCookies.length);
  const avatarColor = normalizeAvatarColor(profileHint?.avatarColor);
  const avatarUrl = normalizeAvatarUrl(clientInfo?.user?.picture || profileHint?.avatarUrl);

  let identityKey = null;
  if (email) identityKey = `email:${email}`;
  else if (profileId) identityKey = `user:${profileId}`;
  else if (authCookies.length) identityKey = `auth:${await digestCookies(authCookies)}`;

  return { loggedIn, identityKey, name, email, avatarColor, avatarUrl };
}

function parseClientAuthCookie(cookies) {
  const raw = findCookieValue(cookies, "oai-client-auth-info");
  if (!raw) return null;
  const attempts = [raw];
  try { attempts.push(decodeURIComponent(raw)); } catch { /* ignore */ }
  try { attempts.push(decodeURIComponent(attempts.at(-1))); } catch { /* ignore */ }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next decoding level.
    }
  }
  return null;
}

function findProfileId(cookies) {
  for (const cookie of cookies) {
    const match = /^(?:history_off|conv_key)_([0-9a-f-]{20,})$/i.exec(cookie.name);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

async function digestCookies(cookies) {
  const source = cookies
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}\u0000${cookie.value}`)
    .join("\u0001");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function getChatGptCookies(storeId) {
  const query = { domain: "chatgpt.com", firstPartyDomain: null };
  if (storeId) query.storeId = storeId;
  const cookies = await browser.cookies.getAll(query);
  return sanitizeCookieList(cookies);
}

async function clearChatGptCookies(storeId) {
  const query = { domain: "chatgpt.com", firstPartyDomain: null };
  if (storeId) query.storeId = storeId;
  const cookies = await browser.cookies.getAll(query);

  for (const cookie of cookies) {
    const details = {
      url: cookieUrl(cookie),
      name: cookie.name
    };
    if (storeId) details.storeId = storeId;
    if (typeof cookie.firstPartyDomain === "string") details.firstPartyDomain = cookie.firstPartyDomain;
    if (cookie.partitionKey?.topLevelSite) details.partitionKey = { topLevelSite: cookie.partitionKey.topLevelSite };
    try {
      await browser.cookies.remove(details);
    } catch (error) {
      console.warn("Could not remove cookie", cookie.name, error);
    }
  }
}

async function applyCookies(cookies, storeId) {
  let applied = 0;
  const failures = [];

  for (const cookie of cookies) {
    const details = {
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: normalizePath(cookie.path),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly)
    };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (storeId) details.storeId = storeId;
    if (!cookie.session && Number.isFinite(cookie.expirationDate)) details.expirationDate = cookie.expirationDate;
    if (["no_restriction", "lax", "strict", "unspecified"].includes(cookie.sameSite)) {
      details.sameSite = cookie.sameSite;
    }
    if (typeof cookie.firstPartyDomain === "string") details.firstPartyDomain = cookie.firstPartyDomain;
    if (cookie.partitionKey?.topLevelSite) details.partitionKey = { topLevelSite: cookie.partitionKey.topLevelSite };

    try {
      const result = await browser.cookies.set(details);
      if (result) applied += 1;
      else failures.push({ cookie, error: "Firefox returned no cookie" });
    } catch (error) {
      failures.push({ cookie, error: error?.message || String(error) });
    }
  }

  return { applied, failures };
}

function sanitizeCookieList(rawCookies) {
  if (!Array.isArray(rawCookies)) throw new Error(t("expectedCookieArray"));
  if (rawCookies.length > MAX_COOKIES_PER_ACCOUNT) {
    throw new Error(t("maxCookies", String(MAX_COOKIES_PER_ACCOUNT)));
  }

  const result = [];
  const seen = new Set();
  for (const raw of rawCookies) {
    if (!raw || typeof raw !== "object") continue;
    const name = normalizeText(raw.name, 256);
    const value = typeof raw.value === "string" ? raw.value : "";
    const domain = normalizeCookieDomain(raw.domain);
    if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || !domain || value.length > MAX_COOKIE_VALUE_LENGTH || /[\r\n]/.test(value) || !isAllowedDomain(domain)) continue;

    const cookie = {
      name,
      value,
      domain,
      hostOnly: raw.hostOnly === true || !String(raw.domain || "").startsWith("."),
      path: normalizePath(raw.path),
      secure: raw.secure !== false,
      httpOnly: raw.httpOnly === true,
      sameSite: normalizeSameSite(raw.sameSite),
      session: raw.session === true || !Number.isFinite(Number(raw.expirationDate))
    };
    if (!cookie.session) cookie.expirationDate = Number(raw.expirationDate);
    if (typeof raw.firstPartyDomain === "string") cookie.firstPartyDomain = raw.firstPartyDomain;
    if (raw.partitionKey?.topLevelSite && isHttpUrl(raw.partitionKey.topLevelSite)) {
      cookie.partitionKey = { topLevelSite: raw.partitionKey.topLevelSite };
    }

    const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}\u0000${cookie.firstPartyDomain || ""}\u0000${cookie.partitionKey?.topLevelSite || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cookie);
    }
  }
  return result;
}

function normalizeImportPayload(payload) {
  if (Array.isArray(payload)) return [{ cookies: payload }];
  if (!payload || typeof payload !== "object") throw new Error(t("invalidJson"));
  if (Array.isArray(payload.cookies)) return [payload];
  if (Array.isArray(payload.accounts)) return payload.accounts;
  throw new Error(t("importFormat"));
}

function accountMetadata(account, currentIdentityKey) {
  const authExpirations = account.cookies
    .filter((cookie) => AUTH_COOKIE_RE.test(cookie.name) && Number.isFinite(cookie.expirationDate))
    .map((cookie) => cookie.expirationDate);
  const expiresAt = authExpirations.length ? Math.max(...authExpirations) * 1000 : null;
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    avatarColor: normalizeAvatarColor(account.avatarColor),
    avatarUrl: accountAvatarUrl(account),
    cookieCount: account.cookies.length,
    lastUsedAt: account.lastUsedAt,
    expiresAt,
    expired: Boolean(expiresAt && expiresAt <= Date.now()),
    isCurrent: account.identityKey === currentIdentityKey,
    usage: sanitizeUsageMetadata(account.usage)
  };
}

function sanitizeUsageMetadata(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    schemaVersion: usage.schemaVersion || 1,
    checkedAt: usage.checkedAt || null,
    planType: usage.planType || "",
    allowed: usage.allowed !== false,
    limitReached: usage.limitReached === true,
    primary: usage.primary || null,
    weekly: usage.weekly || null,
    error: usage.error || ""
  };
}

async function getAccounts() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

async function setAccounts(accounts) {
  await browser.storage.local.set({ [STORAGE_KEY]: accounts });
}

function sortAccounts(accounts) {
  return accounts.slice().sort((a, b) => {
    const left = Date.parse(a.lastUsedAt || a.updatedAt || a.createdAt || 0) || 0;
    const right = Date.parse(b.lastUsedAt || b.updatedAt || b.createdAt || 0) || 0;
    return right - left;
  });
}

async function resolveChatGptTab(sender, requestedTabId) {
  if (sender?.tab?.id && isChatGptUrl(sender.tab.url)) return sender.tab;
  if (Number.isInteger(requestedTabId)) {
    const requestedTab = await browser.tabs.get(requestedTabId);
    if (requestedTab?.id && isChatGptUrl(requestedTab.url)) return requestedTab;
  }
  {
    throw new Error(t("chatgptOnly"));
  }
}

function isChatGptUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

function isAllowedDomain(domain) {
  const hostname = domain.replace(/^\./, "").toLowerCase();
  return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
}

function normalizeCookieDomain(domain) {
  if (typeof domain !== "string") return "";
  const trimmed = domain.trim().toLowerCase();
  const hostname = trimmed.replace(/^\./, "");
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) return "";
  return trimmed.startsWith(".") ? `.${hostname}` : hostname;
}

function normalizePath(path) {
  return typeof path === "string" && path.startsWith("/") ? path : "/";
}

function normalizeSameSite(value) {
  if (value === null || value === undefined) return "unspecified";
  const normalized = String(value).toLowerCase().replace(/-/g, "_");
  if (normalized === "none" || normalized === "no_restriction") return "no_restriction";
  if (["lax", "strict", "unspecified"].includes(normalized)) return normalized;
  return "unspecified";
}

function normalizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function normalizeEmail(value) {
  const email = normalizeText(value, 254).toLowerCase();
  return email.includes("@") ? email : "";
}

function normalizeAvatarColor(value) {
  const color = normalizeText(value, 64);
  if (!color) return "";
  if (/^#[0-9a-f]{3,8}$/i.test(color)) {
    const digits = color.slice(1);
    const expanded = digits.length <= 4
      ? digits.split("").map((digit) => digit + digit).join("")
      : digits;
    const channels = [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16));
    const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
    return alpha > .1 && usefulAvatarChannels(channels) ? color.toLowerCase() : "";
  }

  const match = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i);
  if (!match) return "";
  const channels = match.slice(1, 4).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) return "";
  const alpha = match[4] === undefined ? null : Number(match[4]);
  if (alpha !== null && (alpha <= .1 || alpha > 1)) return "";
  if (!usefulAvatarChannels(channels)) return "";
  return alpha === null
    ? `rgb(${channels.join(", ")})`
    : `rgba(${channels.join(", ")}, ${alpha})`;
}

function normalizeAvatarUrl(value) {
  const source = normalizeText(value, 2048);
  if (!source) return "";
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.hostname !== "cdn.auth0.com" || url.port || url.username || url.password) return "";
    if (url.search || url.hash || !/^\/avatars\/[a-z0-9_-]{1,80}\.(?:png|jpe?g|webp)$/i.test(url.pathname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function accountAvatarUrl(account) {
  if (!account || typeof account !== "object") return "";
  return normalizeAvatarUrl(account.avatarUrl)
    || normalizeAvatarUrl(parseClientAuthCookie(Array.isArray(account.cookies) ? account.cookies : [])?.user?.picture);
}

function usefulAvatarChannels(channels) {
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  const spread = maximum - minimum;
  if (spread <= 18) return false;
  if (maximum <= 38 || minimum >= 245) return false;
  return true;
}

function findCookieValue(cookies, name) {
  return cookies.find((cookie) => cookie.name === name)?.value || "";
}

function isUsableCookie(cookie) {
  return cookie.session || !Number.isFinite(cookie.expirationDate) || cookie.expirationDate > Date.now() / 1000;
}

function cookieUrl(cookie) {
  const hostname = cookie.domain.replace(/^\./, "");
  return `https://${hostname}${normalizePath(cookie.path)}`;
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function t(key, substitutions) {
  return browser.i18n.getMessage(key, substitutions) || key;
}

function createId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
