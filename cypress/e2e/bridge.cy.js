"use strict";

// E2E del puente (console-capture-bridge.js): en producción corre en el
// mundo aislado con chrome.runtime real; aquí se suplanta sendMessage para
// capturar los lotes que enviaría al documento offscreen.

describe("console-capture-bridge.js (mundo aislado)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.window().then((win) => {
      win.__batches = [];
      win.chrome = {
        runtime: {
          sendMessage: (msg) => {
            win.__batches.push(msg);
            return Promise.resolve({ ok: true });
          },
        },
      };
    });
    cy.injectExtensionScript("console-capture-bridge.js");
  });

  it("emite la entrada de navegación con la URL de la página y el destino correcto", () => {
    cy.window().should((win) => {
      const entradas = win.__batches.flatMap((b) => b.entries);
      expect(
        entradas.some((e) => e.kind === "nav" && e.text.includes("/cypress/pages/sandbox.html"))
      ).to.be.true;
    });
    cy.window().then((win) => {
      expect(win.__batches[0].target).to.equal("offscreen");
      expect(win.__batches[0].type).to.equal("off:consoleEntries");
    });
  });

  it("agrupa entradas próximas en un solo lote (no un mensaje por entrada)", () => {
    cy.injectExtensionScript("console-capture-main.js");
    // Se deja salir el lote de navegación para no mezclarlo con el de datos.
    cy.window().should((win) => expect(win.__batches.length).to.be.gte(1));
    cy.window().then((win) => {
      win.__batches = [];
      win.console.log("a");
      win.console.log("b");
      win.console.log("c");
    });
    cy.window().should((win) => {
      const consola = win.__batches.flatMap((b) => b.entries).filter((e) => e.kind === "console");
      expect(consola).to.have.length(3);
    });
    cy.window().then((win) => {
      expect(win.__batches, "las tres entradas viajan en un único lote").to.have.length(1);
    });
  });

  it("vacía inmediatamente al llegar al tamaño máximo de lote (50)", () => {
    cy.injectExtensionScript("console-capture-main.js");
    cy.window().should((win) => expect(win.__batches.length).to.be.gte(1));
    cy.window().then((win) => {
      win.__batches = [];
      win.eval("for (let i = 0; i < 50; i++) console.log('n' + i)");
    });
    cy.window().should((win) => {
      const lote = win.__batches.find((b) => b.entries.length === 50);
      expect(lote, "lote completo de 50 entradas").to.exist;
    });
  });

  it("la doble inyección del puente no duplica lotes (guarda de instalación)", () => {
    cy.injectExtensionScript("console-capture-bridge.js"); // segunda inyección
    cy.injectExtensionScript("console-capture-main.js");
    cy.window().should((win) => expect(win.__batches.length).to.be.gte(1));
    cy.window().then((win) => {
      win.__batches = [];
      win.console.log("unica");
    });
    cy.window().should((win) => {
      const entradas = win.__batches.flatMap((b) => b.entries).filter((e) => e.text === "unica");
      expect(entradas).to.have.length(1);
    });
  });
});
