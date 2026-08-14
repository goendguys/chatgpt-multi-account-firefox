import { strict as assert } from "node:assert";

const storageData = {};
let messageListener = null;
let cookieJar = accountCookies("one@example.test", "Первый", "11111111-1111-4111-8111-111111111111", "token-one");
const webRequestListeners = {};

globalThis.browser = {
  i18n: {
    getMessage(key, substitutions) {
      const values = Array.isArray(substitutions) ? substitutions : [substitutions].filter(Boolean);
      return `${key}${values.length ? `:${values.join(",")}` : ""}`;
    },
    getUILanguage() { return "en"; }
  },
  runtime: {
    onInstalled: event(),
    onStartup: event(),
    onMessage: {
      addListener(listener) { messageListener = listener; }
    }
  },
  action: {
    onClicked: event()
  },
  alarms: {
    onAlarm: event(),
    async create() {}
  },
  tabs: {
    async sendMessage() {},
    async create() {},
    async query() { return []; },
    async get(tabId) {
      return { id: tabId, url: "https://chatgpt.com/", cookieStoreId: "firefox-default" };
    }
  },
  storage: {
    local: {
      async setAccessLevel() {},
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, structuredClone(values));
      }
    }
  },
  cookies: {
    async getAll(query) {
      return structuredClone(cookieJar.filter((cookie) => {
        const cookieDomain = cookie.domain.replace(/^\./, "");
        const queryDomain = String(query.domain || "").replace(/^\./, "");
        return !queryDomain || cookieDomain === queryDomain || cookieDomain.endsWith(`.${queryDomain}`);
      }));
    },
    async remove(details) {
      const index = cookieJar.findIndex((cookie) => cookie.name === details.name);
      if (index < 0) return null;
      const [removed] = cookieJar.splice(index, 1);
      return { url: details.url, name: removed.name };
    },
    async set(details) {
      const hostname = new URL(details.url).hostname;
      const domain = details.domain || hostname;
      const cookie = {
        name: details.name,
        value: details.value,
        domain,
        hostOnly: !details.domain,
        path: details.path || "/",
        secure: Boolean(details.secure),
        httpOnly: Boolean(details.httpOnly),
        sameSite: details.sameSite || "unspecified",
        session: !Number.isFinite(details.expirationDate),
        firstPartyDomain: details.firstPartyDomain || ""
      };
      if (!cookie.session) cookie.expirationDate = details.expirationDate;
      cookieJar = cookieJar.filter((item) => !(
        item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path
      ));
      cookieJar.push(cookie);
      return structuredClone(cookie);
    }
  },
  scripting: {
    async executeScript() {}
  },
  webRequest: {
    onBeforeSendHeaders: requestEvent("beforeSend"),
    onHeadersReceived: requestEvent("headersReceived"),
    onCompleted: requestEvent("completed"),
    onErrorOccurred: requestEvent("error")
  }
};

globalThis.fetch = async (url, options = {}) => {
  const requestId = `request-${Math.random()}`;
  const requestHeaders = Object.entries(options.headers || {}).map(([name, value]) => ({ name, value }));
  const rewritten = webRequestListeners.beforeSend({ requestId, url: String(url), requestHeaders });
  assert.ok(rewritten?.requestHeaders, "saved-account request was not isolated");
  const cookieHeader = rewritten.requestHeaders.find((header) => header.name.toLowerCase() === "cookie")?.value || "";
  const usedPercent = cookieHeader.includes("token-one") ? 25 : 75;
  const isSession = new URL(url).pathname === "/api/auth/session";
  const authorization = rewritten.requestHeaders.find((header) => header.name.toLowerCase() === "authorization")?.value || "";
  const accountId = rewritten.requestHeaders.find((header) => header.name.toLowerCase() === "chatgpt-account-id")?.value || "";
  assert.equal(rewritten.requestHeaders.some((header) => header.name.toLowerCase() === "x-chatgpt-multi-account-usage"), false);
  if (!isSession) {
    assert.match(authorization, /^Bearer test-access-token-/);
    assert.match(accountId, /^[12]{8}-/);
  }
  const isolated = webRequestListeners.headersReceived({
    requestId,
    responseHeaders: [{ name: "Set-Cookie", value: "must-not-leak=1" }, { name: "Content-Type", value: "application/json" }]
  });
  assert.equal(isolated.responseHeaders.some((header) => header.name.toLowerCase() === "set-cookie"), false);
  webRequestListeners.completed({ requestId });

  if (isSession) {
    return new Response(JSON.stringify({
      accessToken: `test-access-token-${usedPercent}-${"x".repeat(60)}`,
      account: {
        id: usedPercent === 25
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222"
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const rateLimit = usedPercent === 25
    ? {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 604_800,
          reset_after_seconds: 86_400
        },
        secondary_window: null
      }
    : {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: usedPercent - 10,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600
        },
        secondary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 604_800,
          reset_after_seconds: 86_400
        }
      };
  return new Response(JSON.stringify({
    plan_type: "plus",
    rate_limit: rateLimit
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

await import("../background.js");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(typeof messageListener, "function", "background message listener was not registered");

const sender = {
  tab: {
    id: 1,
    url: "https://chatgpt.com/",
    cookieStoreId: "firefox-default"
  }
};

let state = await request("GET_ACCOUNT_STATE");
assert.equal(state.current.email, "one@example.test");
assert.equal(state.accounts.length, 0);

const popupState = await requestFromPopup("GET_ACCOUNT_STATE", { tabId: 1 });
assert.equal(popupState.current.email, "one@example.test");

await request("SAVE_CURRENT_ACCOUNT", { profileHint: { avatarColor: "rgb(194, 55, 66)" } });
state = await request("GET_ACCOUNT_STATE");
assert.equal(state.accounts.length, 1);
assert.equal(state.current.savedAccountId, state.accounts[0].id);
assert.equal(state.accounts[0].avatarColor, "rgb(194, 55, 66)");
assert.equal(state.accounts[0].avatarUrl, "https://cdn.auth0.com/avatars/kd.png");
const firstAccountId = state.accounts[0].id;

cookieJar = accountCookies("two@example.test", "Второй", "22222222-2222-4222-8222-222222222222", "token-two");
await request("SAVE_CURRENT_ACCOUNT", { profileHint: { avatarColor: "#6847c7" } });
state = await request("GET_ACCOUNT_STATE");
assert.equal(state.accounts.length, 2);
assert.equal(state.accounts.some((account) => account.avatarColor === "#6847c7"), true);
assert.equal(state.accounts.some((account) => account.avatarUrl.endsWith("/rw.png")), true);

storageData["chatgptMultiAccount.accounts.v1"]
  .find((account) => account.identityKey === "email:two@example.test")
  .avatarColor = "rgb(0, 0, 0)";
state = await request("GET_ACCOUNT_STATE");
assert.equal(state.current.avatarColor, "");
assert.equal(state.accounts.find((account) => account.isCurrent).avatarColor, "");

state = await request("GET_ACCOUNT_STATE", { profileHint: { avatarColor: "rgb(104, 71, 210)" } });
assert.equal(state.current.avatarColor, "rgb(104, 71, 210)");
assert.equal(state.accounts.find((account) => account.isCurrent).avatarColor, "rgb(104, 71, 210)");

const usageRefresh = await request("REFRESH_ALL_USAGE", { force: true });
assert.equal(usageRefresh.succeeded, 2);
state = await request("GET_ACCOUNT_STATE");
assert.deepEqual(state.accounts.map((account) => account.usage.weekly.usedPercent).sort((a, b) => a - b), [25, 75]);
assert.equal(state.accounts.find((account) => account.usage.weekly.usedPercent === 25).usage.primary, null);
assert.equal(state.accounts.every((account) => account.usage.schemaVersion === 2), true);

const switched = await request("SWITCH_ACCOUNT", { accountId: firstAccountId });
assert.equal(switched.switched, true);
assert.equal(readClientEmail(cookieJar), "one@example.test");

const exported = await request("EXPORT_ACCOUNTS");
assert.equal(exported.payload.format, "ChatGPT Multi Account");
assert.equal(exported.payload.accounts.length, 2);
assert.deepEqual(
  exported.payload.accounts.map((account) => account.avatarColor).sort(),
  ["rgb(104, 71, 210)", "rgb(194, 55, 66)"]
);
assert.deepEqual(
  exported.payload.accounts.map((account) => account.avatarUrl).sort(),
  ["https://cdn.auth0.com/avatars/kd.png", "https://cdn.auth0.com/avatars/rw.png"]
);

const imported = await request("IMPORT_ACCOUNTS", { payload: exported.payload });
assert.equal(imported.imported, 0);
assert.equal(imported.updated, 2);

console.log("✓ save and duplicate detection");
console.log("✓ popup commands resolve the active ChatGPT tab");
console.log("✓ account switch and cookie replacement");
console.log("✓ multi-account JSON export/import");
console.log("✓ session-first per-account usage API requests are isolated");
console.log("✓ weekly window is detected by 7-day duration, including primary-only responses");
console.log("Integration checks passed.");

async function request(type, data = {}) {
  const response = await messageListener({ type, ...data }, sender);
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function requestFromPopup(type, data = {}) {
  const response = await messageListener({ type, ...data }, {});
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

function accountCookies(email, name, id, token) {
  const expires = Date.now() / 1000 + 86_400;
  return [
    cookie("__Secure-next-auth.session-token.0", token, expires, true),
    cookie("history_off_" + id, "1", expires, true),
    cookie("oai-gn", name, expires, false),
    cookie(
      "oai-client-auth-info",
      encodeURIComponent(JSON.stringify({
        user: {
          name,
          email,
          picture: `https://cdn.auth0.com/avatars/${email.startsWith("one") ? "kd" : "rw"}.png`
        }
      })),
      expires,
      false
    )
  ];
}

function cookie(name, value, expirationDate, httpOnly) {
  return {
    name,
    value,
    domain: name.startsWith("__Secure-") ? ".chatgpt.com" : "chatgpt.com",
    hostOnly: !name.startsWith("__Secure-"),
    path: "/",
    secure: true,
    httpOnly,
    sameSite: "lax",
    session: false,
    expirationDate,
    firstPartyDomain: ""
  };
}

function readClientEmail(cookies) {
  const value = cookies.find((item) => item.name === "oai-client-auth-info")?.value;
  return JSON.parse(decodeURIComponent(value)).user.email;
}

function event() {
  return { addListener() {} };
}

function requestEvent(name) {
  return {
    addListener(listener) {
      webRequestListeners[name] = listener;
    }
  };
}
