"use strict";

// Playwright fixtures to test the REAL EXTENSION loaded in Chromium:
// a persistent context with --load-extension, the MV3 service worker
// and its ID. Complements the Cypress suite, which covers the capture
// engine but cannot touch chrome-extension:// (see README).

const { test: base, chromium, expect } = require("@playwright/test");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { startServer, PORT } = require("../cypress/support/static-server");

const EXTENSION_DIR = path.join(__dirname, "..");
const BASE = `http://localhost:${PORT}`;

const test = base.extend({
  context: async ({}, use) => {
    await startServer(PORT);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-recorder-"));
    const launchOptions = {
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    };
    if (process.env.CHROMIUM_PATH) {
      // Sandboxes/environments with a specific binary.
      launchOptions.executablePath = process.env.CHROMIUM_PATH;
    } else {
      // CRITICAL for CI: in headless mode, Playwright defaults to the
      // "chromium headless shell", which does NOT load extensions (every
      // test dies waiting for a service worker that never arrives). The
      // "chromium" channel forces full Chromium with the new headless.
      launchOptions.channel = "chromium";
    }
    const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  // The extension's service worker (background.js). MV3: it can take a
  // moment to register after the context opens.
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await use(sw);
  },

  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

module.exports = { test, expect, BASE };
