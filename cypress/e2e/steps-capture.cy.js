"use strict";

// E2E for the steps log (steps-capture.js): clicks, field changes and
// form submits, verifying above all the privacy rule: typed VALUES are
// never recorded.

describe("steps-capture.js (isolated world)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.startEntryCollector();
    cy.injectExtensionScript("steps-capture.js");
  });

  it("records a click with the interactive element and its text", () => {
    cy.get("#btnDemo").click();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.text.includes("Click on <button#btnDemo") && e.text.includes("«Buy now»")
    );
  });

  it("attributes the click to the interactive element, not the decorative span", () => {
    cy.get("#btnDemo span").click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("<button#btnDemo"));
  });

  it("records a field change WITHOUT capturing the value", () => {
    cy.get("input[name=email]").type("pedro@example.com").blur();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.text.includes("Change in <input[name=email]") && e.text.includes("value not recorded")
    );
    cy.window().should((win) => {
      const dump = JSON.stringify(win.__entries);
      expect(dump).to.not.include("pedro@example.com");
    });
  });

  it("never records the value of a password field", () => {
    cy.get("input[name=password]").type("secret123").blur();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("[name=password]") && e.text.includes("type=password"));
    cy.window().should((win) => {
      expect(JSON.stringify(win.__entries)).to.not.include("secret123");
    });
  });

  it("a click on plain text does not overflow the step label", () => {
    cy.get("p").first().click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("<p") && e.text.length < 150);
  });

  it("records a form submit", () => {
    cy.get("#formDemo").then(($f) => $f.on("submit", (e) => e.preventDefault()));
    cy.get("#btnSubmit").click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("Form submitted <form#formDemo"));
  });

  it("double injection does not duplicate steps (install guard)", () => {
    cy.injectExtensionScript("steps-capture.js"); // second injection
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
