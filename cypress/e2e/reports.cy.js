"use strict";

// E2E de los generadores de informes de offscreen.js (.console.log,
// .console.json y .har). El harness carga el offscreen.js REAL con un stub
// mínimo de chrome.*, y cada test fija el estado de una grabación y
// verifica los ficheros generados.

const SET_STATE = `
  videoStartTime = 1000;
  consoleEnabled = true;
  networkEnabled = true;
  qaDropped = 0;
  qaMeta = { url: "https://app.example/checkout", title: "Checkout" };
  qaEntries = [
    { kind: "nav", level: "info", t: 1000, text: "https://app.example/checkout" },
    { kind: "console", level: "warn", t: 8500, text: "stock bajo" },
    { kind: "net", level: "info", t: 9000,
      text: "GET https://api.example/ok?a=1&b=2 → 200 OK (120 ms)",
      net: { initiator: "fetch", url: "https://api.example/ok?a=1&b=2", method: "GET",
             status: 200, statusText: "OK", durationMs: 120, requestHeaders: [],
             responseHeaders: [{ name: "content-type", value: "application/json" }],
             contentType: "application/json", contentLength: 42, error: "" } },
    { kind: "nav", level: "info", t: 20000, text: "https://app.example/pago" },
    { kind: "net", level: "error", t: 21000,
      text: "POST https://api.example/pagar → 500 Internal Server Error (200 ms)",
      net: { initiator: "xhr", url: "https://api.example/pagar", method: "POST",
             status: 500, statusText: "Internal Server Error", durationMs: 200,
             requestHeaders: [], responseHeaders: [], contentType: "",
             contentLength: -1, error: "" } },
    { kind: "exception", level: "error", t: 21500, text: "TypeError: total is undefined" },
  ];
`;

describe("offscreen.js: generación de informes", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/offscreen-harness.html");
    cy.window().then((win) => win.eval(SET_STATE));
  });

  it("offset() formatea +mm:ss.mmm respecto al inicio del vídeo, nunca negativo", () => {
    cy.window().then((win) => {
      expect(win.eval("offset(1000)")).to.equal("+00:00.000");
      expect(win.eval("offset(62234)")).to.equal("+01:01.234");
      expect(win.eval("offset(500)")).to.equal("+00:00.000");
    });
  });

  it("acceptsEntry() filtra según los interruptores de la grabación en curso", () => {
    cy.window().then((win) => {
      win.eval("consoleEnabled = false; networkEnabled = true;");
      expect(win.eval("acceptsEntry({ kind: 'console' })")).to.be.false;
      expect(win.eval("acceptsEntry({ kind: 'net' })")).to.be.true;
      expect(win.eval("acceptsEntry({ kind: 'nav' })")).to.be.true;
      win.eval("consoleEnabled = true; networkEnabled = false;");
      expect(win.eval("acceptsEntry({ kind: 'net' })")).to.be.false;
      expect(win.eval("acceptsEntry({ kind: 'exception' })")).to.be.true;
      expect(win.eval("acceptsEntry(null)")).to.be.false;
    });
  });

  it("el .console.log lleva cabecera, offsets y solo la red que falla", () => {
    cy.window().then((win) => {
      const { text } = win.eval("buildConsoleReport()");
      expect(text).to.include("# Página: Checkout — https://app.example/checkout");
      expect(text).to.include("[+00:07.500] WARN  stock bajo");
      expect(text).to.include("[+00:20.000] NET   POST https://api.example/pagar → 500");
      expect(text).to.include("[+00:20.500] ERROR TypeError: total is undefined");
      // La red sana no mete ruido en el log: ya está completa en el .har.
      expect(text).to.not.include("api.example/ok");
    });
  });

  it("el .console.json excluye la red y da offsets en milisegundos", () => {
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

  it("el .har es HAR 1.2: una page por navegación y pageref por timestamp", () => {
    cy.window().then((win) => {
      const har = JSON.parse(win.eval("buildHar()"));
      expect(har.log.version).to.equal("1.2");
      expect(har.log.pages).to.have.length(2);
      expect(har.log.pages[0].title).to.equal("https://app.example/checkout");
      expect(har.log.pages[1].title).to.equal("https://app.example/pago");
      expect(har.log.entries).to.have.length(2);

      const [ok, fallo] = har.log.entries;
      expect(ok.pageref).to.equal("page_1");
      expect(fallo.pageref).to.equal("page_2");
      expect(ok.request.queryString).to.deep.equal([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]);
      expect(ok.response.content.mimeType).to.equal("application/json");
      expect(ok.response.content.size).to.equal(42);
      expect(ok.time).to.equal(120);
      expect(ok.timings.wait).to.equal(120);
      expect(fallo.request.method).to.equal("POST");
      expect(fallo.response.status).to.equal(500);
    });
  });

  it("sin navegaciones registradas, el .har usa la URL de la pestaña como única page", () => {
    cy.window().then((win) => {
      win.eval("qaEntries = qaEntries.filter((e) => e.kind !== 'nav')");
      const har = JSON.parse(win.eval("buildHar()"));
      expect(har.log.pages).to.have.length(1);
      expect(har.log.pages[0].title).to.equal("https://app.example/checkout");
      expect(har.log.entries.map((e) => e.pageref)).to.deep.equal(["page_1", "page_1"]);
    });
  });
});
