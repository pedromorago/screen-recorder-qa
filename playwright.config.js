"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./playwright",
  // Single worker: every test shares the static server's port and each
  // test launches its own persistent context.
  workers: 1,
  // Deliberately no retries, in CI included: a test that only passes on
  // the second run is a flaky to fix, not to hide. This suite already
  // caught one real race that retries would have buried.
  retries: 0,
  timeout: 30_000,
  reporter: "list",
});
