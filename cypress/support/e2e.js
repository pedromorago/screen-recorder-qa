"use strict";

// Tests deliberately provoke uncaught errors (throw, rejected promises,
// 404 resources): they are exactly what the extension is verified to
// capture. They must not fail the test.
Cypress.on("uncaught:exception", () => false);

// Injects a REAL extension script (a file from the repo root) into the
// test page, equivalent to what chrome.scripting.executeScript does in
// production. A classic <script> and not win.eval: eval from the runner
// does NOT create globals from top-level declarations (issue-reporter.js
// needs them).
Cypress.Commands.add("injectExtensionScript", (file) => {
  cy.readFile(file, "utf8").then((code) => {
    cy.window().then((win) => {
      const s = win.document.createElement("script");
      s.textContent = code;
      win.document.head.appendChild(s);
      s.remove();
    });
  });
});

// Collector for the entries the MAIN-world scripts publish via postMessage.
Cypress.Commands.add("startEntryCollector", () => {
  cy.window().then((win) => {
    win.__entries = [];
    win.addEventListener("message", (e) => {
      const entry = e.data && e.data.__qaRecorderConsole;
      if (entry) win.__entries.push(entry);
    });
  });
});

// Waits (with Cypress retries) for an entry matching the predicate, and
// yields it for further assertions.
Cypress.Commands.add("waitForEntry", (pred, label) => {
  cy.window().should((win) => {
    expect(win.__entries.some(pred), label || "expected entry").to.be.true;
  });
  return cy.window().then((win) => win.__entries.find(pred));
});
