"use strict";

// E2E for the bridge (console-capture-bridge.js): in production it runs
// in the isolated world with a real chrome.runtime; here sendMessage is
// stubbed to capture the batches it would send to the offscreen document.

describe("console-capture-bridge.js (isolated world)", () => {
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

  it("emits the navigation entry with the page URL and the right target", () => {
    cy.window().should((win) => {
      const entries = win.__batches.flatMap((b) => b.entries);
      expect(
        entries.some((e) => e.kind === "nav" && e.text.includes("/cypress/pages/sandbox.html"))
      ).to.be.true;
    });
    cy.window().then((win) => {
      expect(win.__batches[0].target).to.equal("offscreen");
      expect(win.__batches[0].type).to.equal("off:consoleEntries");
    });
  });

  it("groups nearby entries into a single batch (not one message per entry)", () => {
    cy.injectExtensionScript("console-capture-main.js");
    // Let the navigation batch flush so it does not mix with the data one.
    cy.window().should((win) => expect(win.__batches.length).to.be.gte(1));
    cy.window().then((win) => {
      win.__batches = [];
      win.console.log("a");
      win.console.log("b");
      win.console.log("c");
    });
    cy.window().should((win) => {
      const consoleEntries = win.__batches.flatMap((b) => b.entries).filter((e) => e.kind === "console");
      expect(consoleEntries).to.have.length(3);
    });
    cy.window().then((win) => {
      expect(win.__batches, "the three entries travel in a single batch").to.have.length(1);
    });
  });

  it("flushes immediately when the batch size limit (50) is reached", () => {
    cy.injectExtensionScript("console-capture-main.js");
    cy.window().should((win) => expect(win.__batches.length).to.be.gte(1));
    cy.window().then((win) => {
      win.__batches = [];
      win.eval("for (let i = 0; i < 50; i++) console.log('n' + i)");
    });
    cy.window().should((win) => {
      const batch = win.__batches.find((b) => b.entries.length === 50);
      expect(batch, "full batch of 50 entries").to.exist;
    });
  });

  it("double injection of the bridge does not duplicate batches (install guard)", () => {
    cy.injectExtensionScript("console-capture-bridge.js"); // second injection
    cy.injectExtensionScript("console-capture-main.js");
    cy.window().should((win) => expect(win.__batches.length).to.be.gte(1));
    cy.window().then((win) => {
      win.__batches = [];
      win.console.log("single");
    });
    cy.window().should((win) => {
      const entries = win.__batches.flatMap((b) => b.entries).filter((e) => e.text === "single");
      expect(entries).to.have.length(1);
    });
  });
});
