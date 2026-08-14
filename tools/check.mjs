import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const sources = {};
const englishMessages = JSON.parse(readFileSync(resolve(root, "_locales/en/messages.json"), "utf8"));
const russianMessages = JSON.parse(readFileSync(resolve(root, "_locales/ru/messages.json"), "utf8"));

assert(manifest.manifest_version === 3, "manifest_version must be 3");
assert(manifest.permissions.includes("cookies"), "cookies permission is required");
assert(manifest.permissions.includes("scripting"), "scripting permission is required for already-open tabs");
assert(manifest.permissions.includes("storage"), "storage permission is required");
assert(manifest.permissions.includes("alarms"), "alarms permission is required for automatic usage refresh");
assert(manifest.permissions.includes("webRequestBlocking"), "webRequestBlocking is required to isolate per-account usage requests");
assert(manifest.host_permissions.includes("https://chatgpt.com/*"), "root ChatGPT host permission is required");
assert(manifest.content_scripts?.[0]?.js?.includes("content.js"), "content.js must be registered");
assert(manifest.default_locale === "en", "default_locale must be en");
assert(manifest.version === packageJson.version, "manifest and package versions must match");

for (const file of ["background.js", "content.js", "popup.js"]) {
  const source = readFileSync(resolve(root, file), "utf8");
  sources[file] = source;
  const scanner = new Bun.Transpiler({ loader: "js" });
  scanner.scan(source);
  assert(!/\beval\s*\(/.test(source), `${file} must not use eval`);
  assert(!/\.innerHTML\s*=/.test(source), `${file} must not assign innerHTML`);
  console.log(`✓ ${file}: syntax and basic CSP checks`);
}

assert(sources["content.js"].includes(`CONTENT_VERSION = "${manifest.version}"`), "manifest and content versions must match");
assert(!sources["content.js"].includes("weekly?.usedPercent !== null"), "nullable weekly usage must not enter the renderer");
assert(sources["content.js"].includes("showPopover"), "panel top-layer protection is missing");
assert(sources["background.js"].includes("isWeeklyWindow"), "duration-based weekly classification is missing");

const popupHtml = readFileSync(resolve(root, "popup.html"), "utf8");
const requestedMessageKeys = new Set();
for (const source of [...Object.values(sources), popupHtml, JSON.stringify(manifest)]) {
  for (const match of source.matchAll(/\bt\(\s*["']([A-Za-z][A-Za-z0-9_]*)["']/g)) requestedMessageKeys.add(match[1]);
  for (const match of source.matchAll(/data-i18n=["']([A-Za-z][A-Za-z0-9_]*)["']/g)) requestedMessageKeys.add(match[1]);
  for (const match of source.matchAll(/__MSG_([A-Za-z][A-Za-z0-9_]*)__/g)) requestedMessageKeys.add(match[1]);
}
for (const key of requestedMessageKeys) {
  assert(englishMessages[key]?.message, `missing English locale key: ${key}`);
  assert(russianMessages[key]?.message, `missing Russian locale key: ${key}`);
}
assert(
  JSON.stringify(Object.keys(englishMessages).sort()) === JSON.stringify(Object.keys(russianMessages).sort()),
  "English and Russian locale keys must match"
);

const css = readFileSync(resolve(root, "content.css"), "utf8");
const popupCss = readFileSync(resolve(root, "popup.css"), "utf8");
assert(css.includes(":host([data-cgpt-account-panel])"), "panel styles are missing");
assert(css.includes("overflow-y: auto"), "scrollable account list is missing");
assert(!css.includes("light-dark(") && !popupCss.includes("light-dark("), "theme colors must use explicit high-contrast surfaces");
assert(css.includes("background: var(--cas-bg);"), "panel must use an opaque background");
assert(css.includes("--cas-warning: #955b00") && css.includes("--cas-critical: #b42318"), "accessible light-theme usage colors are missing");
assert(css.includes("--cas-avatar-current") && css.includes("--cas-avatar-saved"), "distinct current and saved avatar colors are missing");
assert(css.includes("var(--avatar-color, var(--cas-avatar-current))"), "saved ChatGPT avatar colors are not wired into the UI");
assert(sources["content.js"].includes("getImageData"), "image-based avatar color detection is missing");
assert(sources["background.js"].includes("cdn.auth0.com"), "profile-cookie avatar URL support is missing");
assert(css.includes(".usage-summary {\n  display: grid;"), "usage values must use a two-row layout");
assert(!sources["content.js"].includes('className: "security-note"'), "removed security note must not be rendered");

console.log("✓ manifest.json: required Firefox permissions and entry points");
console.log("✓ content.css: isolated panel and scrollable list");
console.log(`✓ locales: English and Russian (${requestedMessageKeys.size} referenced messages)`);
console.log("All checks passed.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
