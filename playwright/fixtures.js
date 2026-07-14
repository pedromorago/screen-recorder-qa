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
    const launchOptions = {
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    };
    if (process.env.CHROMIUM_PATH) {
      // Sandbox/entornos con un binario concreto.
      launchOptions.executablePath = process.env.CHROMIUM_PATH;
    } else {
      // CRÍTICO para CI: en headless, Playwright usa por defecto el
      // "chromium headless shell", que NO carga extensiones (los 7 tests
      // mueren esperando un service worker que nunca llega). El canal
      // "chromium" fuerza el Chromium completo con el headless nuevo.
      launchOptions.channel = "chromium";
    }
    const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
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
