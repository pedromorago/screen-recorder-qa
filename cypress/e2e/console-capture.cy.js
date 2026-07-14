"use strict";

// E2E for the console wrapper (console-capture-main.js) in a real Chrome:
// the script is injected exactly as the extension would inject it
// (world MAIN) and what it publishes via postMessage is verified.

describe("console-capture-main.js (MAIN world)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.startEntryCollector();
    cy.injectExtensionScript("console-capture-main.js");
  });

  it("captures console.log/warn/error with level and arguments", () => {
    cy.window().then((win) => {
      win.console.log("hello", 123);
      win.console.warn("heads up");
      win.console.error("bad");
    });
    cy.waitForEntry((e) => e.kind === "console" && e.level === "log" && e.text === "hello 123");
    cy.waitForEntry((e) => e.kind === "console" && e.level === "warn" && e.text === "heads up");
    cy.waitForEntry((e) => e.kind === "console" && e.level === "error" && e.text === "bad");
  });

  it("captures uncaught exceptions with their stack", () => {
    cy.window().then((win) =>
      win.eval("setTimeout(() => { throw new Error('boom E2E'); }, 0)")
    );
    cy.waitForEntry((e) => e.kind === "exception" && e.text.includes("boom E2E"));
  });

  it("captures unhandled promise rejections", () => {
    cy.window().then((win) => {
      // CAREFUL: no return. If the callback returns the rejected promise,
      // Cypress awaits it and fails the test before the wrapper records
      // the unhandledrejection (which is exactly what is being tested).
      win.eval("Promise.reject(new Error('nope E2E'))");
    });
    cy.waitForEntry((e) => e.kind === "rejection" && e.text.includes("nope E2E"));
  });

  it("captures resources that fail to load (image 404)", () => {
    cy.window().then((win) => {
      const img = win.document.createElement("img");
      img.src = "/does-not-exist.png";
      win.document.body.appendChild(img);
    });
    cy.waitForEntry(
      (e) => e.kind === "resource" && e.text.includes("<img>") && e.text.includes("/does-not-exist.png")
    );
  });

  it("serializes objects with circular references without throwing", () => {
    cy.window().then((win) => win.eval("const o = { a: 1 }; o.me = o; console.log(o);"));
    cy.waitForEntry(
      (e) => e.kind === "console" && e.text.includes('"a":1') && e.text.includes("[circular]")
    );
  });

  it("serializes symbols and bigints without throwing", () => {
    cy.window().then((win) => win.eval("console.log(Symbol('mark'), 10n)"));
    cy.waitForEntry((e) => e.kind === "console" && e.text === "Symbol(mark) 10n");
  });

  it("truncates huge messages to a bounded size", () => {
    cy.window().then((win) => win.eval("console.log('x'.repeat(5000))"));
    cy.waitForEntry(
      (e) => e.kind === "console" && e.text.includes("[truncated]") && e.text.length < 2100
    );
  });

  it("double injection does not duplicate entries (install guard)", () => {
    cy.injectExtensionScript("console-capture-main.js"); // second injection
    cy.window().then((win) => win.console.info("only once"));
    cy.waitForEntry((e) => e.text === "only once");
    cy.window().should((win) => {
      expect(win.__entries.filter((e) => e.text === "only once")).to.have.length(1);
    });
  });
});
