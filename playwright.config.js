"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./playwright",
  // Single worker: every test shares the static server's port and each
  // test launches its own persistent context.
  workers: 1,
  timeout: 30_000,
  reporter: "list",
});
