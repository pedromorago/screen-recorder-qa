"use strict";

// Injected into the ISOLATED world of the recorded tab, together with
// console-capture-main.js and/or network-capture-main.js (MAIN world).
// It collects the entries those scripts publish with postMessage, groups
// them into batches and sends them to the offscreen document, which is
// where they accumulate (the service worker can die mid-recording; the
// offscreen document lives for as long as the recording does).

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
      /* extension context invalidated (extension reloaded): ignore */
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

  // Navigation mark: places each page on the video's timeline.
  buf.push({ kind: "nav", level: "info", t: Date.now(), text: location.href });
  schedule();

  // One last flush before the page unloads.
  window.addEventListener("pagehide", flush);
})();
