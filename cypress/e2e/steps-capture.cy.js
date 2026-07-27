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

  it("the selector prefers a test attribute over the element's own id", () => {
    cy.get("#btnCy").click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.get('[data-cy=\"checkout\"]')");
  });

  it("with no test attribute, a unique id becomes the selector", () => {
    cy.get("#btnDemo").click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.get('#btnDemo')");
  });

  it("a field with a name gets tag[name=…], and the value stays out of the selector", () => {
    cy.get("input[name=email]").type("pedro@example.com").blur();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.get('input[name=\"email\"]')");
    cy.window().should((win) => {
      expect(JSON.stringify(win.__entries)).to.not.include("pedro@example.com");
    });
  });

  it("data-testid also wins in the Cypress flavor", () => {
    cy.get("[data-testid=save]").click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.get('[data-testid=\"save\"]')");
  });

  it("the Playwright flavor spells the same decisions as Playwright locators", () => {
    // Fresh page: the flavor is read at install time from chrome.storage,
    // which this test stubs BEFORE injecting the real script (in the other
    // tests there is no chrome.* at all and the Cypress default stands).
    cy.visit("/cypress/pages/sandbox.html");
    cy.window().then((win) => {
      win.chrome = {
        storage: {
          local: { get: (defaults, cb) => cb({ selectorFlavor: "playwright" }) },
          onChanged: { addListener() {} },
        },
      };
    });
    cy.startEntryCollector();
    cy.injectExtensionScript("steps-capture.js");

    cy.get("[data-testid=save]").click();
    cy.waitForEntry((e) => e.sel === "page.getByTestId('save')");
    cy.get("#btnCy").click();
    cy.waitForEntry((e) => e.sel === "page.locator('[data-cy=\"checkout\"]')");
    cy.get("#btnDemo").click();
    cy.waitForEntry((e) => e.sel === "page.locator('#btnDemo')");
    cy.get("button.icon").click();
    cy.waitForEntry((e) => e.sel === "page.getByLabel('Pause timer')");
    cy.get("button.ghost").click();
    cy.waitForEntry((e) => e.sel === "page.getByRole('button', { name: 'Cancel order' })");
    cy.get("[role=tab]").click();
    cy.waitForEntry((e) => e.sel === "page.getByRole('tab', { name: 'Details tab' })");
    cy.get("my-chip").click();
    cy.waitForEntry((e) => e.sel === "page.locator('my-chip', { hasText: 'Ready chip' })");
  });

  it("an aria-label beats dynamic visible text (the timer-button case)", () => {
    cy.get("button.icon").click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.get('[aria-label=\"Pause timer\"]')");
  });

  it("texts up to 60 chars still make a cy.contains selector", () => {
    cy.get("button.long").click();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.sel === "cy.contains('button', 'Extend the subscription for another whole year')"
    );
  });

  it("quotes in the text are escaped into a pasteable selector", () => {
    cy.get("button.quote").click();
    cy.waitForEntry(
      (e) => e.kind === "step" && e.sel === "cy.contains('button', '5 \"Uncle Tom\\'s Cabin\" author Harriet Beecher')"
    );
  });

  it("a role=tab widget gets a role-scoped text selector", () => {
    cy.get("[role=tab]").click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.contains('[role=\"tab\"]', 'Details tab')");
  });

  it("a custom element with text identity gets scoped to its tag", () => {
    cy.get("my-chip").click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.contains('my-chip', 'Ready chip')");
  });

  it("an element whose only identity is its text becomes cy.contains", () => {
    cy.get("button.ghost").click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.contains('button', 'Cancel order')");
  });

  it("twins nothing can tell apart fall back to an anchored structural path", () => {
    cy.get("#list button").eq(1).click();
    cy.waitForEntry((e) => e.kind === "step" && e.sel === "cy.get('#list > button:nth-of-type(2)')");
  });

  it("the submit step carries the form's selector", () => {
    cy.get("#formDemo").then(($f) => $f.on("submit", (e) => e.preventDefault()));
    cy.get("#btnSubmit").click();
    cy.waitForEntry((e) => e.kind === "step" && e.text.includes("Form submitted") && e.sel === "cy.get('#formDemo')");
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
