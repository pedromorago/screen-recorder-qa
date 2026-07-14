"use strict";

// Annotation surface over the recorded tab (ISOLATED world). Since the
// overlay is DOM inside the page itself, tab capture records it without
// touching the video pipeline. It is toggled with the toggle-annotate
// command (Ctrl/Cmd+Shift+Y) or the popup button, via
// chrome.tabs.sendMessage from the background.

(() => {
  if (window.__qaRecorderAnnotateInstalled) return;
  window.__qaRecorderAnnotateInstalled = true;

  const MARK = "__qaRecorderConsole";
  const COLORS = ["#FF3B30", "#FFCC00", "#34C759"];
  const ID = "qa-recorder-annotate";

  let container = null;
  let canvas = null;
  let ctx = null;
  let active = false;
  let drawing = false;
  let color = COLORS[0];

  function resize() {
    // Resizing resets the canvas bitmap: strokes are lost, which is fine
    // (annotations are ephemeral by design).
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
  }

  function clearCanvas() {
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function down(e) {
    drawing = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* synthetic pointerId in tests */
    }
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(e.clientX, e.clientY);
  }

  function move(e) {
    if (!drawing) return;
    ctx.lineTo(e.clientX, e.clientY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(e.clientX, e.clientY);
  }

  function up() {
    drawing = false;
  }

  function button(text, title, onClick, extra, action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    if (action) b.setAttribute("data-action", action);
    b.style.cssText =
      "border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;" +
      "border-radius:999px;padding:4px 10px;font:12px system-ui,sans-serif;cursor:pointer;" +
      (extra || "");
    b.addEventListener("click", onClick);
    return b;
  }

  function buildUi() {
    if (container) return;
    container = document.createElement("div");
    container.id = ID;
    container.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:none;";

    canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;";
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    container.appendChild(canvas);

    const toolbar = document.createElement("div");
    toolbar.style.cssText =
      "position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;" +
      "align-items:center;background:rgba(20,26,32,.92);border:1px solid rgba(255,255,255,.25);" +
      "border-radius:999px;padding:8px 12px;";
    for (const c of COLORS) {
      const swatch = button("", "Stroke color", () => (color = c),
        `width:22px;height:22px;padding:0;background:${c};border:2px solid #fff;`);
      toolbar.appendChild(swatch);
    }
    toolbar.appendChild(button("Clear", "Clear the strokes", clearCanvas, "", "clear"));
    toolbar.appendChild(button("Exit ✕", "Close the annotation (Esc)", () => setActive(false), "", "close"));
    container.appendChild(toolbar);

    document.documentElement.appendChild(container);
    window.addEventListener("resize", () => container.style.display !== "none" && resize());
    resize();
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (active && e.key === "Escape") setActive(false);
    },
    true
  );

  function setActive(value) {
    buildUi();
    active = value;
    container.style.display = active ? "block" : "none";
    if (active) {
      resize();
      // Leave a trace on the timeline (if the steps log is enabled, the
      // bridge relays it to the offscreen document).
      try {
        window.postMessage(
          {
            [MARK]: {
              kind: "step",
              level: "info",
              t: Date.now(),
              text: "On-video annotation enabled",
            },
          },
          "*"
        );
      } catch (e) {
        /* no bridge: doesn't matter */
      }
    } else {
      clearCanvas();
      drawing = false;
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "annotate:toggle") {
        setActive(!active);
        sendResponse({ ok: true, active });
      }
      return false;
    });
  }
})();
