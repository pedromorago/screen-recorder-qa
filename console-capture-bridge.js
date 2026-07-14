"use strict";

// Se inyecta en el mundo AISLADO de la pestaña grabada, junto con
// console-capture-main.js y/o network-capture-main.js (mundo principal).
// Recoge las entradas que aquellos publican con postMessage, las agrupa en
// lotes y las envía al documento offscreen, que es quien las acumula (el
// service worker puede morir a mitad de grabación; el offscreen vive
// mientras se graba).

(() => {
  if (window.__qaRecorderBridgeInstalled) return;
  window.__qaRecorderBridgeInstalled = true;

  const MARK = "__qaRecorderConsole";
  const FLUSH_MS = 300;
  const FLUSH_AT = 50;

  let buf = [];
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buf.length) return;
    const entries = buf;
    buf = [];
    try {
      chrome.runtime
        .sendMessage({ target: "offscreen", type: "off:consoleEntries", entries })
        .catch(() => {});
    } catch (e) {
      /* contexto de extensión invalidado (extensión recargada): se ignora */
    }
  }

  function schedule() {
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const entry = e.data && e.data[MARK];
    if (!entry) return;
    buf.push(entry);
    buf.length >= FLUSH_AT ? flush() : schedule();
  });

  // Marca de navegación: sitúa cada página en la línea de tiempo del vídeo.
  buf.push({ kind: "nav", level: "info", t: Date.now(), text: location.href });
  schedule();

  // Último vaciado antes de que la página se descargue.
  window.addEventListener("pagehide", flush);
})();
