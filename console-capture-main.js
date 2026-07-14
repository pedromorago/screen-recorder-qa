"use strict";

// Injected into the MAIN world (world: "MAIN") of the recorded tab. Wraps
// console.* and listens for JS errors, feeding the console log that ships
// alongside the video. chrome.runtime does not exist here: each entry is
// published with window.postMessage and console-capture-bridge.js
// (isolated world) relays it to the extension.

(() => {
  if (window.__qaRecorderMainInstalled) return;
  window.__qaRecorderMainInstalled = true;

  const MARK = "__qaRecorderConsole";
  const MAX_TEXT = 2000;

  function post(entry) {
    try {
      window.postMessage({ [MARK]: entry }, "*");
    } catch (e) {
      /* non-cloneable entry or page tearing down: drop it */
    }
  }

  const clip = (s) =>
    s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + " … [truncated]" : s;

  // Safe textual description of any value: never throws.
  function describe(value) {
    try {
      if (typeof value === "string") return clip(value);
      if (value === null || value === undefined) return String(value);
      if (typeof value === "function")
        return "[function " + (value.name || "anonymous") + "]";
      if (value instanceof Error)
        return clip(value.stack || value.name + ": " + value.message);
      if (typeof Node !== "undefined" && value instanceof Node) {
        const el = value.nodeType === 1 ? value : null;
        if (!el) return "[node " + value.nodeName + "]";
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
              return "[function " + (v.name || "anonymous") + "]";
            if (typeof v === "bigint") return v.toString() + "n";
            return v;
          }) ?? String(value)
        );
      }
      if (typeof value === "bigint") return value.toString() + "n";
      return String(value);
    } catch (e) {
      return "[unserializable]";
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

  // ---------- Uncaught errors ----------

  // capture: true so we also receive resource load errors (images,
  // scripts, etc.), which do not bubble up to window.
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
            "Resource failed to load: <" +
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
            ? "\n    at " + e.filename + ":" + e.lineno + ":" + e.colno
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
      text: "Uncaught promise rejection: " + describe(e.reason),
    });
  });
})();
