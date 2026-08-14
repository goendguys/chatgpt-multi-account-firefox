import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const messages = JSON.parse(readFileSync(resolve(root, "_locales/en/messages.json"), "utf8"));
const window = new Window({ url: "https://chatgpt.com/" });
const nativeAttachShadow = window.Element.prototype.attachShadow;

// Tests need to inspect the extension's otherwise-closed Shadow DOM.
window.Element.prototype.attachShadow = function attachInspectableShadow(options) {
  return nativeAttachShadow.call(this, { ...options, mode: "open" });
};

globalThis.window = window;
globalThis.self = window;
for (const name of [
  "document", "MutationObserver", "HTMLElement", "Element", "Node", "Event",
  "MouseEvent", "KeyboardEvent", "Blob", "URL", "CSS", "TextEncoder",
  "requestAnimationFrame", "cancelAnimationFrame"
]) {
  if (window[name]) globalThis[name] = window[name];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.matchMedia = window.matchMedia.bind(window);

const temporaryChat = document.createElement("button");
temporaryChat.setAttribute("aria-label", "Temporary chat");
temporaryChat.getBoundingClientRect = () => ({
  left: 600, right: 636, top: 8, bottom: 44, width: 36, height: 36
});
document.body.append(temporaryChat);

const profileButton = document.createElement("button");
profileButton.dataset.testid = "accounts-profile-button";
profileButton.setAttribute("aria-label", "Active Test, Plus");
profileButton.getBoundingClientRect = () => ({
  left: 700, right: 736, top: 8, bottom: 44, width: 36, height: 36
});
const siteAvatar = document.createElement("span");
siteAvatar.textContent = "AT";
siteAvatar.style.width = "32px";
siteAvatar.style.height = "32px";
siteAvatar.style.borderRadius = "50%";
siteAvatar.style.backgroundColor = "rgb(194, 55, 66)";
siteAvatar.getBoundingClientRect = () => ({
  left: 702, right: 734, top: 10, bottom: 42, width: 32, height: 32
});
profileButton.append(siteAvatar);
document.body.append(profileButton);

let runtimeListener = null;
const accountState = {
  current: {
    loggedIn: true,
    identityKey: "email:active@example.test",
    name: "Active Test",
    email: "active@example.test",
    avatarColor: "rgb(194, 55, 66)",
    avatarUrl: "https://cdn.auth0.com/avatars/at.png",
    savedAccountId: "account-1"
  },
  accounts: [
    account("account-1", "Active Test", 17, true),
    account("account-2", "Second Test", 64, false)
  ]
};

globalThis.browser = window.browser = {
  i18n: {
    getUILanguage: () => "en-US",
    getMessage: localizedMessage
  },
  runtime: {
    getURL: (path) => `moz-extension://test/${path}`,
    onMessage: {
      addListener(listener) { runtimeListener = listener; },
      removeListener(listener) { if (runtimeListener === listener) runtimeListener = null; }
    },
    async sendMessage(message) {
      if (message.type === "GET_ACCOUNT_STATE") return { ok: true, data: structuredClone(accountState) };
      if (message.type === "REFRESH_ALL_USAGE") return { ok: true, data: { succeeded: 2, failed: 0 } };
      return { ok: true, data: {} };
    }
  }
};

(0, eval)(readFileSync(resolve(root, "content.js"), "utf8"));
await tick(20);

const launcherHost = document.querySelector('[data-cgpt-multi-account="launcher"]');
assert(launcherHost, "launcher did not mount");
launcherHost.shadowRoot.querySelector("button").click();
await tick(40);

const panelHost = document.querySelector("[data-cgpt-account-panel]");
assert(panelHost && !panelHost.hidden, "panel did not open");
const panelText = panelHost.shadowRoot.textContent;
assert(panelText.includes("Active Test") && panelText.includes("Second Test"), "saved accounts were not rendered");
assert(panelText.includes("Available 83%") && panelText.includes("Used 17%"), "remaining capacity is not shown first");
assert(!panelText.includes("Week"), "weekly label must not be repeated on every account");
assert(!panelHost.shadowRoot.querySelector(".security-note"), "removed security note is still rendered");

const usageSummary = panelHost.shadowRoot.querySelector(".usage-summary");
assert(
  usageSummary?.children[0]?.classList.contains("usage-remaining")
    && usageSummary?.children[1]?.classList.contains("usage-used"),
  "available and used values must render as separate rows"
);

const headerButtons = [...panelHost.shadowRoot.querySelectorAll(".header-actions .icon-button")];
assert(
  headerButtons.length === 2
    && headerButtons.every((button) => !button.textContent.trim() && button.getAttribute("aria-label")),
  "refresh and close controls must be accessible icon-only buttons"
);

const currentAvatar = panelHost.shadowRoot.querySelector(".current-card .avatar");
const savedAvatar = panelHost.shadowRoot.querySelector(".account-item .avatar");
assert(currentAvatar && savedAvatar, "current and saved account avatars were not rendered");
assert(
  currentAvatar.style.getPropertyValue("--avatar-color") === "rgb(194, 55, 66)"
    && savedAvatar.style.getPropertyValue("--avatar-color"),
  "saved ChatGPT avatar colors were not applied"
);
assert(
  currentAvatar.querySelector('img[src="https://cdn.auth0.com/avatars/at.png"]')
    && savedAvatar.querySelector("img"),
  "avatar images from the profile cookie were not rendered"
);
const renderedAvatarImage = currentAvatar.querySelector("img");
assert(
  currentAvatar.style.getPropertyValue("overflow") === "hidden"
    && currentAvatar.style.getPropertyValue("width") === "38px"
    && renderedAvatarImage.width === 38
    && renderedAvatarImage.height === 38
    && renderedAvatarImage.style.getPropertyValue("position") === "absolute"
    && renderedAvatarImage.style.getPropertyValue("width") === "100%"
    && renderedAvatarImage.style.getPropertyValue("object-fit") === "cover",
  "avatar PNG must be hard-clipped to the circular frame"
);

const profileHint = await runtimeListener({ type: "GET_ACCOUNT_PROFILE_HINT" });
assert(
  profileHint?.name === "Active Test" && profileHint.avatarColor === "rgb(194, 55, 66)",
  "profile avatar color was not detected from the ChatGPT control"
);

const moreButton = panelHost.shadowRoot.querySelector(".more-button");
assert(!moreButton.textContent.trim() && moreButton.getAttribute("aria-label") === "Actions", "actions button must be icon-only");
moreButton.click();
await tick(10);
const updateButton = panelHost.shadowRoot.querySelector('[data-action="save-current"]');
const renameButton = panelHost.shadowRoot.querySelector('[data-action="rename-start"]');
const jsonButton = panelHost.shadowRoot.querySelector('[data-action="export-one"]');
assert(
  updateButton && renameButton
    && !updateButton.textContent.trim()
    && !renameButton.textContent.trim()
    && jsonButton?.textContent.includes("JSON"),
  "update and rename must be icon-only while JSON keeps its label"
);

const firstMeter = panelHost.shadowRoot.querySelector(".usage-meter-fill");
assert(firstMeter?.style.width === "83%", "meter must display remaining, not used, capacity");

document.documentElement.classList.add("dark");
await runtimeListener({ type: "PING_ACCOUNT_EXTENSION" });
await tick(10);
assert(panelHost.dataset.theme === "dark" && launcherHost.dataset.theme === "dark", "dark theme did not propagate");

panelHost.setAttribute("aria-hidden", "true");
panelHost.setAttribute("data-aria-hidden", "true");
const response = await runtimeListener({ type: "OPEN_ACCOUNT_PANEL" });
await tick(10);
assert(!panelHost.hasAttribute("aria-hidden") && !panelHost.hasAttribute("data-aria-hidden"), "site modal hiding was not removed");
assert(response?.opened, "popup-to-page open command was not acknowledged");

console.log("✓ launcher and account panel render");
console.log("✓ remaining capacity is prominent and drives the meter");
console.log("✓ compact labels, account colors, and icon-only controls render correctly");
console.log("✓ opaque light/dark theme state propagates to Shadow DOM hosts");
console.log("✓ ChatGPT modal aria-hiding protection remains active");
window.happyDOM.abort();

function account(id, name, usedPercent, isCurrent) {
  return {
    id,
    name,
    email: `${id}@example.test`,
    avatarColor: isCurrent ? "rgb(194, 55, 66)" : "rgb(78, 99, 210)",
    avatarUrl: `https://cdn.auth0.com/avatars/${isCurrent ? "at" : "st"}.png`,
    isCurrent,
    expired: false,
    usage: {
      schemaVersion: 2,
      checkedAt: new Date().toISOString(),
      weekly: {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        durationSeconds: 604_800,
        resetAt: null
      },
      primary: null
    }
  };
}

function localizedMessage(key, substitutions) {
  const definition = messages[key];
  if (!definition) return "";
  const values = (Array.isArray(substitutions) ? substitutions : [substitutions])
    .filter((value) => value !== undefined && value !== null)
    .map(String);
  let message = definition.message;
  for (const [name, placeholder] of Object.entries(definition.placeholders || {})) {
    const value = placeholder.content.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] || "");
    message = message.replaceAll(`$${name.toUpperCase()}$`, value);
  }
  return message;
}

function tick(milliseconds) {
  return new Promise((resolveTick) => setTimeout(resolveTick, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
