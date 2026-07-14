"use strict";

// Fixtures de Playwright para probar la EXTENSIÓN REAL cargada en Chromium:
// contexto persistente con --load-extension, service worker MV3 y su ID.
// Complementa a la suite de Cypress, que cubre el motor de captura pero no
// puede tocar chrome-extension:// (ver README).

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
    const context = await chromium.launchPersistentContext(userDataDir, {
      // En CI/local: `npx playwright install chromium` y se usa el bundled.
      // CHROMIUM_PATH permite apuntar a otro binario (p. ej. sandboxes).
      executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  // Service worker de la extensión (background.js). MV3: puede tardar en
  // registrarse tras abrir el contexto.
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
