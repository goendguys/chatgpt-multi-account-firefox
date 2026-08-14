import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, "web-ext-artifacts");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const archive = resolve(artifacts, `chatgpt-multi-account-firefox-${packageJson.version}.zip`);
const runtimeFiles = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "popup.css",
  "icons/icon.svg",
  "_locales/en/messages.json",
  "_locales/ru/messages.json"
];

await mkdir(artifacts, { recursive: true });
await rm(archive, { force: true });

const process = Bun.spawn(["zip", "-q", "-9", archive, ...runtimeFiles], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit"
});
const exitCode = await process.exited;
if (exitCode !== 0) throw new Error(`zip exited with code ${exitCode}`);

console.log(`Release archive: ${archive}`);
