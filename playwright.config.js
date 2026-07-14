"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./playwright",
  // Un solo worker: todos los tests comparten el puerto del servidor
  // estático y cada test levanta su propio contexto persistente.
  workers: 1,
  timeout: 30_000,
  reporter: "list",
});
