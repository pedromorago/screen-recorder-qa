"use strict";

// E2E for the network wrapper (network-capture-main.js): real fetch and
// XHR against the local test server, verifying what gets published.

describe("network-capture-main.js (MAIN world)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.startEntryCollector();
    cy.injectExtensionScript("network-capture-main.js");
  });

  it("records a 200 fetch with absolute URL, duration and response headers", () => {
    cy.window().then((win) => win.eval("fetch('/api/ok?a=1&b=2')"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.status === 200).then((entry) => {
      expect(entry.level).to.equal("info");
      expect(entry.net.initiator).to.equal("fetch");
      expect(entry.net.method).to.equal("GET");
      // Relative URLs are resolved to absolute (required for the HAR).
      expect(entry.net.url).to.equal(`${Cypress.config("baseUrl")}/api/ok?a=1&b=2`);
      expect(entry.net.durationMs).to.be.a("number").and.to.be.gte(0);
      const names = entry.net.responseHeaders.map((h) => h.name.toLowerCase());
      expect(names).to.include("x-test-header");
      expect(entry.net.contentType).to.include("application/json");
    });
  });

  it("marks a 500 as error and reflects it in the entry text", () => {
    cy.window().then((win) => win.eval("fetch('/api/error')"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.status === 500).then((entry) => {
      expect(entry.level).to.equal("error");
      expect(entry.text).to.include("→ 500");
    });
  });

  it("records a network failure (unreachable server) with status 0 and error", () => {
    cy.window().then((win) => win.eval("fetch('http://localhost:1/x').catch(() => {})"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.error).then((entry) => {
      expect(entry.level).to.equal("error");
      expect(entry.net.status).to.equal(0);
      expect(entry.text).to.include("FAILED");
    });
  });

  it("records XHR with method, request and response headers", () => {
    cy.window().then((win) =>
      win.eval(`
        const x = new XMLHttpRequest();
        x.open("POST", "/api/ok");
        x.setRequestHeader("X-Request", "qa");
        x.send("body");
      `)
    );
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.initiator === "xhr").then((entry) => {
      expect(entry.net.method).to.equal("POST");
      expect(entry.net.status).to.equal(200);
      expect(entry.net.url).to.equal(`${Cypress.config("baseUrl")}/api/ok`);
      expect(entry.net.requestHeaders).to.deep.include({ name: "X-Request", value: "qa" });
      const names = entry.net.responseHeaders.map((h) => h.name.toLowerCase());
      expect(names).to.include("x-test-header");
    });
  });

  it("XHR against a dead server ends as status 0 with a reason", () => {
    cy.window().then((win) =>
      win.eval(`
        const x = new XMLHttpRequest();
        x.open("GET", "http://localhost:1/x");
        x.send();
      `)
    );
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.initiator === "xhr").then((entry) => {
      expect(entry.net.status).to.equal(0);
      expect(entry.net.error).to.include("no response");
    });
  });

  it("a reused XHR (open/send twice) does not duplicate entries", () => {
    cy.window().then((win) =>
      win.eval(`
        window.__xhrReuse = new XMLHttpRequest();
        __xhrReuse.open("GET", "/api/ok?round=1");
        __xhrReuse.send();
      `)
    );
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.url.includes("round=1"));
    cy.window().then((win) =>
      win.eval(`
        __xhrReuse.open("GET", "/api/ok?round=2");
        __xhrReuse.send();
      `)
    );
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.url.includes("round=2"));
    cy.window().should((win) => {
      const nets = win.__entries.filter((e) => e.kind === "net");
      expect(nets.filter((e) => e.net.url.includes("round=1")), "first request").to.have.length(1);
      expect(nets.filter((e) => e.net.url.includes("round=2")), "second request").to.have.length(1);
    });
  });

  it("double injection does not duplicate requests (install guard)", () => {
    cy.injectExtensionScript("network-capture-main.js"); // second injection
    cy.window().then((win) => win.eval("fetch('/api/ok?single=1')"));
    cy.waitForEntry((e) => e.kind === "net" && e.net && e.net.url.includes("single=1"));
    cy.window().should((win) => {
      const repeats = win.__entries.filter(
        (e) => e.kind === "net" && e.net && e.net.url.includes("single=1")
      );
      expect(repeats).to.have.length(1);
    });
  });
});
