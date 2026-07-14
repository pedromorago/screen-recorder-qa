"use strict";

// E2E del wrapper de consola (console-capture-main.js) en un Chrome real:
// se inyecta el script tal cual lo inyectaría la extensión (world MAIN) y
// se verifica lo que publica con postMessage.

describe("console-capture-main.js (world MAIN)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.startEntryCollector();
    cy.injectExtensionScript("console-capture-main.js");
  });

  it("captura console.log/warn/error con su nivel y argumentos", () => {
    cy.window().then((win) => {
      win.console.log("hola", 123);
      win.console.warn("ojo");
      win.console.error("mal");
    });
    cy.waitForEntry((e) => e.kind === "console" && e.level === "log" && e.text === "hola 123");
    cy.waitForEntry((e) => e.kind === "console" && e.level === "warn" && e.text === "ojo");
    cy.waitForEntry((e) => e.kind === "console" && e.level === "error" && e.text === "mal");
  });

  it("captura excepciones no controladas con su stack", () => {
    cy.window().then((win) =>
      win.eval("setTimeout(() => { throw new Error('boom E2E'); }, 0)")
    );
    cy.waitForEntry((e) => e.kind === "exception" && e.text.includes("boom E2E"));
  });

  it("captura promesas rechazadas sin catch", () => {
    cy.window().then((win) => {
      // OJO: sin return. Si el callback devuelve la promesa rechazada,
      // Cypress la espera y hace fallar el test antes de que el wrapper
      // registre el unhandledrejection (que es justo lo que se prueba).
      win.eval("Promise.reject(new Error('nope E2E'))");
    });
    cy.waitForEntry((e) => e.kind === "rejection" && e.text.includes("nope E2E"));
  });

  it("captura recursos que no cargan (404 de imagen)", () => {
    cy.window().then((win) => {
      const img = win.document.createElement("img");
      img.src = "/no-existe.png";
      win.document.body.appendChild(img);
    });
    cy.waitForEntry(
      (e) => e.kind === "resource" && e.text.includes("<img>") && e.text.includes("/no-existe.png")
    );
  });

  it("serializa objetos con referencias circulares sin lanzar", () => {
    cy.window().then((win) => win.eval("const o = { a: 1 }; o.yo = o; console.log(o);"));
    cy.waitForEntry(
      (e) => e.kind === "console" && e.text.includes('"a":1') && e.text.includes("[circular]")
    );
  });

  it("recorta mensajes gigantes a un tamaño acotado", () => {
    cy.window().then((win) => win.eval("console.log('x'.repeat(5000))"));
    cy.waitForEntry(
      (e) => e.kind === "console" && e.text.includes("[recortado]") && e.text.length < 2100
    );
  });

  it("la doble inyección no duplica entradas (guarda de instalación)", () => {
    cy.injectExtensionScript("console-capture-main.js"); // segunda inyección
    cy.window().then((win) => win.console.info("solo una vez"));
    cy.waitForEntry((e) => e.text === "solo una vez");
    cy.window().should((win) => {
      expect(win.__entries.filter((e) => e.text === "solo una vez")).to.have.length(1);
    });
  });
});
