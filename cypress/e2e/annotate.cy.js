"use strict";

// E2E de la superficie de anotación (annotate-overlay.js): el toggle que
// en producción llega por chrome.tabs.sendMessage se simula capturando el
// listener con un stub de chrome.runtime.

const paintedPixels = (win) => {
  const c = win.document.querySelector("#qa-recorder-annotate canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
  return false;
};

describe("annotate-overlay.js (superficie de anotación)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.startEntryCollector();
    cy.window().then((win) => {
      win.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => (win.__annotateOnMessage = fn) },
          sendMessage: () => Promise.resolve(),
        },
      };
    });
    cy.injectExtensionScript("annotate-overlay.js");
  });

  const toggle = () =>
    cy.window().then((win) => win.__annotateOnMessage({ type: "annotate:toggle" }, {}, () => {}));

  const draw = () =>
    cy
      .get("#qa-recorder-annotate canvas")
      .trigger("pointerdown", { clientX: 100, clientY: 200, pointerId: 1, eventConstructor: "PointerEvent" })
      .trigger("pointermove", { clientX: 180, clientY: 260, pointerId: 1, eventConstructor: "PointerEvent" })
      .trigger("pointerup", { pointerId: 1, eventConstructor: "PointerEvent" });

  it("arranca oculta y se muestra/oculta con el toggle", () => {
    cy.get("#qa-recorder-annotate").should("not.exist");
    toggle();
    cy.get("#qa-recorder-annotate").should("be.visible");
    cy.get("#qa-recorder-annotate canvas").should("exist");
    toggle();
    cy.get("#qa-recorder-annotate").should("not.be.visible");
  });

  it("dibujar pinta píxeles y «Borrar» los limpia", () => {
    toggle();
    draw();
    cy.window().should((win) => expect(paintedPixels(win), "trazo pintado").to.be.true);
    cy.contains("#qa-recorder-annotate button", "Borrar").click();
    cy.window().should((win) => expect(paintedPixels(win), "lienzo limpio").to.be.false);
  });

  it("Esc cierra la anotación y al cerrarse limpia el lienzo", () => {
    toggle();
    draw();
    cy.get("body").trigger("keydown", { key: "Escape" });
    cy.get("#qa-recorder-annotate").should("not.be.visible");
    toggle();
    cy.window().should((win) => expect(paintedPixels(win)).to.be.false);
  });

  it("al activarse deja una entrada en la línea de tiempo", () => {
    toggle();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.text.includes("Anotación sobre el vídeo activada")
    );
  });

  it("los gestos de dibujo no contaminan el registro de pasos", () => {
    cy.injectExtensionScript("steps-capture.js");
    toggle();
    draw();
    cy.get("#qa-recorder-annotate canvas").trigger("click", { clientX: 120, clientY: 220 });
    cy.window().should((win) => {
      const clicks = win.__entries.filter(
        (e) => e.kind === "step" && e.text.startsWith("Click en")
      );
      expect(clicks, "ningún click del overlay como paso").to.have.length(0);
    });
  });

  it("la doble inyección no duplica la superficie (guarda de instalación)", () => {
    cy.injectExtensionScript("annotate-overlay.js"); // segunda inyección
    toggle();
    cy.get("#qa-recorder-annotate").should("have.length", 1);
  });
});
