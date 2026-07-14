"use strict";

// Se inyecta en el MUNDO PRINCIPAL (world: "MAIN") de la pestaña grabada.
// Envuelve fetch y XMLHttpRequest para el registro de red que acompaña al
// vídeo (export HAR). Igual que console-capture-main.js, aquí no existe
// chrome.runtime: publica con postMessage y console-capture-bridge.js
// reenvía a la extensión.

(() => {
  if (window.__qaRecorderNetInstalled) return;
  window.__qaRecorderNetInstalled = true;

  const MARK = "__qaRecorderConsole";
  const MAX_URL = 2000;
  const MAX_HEADERS = 50;
  const MAX_HEADER_VALUE = 500;

  function post(entry) {
    try {
      window.postMessage({ [MARK]: entry }, "*");
    } catch (e) {
      /* página cerrándose: se descarta */
    }
  }

  const clip = (s, max) => (s.length > max ? s.slice(0, max) + "…" : s);
  const int = (v) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? -1 : n;
  };

  // Headers (objeto Headers) → [{name, value}], acotado.
  function headersToArray(h) {
    const out = [];
    try {
      for (const [name, value] of h) {
        if (out.length >= MAX_HEADERS) break;
        out.push({ name, value: clip(String(value), MAX_HEADER_VALUE) });
      }
    } catch (e) {
      /* headers no iterables */
    }
    return out;
  }

  // getAllResponseHeaders() (texto plano) → [{name, value}], acotado.
  function parseRawHeaders(raw) {
    const out = [];
    for (const line of String(raw || "").trim().split(/[\r\n]+/)) {
      if (!line || out.length >= MAX_HEADERS) break;
      const i = line.indexOf(":");
      if (i <= 0) continue;
      out.push({
        name: line.slice(0, i).trim(),
        value: clip(line.slice(i + 1).trim(), MAX_HEADER_VALUE),
      });
    }
    return out;
  }

  function report(t0, net) {
    net.url = clip(String(net.url || ""), MAX_URL);
    const failed = !!net.error || net.status >= 400;
    const outcome = net.error
      ? "FALLO: " + net.error
      : net.status + (net.statusText ? " " + net.statusText : "");
    post({
      kind: "net",
      level: failed ? "error" : "info",
      t: t0,
      text: `${net.method} ${net.url} → ${outcome} (${net.durationMs} ms)`,
      net,
    });
  }

  // ---------- fetch ----------

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const t0 = Date.now();
      let method = "GET";
      let url = "";
      let requestHeaders = [];
      try {
        const [input, init] = args;
        if (typeof Request !== "undefined" && input instanceof Request) {
          url = input.url;
          method = input.method || "GET";
          requestHeaders = headersToArray(input.headers);
        } else {
          url = String(input);
          try {
            url = new URL(url, location.href).href;
          } catch (err) {
            /* URL imposible de resolver: se registra tal cual */
          }
        }
        if (init && init.method) method = init.method;
        if (init && init.headers) requestHeaders = headersToArray(new Headers(init.headers));
      } catch (e) {
        /* argumentos exóticos: se registra lo que haya */
      }
      method = String(method).toUpperCase();

      const promise = origFetch.apply(this, args);
      promise.then(
        (res) => {
          let responseHeaders = [];
          let contentType = "";
          let contentLength = -1;
          try {
            responseHeaders = headersToArray(res.headers);
            contentType = res.headers.get("content-type") || "";
            contentLength = int(res.headers.get("content-length"));
          } catch (e) {
            /* respuesta opaca (no-cors) */
          }
          report(t0, {
            initiator: "fetch",
            url,
            method,
            status: res.status,
            statusText: res.statusText,
            durationMs: Date.now() - t0,
            requestHeaders,
            responseHeaders,
            contentType,
            contentLength,
            error: "",
          });
        },
        (err) => {
          report(t0, {
            initiator: "fetch",
            url,
            method,
            status: 0,
            statusText: "",
            durationMs: Date.now() - t0,
            requestHeaders,
            responseHeaders: [],
            contentType: "",
            contentLength: -1,
            error: String((err && err.message) || err),
          });
        }
      );
      return promise;
    };
  }

  // ---------- XMLHttpRequest ----------

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      let abs = String(url);
      try {
        abs = new URL(url, location.href).href;
      } catch (e) {
        /* URL relativa rara: se deja tal cual */
      }
      this.__qaNet = {
        method: String(method || "GET").toUpperCase(),
        url: abs,
        requestHeaders: [],
      };
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      const info = this.__qaNet;
      if (info && info.requestHeaders.length < MAX_HEADERS) {
        info.requestHeaders.push({
          name: String(name),
          value: clip(String(value), MAX_HEADER_VALUE),
        });
      }
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const info = this.__qaNet;
      if (info) {
        const t0 = Date.now();
        this.addEventListener("loadend", () => {
          let responseHeaders = [];
          let contentType = "";
          let contentLength = -1;
          try {
            responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
            contentType = this.getResponseHeader("content-type") || "";
            contentLength = int(this.getResponseHeader("content-length"));
          } catch (e) {
            /* respuesta inaccesible */
          }
          // status 0 = la petición no llegó a resolverse (red, CORS, abort).
          report(t0, {
            initiator: "xhr",
            url: info.url,
            method: info.method,
            status: this.status,
            statusText: this.statusText,
            durationMs: Date.now() - t0,
            requestHeaders: info.requestHeaders,
            responseHeaders,
            contentType,
            contentLength,
            error: this.status === 0 ? "sin respuesta (red, CORS o abort)" : "",
          });
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
