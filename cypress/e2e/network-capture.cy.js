"use strict";

// E2E del wrapper de red (network-capture-main.js): fetch y XHR reales
// contra el servidor de pruebas local, verificando lo publicado.

describe("network-capture-main.js (world MAIN)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.startEntryCollector();
    cy.injectExtensionScript("network-capture-main.js");
  });

  it("registra un fetch 200 con URL absoluta, duración y headers de respuesta", () => {
    cy.window().then((win) => win.eval("fetch('/api/ok?a=1&b=2')"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.status === 200).then((entry) => {
      expect(entry.level).to.equal("info");
      expect(entry.net.initiator).to.equal("fetch");
      expect(entry.net.method).to.equal("GET");
      // La URL relativa queda resuelta a absoluta (necesario para el HAR).
      expect(entry.net.url).to.equal(`${Cypress.config("baseUrl")}/api/ok?a=1&b=2`);
      expect(entry.net.durationMs).to.be.a("number").and.to.be.gte(0);
      const names = entry.net.responseHeaders.map((h) => h.name.toLowerCase());
      expect(names).to.include("x-test-header");
      expect(entry.net.contentType).to.include("application/json");
    });
  });

  it("marca un 500 como error y lo refleja en el texto de la entrada", () => {
    cy.window().then((win) => win.eval("fetch('/api/error')"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.status === 500).then((entry) => {
      expect(entry.level).to.equal("error");
      expect(entry.text).to.include("→ 500");
    });
  });

  it("registra el fallo de red (servidor inalcanzable) con status 0 y error", () => {
    cy.window().then((win) => win.eval("fetch('http://localhost:1/x').catch(() => {})"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.error).then((entry) => {
      expect(entry.level).to.equal("error");
      expect(entry.net.status).to.equal(0);
      expect(entry.text).to.include("FALLO");
    });
  });

  it("registra XHR con método, headers de petición y de respuesta", () => {
    cy.window().then((win) =>
      win.eval(`
        const x = new XMLHttpRequest();
        x.open("POST", "/api/ok");
        x.setRequestHeader("X-Peticion", "qa");
        x.send("cuerpo");
      `)
    );
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.initiator === "xhr").then((entry) => {
      expect(entry.net.method).to.equal("POST");
      expect(entry.net.status).to.equal(200);
      expect(entry.net.url).to.equal(`${Cypress.config("baseUrl")}/api/ok`);
      expect(entry.net.requestHeaders).to.deep.include({ name: "X-Peticion", value: "qa" });
      const names = entry.net.responseHeaders.map((h) => h.name.toLowerCase());
      expect(names).to.include("x-test-header");
    });
  });

  it("XHR contra servidor caído queda como status 0 con motivo", () => {
    cy.window().then((win) =>
      win.eval(`
        const x = new XMLHttpRequest();
        x.open("GET", "http://localhost:1/x");
        x.send();
      `)
    );
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.initiator === "xhr").then((entry) => {
      expect(entry.net.status).to.equal(0);
      expect(entry.net.error).to.include("sin respuesta");
    });
  });

  it("la doble inyección no duplica peticiones (guarda de instalación)", () => {
    cy.injectExtensionScript("network-capture-main.js"); // segunda inyección
    cy.window().then((win) => win.eval("fetch('/api/ok?unica=1')"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.url.includes("unica=1"));
    cy.window().should((win) => {
      const repetidas = win.__entries.filter(
        (e) => e.kind === "net" && e.net && e.net.url.includes("unica=1")
      );
      expect(repetidas).to.have.length(1);
    });
  });
});
