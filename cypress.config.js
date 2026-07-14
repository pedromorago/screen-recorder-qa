"use strict";

const { defineConfig } = require("cypress");
const path = require("path");
const { startServer, PORT } = require("./cypress/support/static-server");

module.exports = defineConfig({
  e2e: {
    baseUrl: `http://localhost:${PORT}`,
    supportFile: "cypress/support/e2e.js",
    video: false,
    setupNodeEvents(on, config) {
      // En Chrome/Chromium se carga además la extensión real: los tests no
      // dependen de ella (inyectan los scripts a mano, ver README), pero
      // así el entorno se parece al de producción. Electron la ignora.
      on("before:browser:launch", (browser, launchOptions) => {
        if (browser.family === "chromium" && browser.name !== "electron") {
          launchOptions.args.push(
            `--load-extension=${path.resolve(__dirname)}`,
            `--disable-extensions-except=${path.resolve(__dirname)}`
          );
        }
        return launchOptions;
      });
      return startServer(PORT).then(() => config);
    },
  },
});
