"use strict";

// Se inyecta en el MUNDO PRINCIPAL (world: "MAIN") de la pestaña grabada.
// Envuelve console.* y escucha errores JS para el registro de consola que
// acompaña al vídeo. Aquí no existe chrome.runtime: cada entrada se publica
// con window.postMessage y console-capture-bridge.js (mundo aislado) la
// reenvía a la extensión.

(() => {
  if (window.__qaRecorderMainInstalled) return;
  window.__qaRecorderMainInstalled = true;

  const MARK = "__qaRecorderConsole";
  const MAX_TEXT = 2000;

  function post(entry) {
    try {
      window.postMessage({ [MARK]: entry }, "*");
    } catch (e) {
      /* entrada no clonable o página cerrándose: se descarta */
    }
  }

  const clip = (s) =>
    s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + " … [recortado]" : s;

  // Descripción textual segura de cualquier valor: nunca lanza.
  function describe(value) {
    try {
      if (typeof value === "string") return clip(value);
      if (value === null || value === undefined) return String(value);
      if (typeof value === "function")
        return "[función " + (value.name || "anónima") + "]";
      if (value instanceof Error)
        return clip(value.stack || value.name + ": " + value.message);
      if (typeof Node !== "undefined" && value instanceof Node) {
        const el = value.nodeType === 1 ? value : null;
        if (!el) return "[nodo " + value.nodeName + "]";
        return (
          "<" +
          el.tagName.toLowerCase() +
          (el.id ? " id=" + el.id : "") +
          (el.className && typeof el.className === "string"
            ? ' class="' + el.className + '"'
            : "") +
          ">"
        );
      }
      if (typeof value === "object") {
        const seen = new WeakSet();
        return clip(
          JSON.stringify(value, (k, v) => {
            if (typeof v === "object" && v !== null) {
              if (seen.has(v)) return "[circular]";
              seen.add(v);
            }
            if (typeof v === "function")
              return "[función " + (v.name || "anónima") + "]";
            if (typeof v === "bigint") return v.toString() + "n";
            return v;
          }) ?? String(value)
        );
      }
      return String(value);
    } catch (e) {
      return "[no serializable]";
    }
  }

  // ---------- console.* ----------

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = function (...args) {
      post({
        kind: "console",
        level,
        t: Date.now(),
        text: args.map(describe).join(" "),
      });
      return original.apply(this, args);
    };
  }

  // ---------- Errores no capturados ----------

  // capture: true para recibir también errores de carga de recursos
  // (imágenes, scripts, etc.), que no burbujean hasta window.
  window.addEventListener(
    "error",
    (e) => {
      if (e.target && e.target !== window && !(e instanceof ErrorEvent)) {
        const el = e.target;
        const src = el.src || el.href || "";
        post({
          kind: "resource",
          level: "error",
          t: Date.now(),
          text:
            "Recurso no cargado: <" +
            (el.tagName || "?").toLowerCase() +
            ">" +
            (src ? " " + clip(String(src)) : ""),
        });
        return;
      }
      post({
        kind: "exception",
        level: "error",
        t: Date.now(),
        text:
          (e.error ? describe(e.error) : clip(String(e.message))) +
          (e.filename
            ? "\n    en " + e.filename + ":" + e.lineno + ":" + e.colno
            : ""),
      });
    },
    true
  );

  window.addEventListener("unhandledrejection", (e) => {
    post({
      kind: "rejection",
      level: "error",
      t: Date.now(),
      text: "Promesa rechazada sin capturar: " + describe(e.reason),
    });
  });
})();
