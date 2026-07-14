"use strict";

// E2E for the annotation surface (annotate-overlay.js): the toggle that
// arrives via chrome.tabs.sendMessage in production is simulated by
// capturing the listener with a chrome.runtime stub.

const paintedPixels = (win) => {
  const c = win.document.querySelector("#qa-recorder-annotate canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
  return false;
};

describe("annotate-overlay.js (annotation surface)", () => {
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

  it("starts hidden and shows/hides with the toggle", () => {
    cy.get("#qa-recorder-annotate").should("not.exist");
    toggle();
    cy.get("#qa-recorder-annotate").should("be.visible");
    cy.get("#qa-recorder-annotate canvas").should("exist");
    toggle();
    cy.get("#qa-recorder-annotate").should("not.be.visible");
  });

  it('drawing paints pixels and "Clear" wipes them', () => {
    toggle();
    draw();
    cy.window().should((win) => expect(paintedPixels(win), "stroke painted").to.be.true);
    // force: the overlay covers everything by design and Cypress treats
    // that as a "covered element".
    cy.get("#qa-recorder-annotate button[data-action=clear]").click({ force: true });
    cy.window().should((win) => expect(paintedPixels(win), "canvas clean").to.be.false);
  });

  it("Esc closes the annotation and closing clears the canvas", () => {
    toggle();
    draw();
    cy.get("body").trigger("keydown", { key: "Escape", force: true });
    cy.get("#qa-recorder-annotate").should("not.be.visible");
    toggle();
    cy.window().should((win) => expect(paintedPixels(win)).to.be.false);
  });

  it('the "Exit" button also closes the annotation', () => {
    toggle();
    cy.get("#qa-recorder-annotate button[data-action=close]").click({ force: true });
    cy.get("#qa-recorder-annotate").should("not.be.visible");
  });

  it("leaves a timeline entry when enabled", () => {
    toggle();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.text.includes("On-video annotation enabled")
    );
  });

  it("drawing gestures do not pollute the steps log", () => {
    cy.injectExtensionScript("steps-capture.js");
    toggle();
    draw();
    cy.get("#qa-recorder-annotate canvas").trigger("click", { clientX: 120, clientY: 220 });
    cy.window().should((win) => {
      const clicks = win.__entries.filter(
        (e) => e.kind === "step" && e.text.startsWith("Click on")
      );
      expect(clicks, "no overlay click recorded as a step").to.have.length(0);
    });
  });

  it("double injection does not duplicate the surface (install guard)", () => {
    cy.injectExtensionScript("annotate-overlay.js"); // second injection
    toggle();
    cy.get("#qa-recorder-annotate").should("have.length", 1);
  });
});
