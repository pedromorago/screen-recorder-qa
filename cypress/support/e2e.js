"use strict";

// Los tests provocan a propósito errores no controlados (throw, promesas
// rechazadas, recursos 404): son justo lo que se verifica que la extensión
// captura. No deben tumbar el test.
Cypress.on("uncaught:exception", () => false);

// Inyecta un script REAL de la extensión (fichero de la raíz del repo) en
// la página de prueba, equivalente a lo que hace en producción
// chrome.scripting.executeScript. Con un <script> clásico y no con
// win.eval: eval desde el runner NO crea globales con las declaraciones
// top-level (issue-reporter.js las necesita).
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

// Colector de las entradas que los scripts MAIN publican con postMessage.
Cypress.Commands.add("startEntryCollector", () => {
  cy.window().then((win) => {
    win.__entries = [];
    win.addEventListener("message", (e) => {
      const entry = e.data && e.data.__qaRecorderConsole;
      if (entry) win.__entries.push(entry);
    });
  });
});

// Espera (con los reintentos de Cypress) a que llegue una entrada que
// cumpla el predicado, y la devuelve para más aserciones.
Cypress.Commands.add("waitForEntry", (pred, label) => {
  cy.window().should((win) => {
    expect(win.__entries.some(pred), label || "entrada esperada").to.be.true;
  });
  return cy.window().then((win) => win.__entries.find(pred));
});
