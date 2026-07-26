"use strict";

// The release artifact, tested as a user receives it: package the zip,
// unpack it into a temp dir and load THAT in Chromium. The rest of the
// suite loads the repo folder, which is not what anybody downloads — a
// missing file in the package would pass every other test and fail on
// the first person who clicks "Load unpacked".

const { test, expect, chromium } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;

/** Minimal ZIP reader: walks the central directory and inflates each entry. */
function unzip(buf, destDir) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;

    const out = path.join(destDir, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    names.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

let unpackedDir;
let entries;

test.beforeAll(() => {
  execFileSync("node", [path.join(ROOT, "scripts", "package-extension.js")], { cwd: ROOT });
  const zipPath = path.join(ROOT, "dist", `screen-recorder-qa-${MANIFEST_VERSION}.zip`);
  unpackedDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-recorder-pkg-"));
  entries = unzip(fs.readFileSync(zipPath), unpackedDir);
});

test.afterAll(() => {
  if (unpackedDir) fs.rmSync(unpackedDir, { recursive: true, force: true });
});

test("the package ships the runtime and nothing from the test harness", () => {
  expect(entries).toEqual(expect.arrayContaining(["manifest.json", "background.js", "popup.html", "icons/icon128.png"]));

  const leaked = entries.filter(
    (e) =>
      e.startsWith("node_modules/") ||
      e.startsWith("cypress/") ||
      e.startsWith("playwright/") ||
      e.startsWith("test-results/") ||
      /\.config\.js$/.test(e) ||
      /^package(-lock)?\.json$/.test(e) ||
      e === "CLAUDE.md"
  );
  expect(leaked, `development files leaked into the release zip: ${leaked.join(", ")}`).toEqual([]);
});

test("the packaged extension loads in Chromium and its service worker comes up", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-recorder-pkg-profile-"));
  const launchOptions = {
    headless: true,
    args: [`--disable-extensions-except=${unpackedDir}`, `--load-extension=${unpackedDir}`],
  };
  // Same reason as in fixtures.js: the headless shell does not load extensions.
  if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;
  else launchOptions.channel = "chromium";

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");

    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.manifest_version).toBe(3);

    // The popup is what opens on the first click after installing.
    const extensionId = new URL(sw.url()).host;
    const popup = await context.newPage();
    const errors = [];
    popup.on("pageerror", (e) => errors.push(e.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator("body")).toHaveAttribute("data-state", "idle");
    expect(errors, `the packaged popup threw: ${errors.join(" | ")}`).toEqual([]);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
