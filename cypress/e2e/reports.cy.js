"use strict";

// E2E for the offscreen.js report builders (.console.log, .console.json,
// .har, .steps.md, .report.md). The harness loads the REAL offscreen.js
// with a minimal chrome.* stub; each test sets a recording's state and
// verifies the generated files.

const SET_STATE = `
  videoStartTime = 1000;
  consoleEnabled = true;
  networkEnabled = true;
  stepsEnabled = true;
  qaDropped = 0;
  qaMeta = { url: "https://app.example/checkout", title: "Checkout" };
  qaEntries = [
    { kind: "nav", level: "info", t: 1000, text: "https://app.example/checkout" },
    { kind: "console", level: "warn", t: 8500, text: "low stock" },
    { kind: "net", level: "info", t: 9000,
      text: "GET https://api.example/ok?a=1&b=2 → 200 OK (120 ms)",
      net: { initiator: "fetch", url: "https://api.example/ok?a=1&b=2", method: "GET",
             status: 200, statusText: "OK", durationMs: 120, requestHeaders: [],
             responseHeaders: [{ name: "content-type", value: "application/json" }],
             contentType: "application/json", contentLength: 42, error: "" } },
    { kind: "step", level: "info", t: 15000, text: "Click on <button#pay «Pay»>" },
    { kind: "nav", level: "info", t: 20000, text: "https://app.example/payment" },
    { kind: "marker", level: "warn", t: 20500, text: "User marker: the bug is here" },
    { kind: "net", level: "error", t: 21000,
      text: "POST https://api.example/pay → 500 Internal Server Error (200 ms)",
      net: { initiator: "xhr", url: "https://api.example/pay", method: "POST",
             status: 500, statusText: "Internal Server Error", durationMs: 200,
             requestHeaders: [], responseHeaders: [], contentType: "",
             contentLength: -1, error: "" } },
    { kind: "exception", level: "error", t: 21500, text: "TypeError: total is undefined" },
  ];
`;

describe("offscreen.js: report builders", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/offscreen-harness.html");
    cy.window().then((win) => win.eval(SET_STATE));
  });

  it("offset() formats +mm:ss.mmm relative to the video start, never negative", () => {
    cy.window().then((win) => {
      expect(win.eval("offset(1000)")).to.equal("+00:00.000");
      expect(win.eval("offset(62234)")).to.equal("+01:01.234");
      expect(win.eval("offset(500)")).to.equal("+00:00.000");
    });
  });

  it("acceptsEntry() filters by the current recording's toggles", () => {
    cy.window().then((win) => {
      win.eval("consoleEnabled = false; networkEnabled = true; stepsEnabled = false;");
      expect(win.eval("acceptsEntry({ kind: 'console' })")).to.be.false;
      expect(win.eval("acceptsEntry({ kind: 'net' })")).to.be.true;
      expect(win.eval("acceptsEntry({ kind: 'nav' })")).to.be.true;
      win.eval("consoleEnabled = true; networkEnabled = false;");
      expect(win.eval("acceptsEntry({ kind: 'net' })")).to.be.false;
      expect(win.eval("acceptsEntry({ kind: 'exception' })")).to.be.true;
      expect(win.eval("acceptsEntry(null)")).to.be.false;
    });
  });

  it("the .console.log has a header, offsets and only failing network", () => {
    cy.window().then((win) => {
      const { text } = win.eval("buildConsoleReport()");
      expect(text).to.include("# Page: Checkout — https://app.example/checkout");
      expect(text).to.include("[+00:07.500] WARN  low stock");
      expect(text).to.include("[+00:14.000] STEP  Click on <button#pay «Pay»>");
      expect(text).to.include("[+00:19.500] MARK  User marker");
      expect(text).to.include("[+00:20.000] NET   POST https://api.example/pay → 500");
      expect(text).to.include("[+00:20.500] ERROR TypeError: total is undefined");
      // Healthy network adds no noise to the log: it is complete in the .har.
      expect(text).to.not.include("api.example/ok");
    });
  });

  it("the .console.json excludes network and gives offsets in milliseconds", () => {
    cy.window().then((win) => {
      const { json } = win.eval("buildConsoleReport()");
      const parsed = JSON.parse(json);
      expect(parsed.meta.url).to.equal("https://app.example/checkout");
      expect(parsed.meta.userAgent).to.be.a("string").and.not.be.empty;
      expect(parsed.entries.map((e) => e.kind)).to.not.include("net");
      const warn = parsed.entries.find((e) => e.level === "warn");
      expect(warn.offsetMs).to.equal(7500);
      expect(warn.offset).to.equal("+00:07.500");
    });
  });

  it("the .har is HAR 1.2: one page per navigation and pageref by timestamp", () => {
    cy.window().then((win) => {
      const har = JSON.parse(win.eval("buildHar()"));
      expect(har.log.version).to.equal("1.2");
      expect(har.log.pages).to.have.length(2);
      expect(har.log.pages[0].title).to.equal("https://app.example/checkout");
      expect(har.log.pages[1].title).to.equal("https://app.example/payment");
      expect(har.log.entries).to.have.length(2);

      const [ok, failed] = har.log.entries;
      expect(ok.pageref).to.equal("page_1");
      expect(failed.pageref).to.equal("page_2");
      expect(ok.request.queryString).to.deep.equal([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]);
      expect(ok.response.content.mimeType).to.equal("application/json");
      expect(ok.response.content.size).to.equal(42);
      expect(ok.time).to.equal(120);
      expect(ok.timings.wait).to.equal(120);
      expect(failed.request.method).to.equal("POST");
      expect(failed.response.status).to.equal(500);
    });
  });

  it("the .steps.md numbers navigations, steps and markers with offsets", () => {
    cy.window().then((win) => {
      const md = win.eval("buildStepsReport()");
      expect(md).to.include("# Steps to reproduce — Checkout");
      expect(md).to.include("Values typed by the user are NEVER recorded");
      expect(md).to.include("1. [+00:00.000] Go to https://app.example/checkout");
      expect(md).to.include("2. [+00:14.000] Click on <button#pay «Pay»>");
      expect(md).to.include("3. [+00:19.000] Go to https://app.example/payment");
      expect(md).to.include("4. [+00:19.500] 💥 User marker");
    });
  });

  it("the .report.md summarizes environment, counters, markers and errors", () => {
    cy.window().then((win) => {
      const md = win.eval(
        `buildRecordingReport("recording-TEST", 95000, ["recording-TEST.webm", "recording-TEST.har"])`
      );
      expect(md).to.include("# QA recording report — Checkout");
      expect(md).to.include("- URL: https://app.example/checkout");
      expect(md).to.include("- Duration: 01:35");
      expect(md).to.include("- JS errors (exceptions and unhandled rejections): 1");
      expect(md).to.include("- Failed requests: 1 of 2 recorded");
      expect(md).to.include("- User markers: 1");
      expect(md).to.include("- Steps recorded: 1");
      expect(md).to.include('## Markers ("the bug is here")');
      expect(md).to.include("- [+00:19.500] 💥 User marker");
      expect(md).to.include("## Timeline errors");
      expect(md).to.include("TypeError: total is undefined");
      expect(md).to.include("- recording-TEST.webm");
    });
  });

  it("with no recorded navigations, the .har uses the tab URL as its only page", () => {
    cy.window().then((win) => {
      win.eval("qaEntries = qaEntries.filter((e) => e.kind !== 'nav')");
      const har = JSON.parse(win.eval("buildHar()"));
      expect(har.log.pages).to.have.length(1);
      expect(har.log.pages[0].title).to.equal("https://app.example/checkout");
      expect(har.log.entries.map((e) => e.pageref)).to.deep.equal(["page_1", "page_1"]);
    });
  });
});
