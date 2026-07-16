"use strict";

// Flat ESLint config for a no-build MV3 extension: plain scripts that
// share top-level globals across files loaded in the same context
// (capture-common.js before offscreen.js/recorder.js, issue-reporter.js
// before background.js/options.js). Those cross-file symbols are declared
// here instead of import/export, which this project deliberately avoids.

const js = require("@eslint/js");
const globals = require("globals");

// Defined in capture-common.js, consumed by offscreen.js and recorder.js.
const captureCommonGlobals = {
  QUALITY: "readonly",
  pad: "readonly",
  stamp: "readonly",
  pickMime: "readonly",
  humanError: "readonly",
  buildAudioGraph: "readonly",
  formatElapsed: "readonly",
};

// Defined in issue-reporter.js, consumed by background.js and options.js.
const issueReporterGlobals = {
  createIssueFromReport: "readonly",
  testIssueConnection: "readonly",
  buildJiraCreate: "readonly",
  jiraCreateIssue: "readonly",
  linearCreateIssue: "readonly",
};

module.exports = [
  { ignores: ["node_modules/**", "cypress/screenshots/**", "test-results/**"] },
  js.configs.recommended,
  {
    rules: {
      // Listener signatures stay documentary ((msg, sender, sendResponse))
      // and empty catches carry an explanatory comment instead of a body.
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    // Extension pages and injected scripts: browser + chrome.*.
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...captureCommonGlobals,
        ...issueReporterGlobals,
        importScripts: "readonly",
        navigation: "readonly",
      },
    },
  },
  {
    // The files that DEFINE the shared globals must not see them as
    // pre-declared, or every definition reads as a redeclaration.
    files: ["capture-common.js"],
    languageOptions: {
      globals: Object.fromEntries(Object.keys(captureCommonGlobals).map((k) => [k, "off"])),
    },
  },
  {
    files: ["issue-reporter.js"],
    languageOptions: {
      globals: Object.fromEntries(Object.keys(issueReporterGlobals).map((k) => [k, "off"])),
    },
  },
  {
    // Node-side files: configs and the tests' static server.
    files: ["eslint.config.js", "cypress.config.js", "playwright.config.js", "cypress/support/static-server.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    // Playwright specs run in Node, but their evaluate() callbacks run in
    // the browser/service worker and reference extension globals.
    files: ["playwright/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.webextensions,
        injectQaCapture: "readonly",
        handleDownloadChanged: "readonly",
        reportIssueIfConfigured: "readonly",
        startTabRecording: "readonly",
      },
    },
    rules: {
      // Playwright's documented worker-fixture signature is ({}, use).
      "no-empty-pattern": "off",
    },
  },
  {
    // Cypress specs and support run in the browser with Cypress globals.
    files: ["cypress/e2e/**/*.js", "cypress/support/e2e.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        cy: "readonly",
        Cypress: "readonly",
        describe: "readonly",
        it: "readonly",
        beforeEach: "readonly",
        expect: "readonly",
      },
    },
  },
];
