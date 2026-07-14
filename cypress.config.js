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
      // In Chrome/Chromium the real extension is loaded too: the tests do
      // not depend on it (they inject the scripts by hand, see README), but
      // the environment resembles production this way. Electron ignores it.
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
