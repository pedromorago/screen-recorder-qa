"use strict";

// E2E del registro de pasos (steps-capture.js): clicks, cambios de campo
// y envíos de formulario, verificando ante todo la regla de privacidad:
// los VALORES tecleados nunca se registran.

describe("steps-capture.js (mundo aislado)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.startEntryCollector();
    cy.injectExtensionScript("steps-capture.js");
  });

  it("registra un click con el elemento interactivo y su texto", () => {
    cy.get("#btnDemo").click();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.text.includes("Click en <button#btnDemo") && e.text.includes("«Comprar ahora»")
    );
  });

  it("atribuye el click al elemento interactivo, no al span decorativo", () => {
    cy.get("#btnDemo span").click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("<button#btnDemo"));
  });

  it("registra el cambio de un campo SIN capturar el valor", () => {
    cy.get("input[name=email]").type("pedro@example.com").blur();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.text.includes("Cambio en <input[name=email]") && e.text.includes("valor no registrado")
    );
    cy.window().should((win) => {
      const filtrado = JSON.stringify(win.__entries);
      expect(filtrado).to.not.include("pedro@example.com");
    });
  });

  it("nunca registra el valor de un campo de contraseña", () => {
    cy.get("input[name=clave]").type("secreto123").blur();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("[name=clave]") && e.text.includes("tipo=password"));
    cy.window().should((win) => {
      expect(JSON.stringify(win.__entries)).to.not.include("secreto123");
    });
  });

  it("un click en texto plano no desborda la etiqueta del paso", () => {
    cy.get("p").first().click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("<p") && e.text.length < 150);
  });

  it("registra el envío de un formulario", () => {
    cy.get("#formDemo").then(($f) => $f.on("submit", (e) => e.preventDefault()));
    cy.get("#btnEnviar").click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("Envío del formulario <form#formDemo"));
  });

  it("la doble inyección no duplica pasos (guarda de instalación)", () => {
    cy.injectExtensionScript("steps-capture.js"); // segunda inyección
    cy.get("#btnDemo").click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("<button#btnDemo"));
    cy.window().should((win) => {
      const clicks = win.__entries.filter(
        (e) => e.kind === "step" && e.text.includes("<button#btnDemo")
      );
      expect(clicks).to.have.length(1);
    });
  });
});
