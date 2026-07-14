"use strict";

// Injected into the ISOLATED world of the recorded tab: user steps
// (clicks, field changes, form submits) look the same from any world, so
// no MAIN world is needed. It publishes through the same postMessage
// channel as the MAIN-world scripts and console-capture-bridge.js relays
// everything to the offscreen document.
//
// PRIVACY: a field's VALUE is never recorded, only which field changed.
// A bug report does not need the tester's password.

(() => {
  if (window.__qaRecorderStepsInstalled) return;
  window.__qaRecorderStepsInstalled = true;

  const MARK = "__qaRecorderConsole";
  const MAX_LABEL = 60;

  function post(text) {
    try {
      window.postMessage(
        { [MARK]: { kind: "step", level: "info", t: Date.now(), text } },
        "*"
      );
    } catch (e) {
      /* page tearing down */
    }
  }

  const clip = (s) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s);

  // Description of an element WITHOUT its value: <button#send «Send»>.
  function describeEl(el) {
    if (!el || !el.tagName) return "(unknown element)";
    const tag = el.tagName.toLowerCase();
    let ident = "";
    if (el.id) ident = "#" + el.id;
    else if (el.getAttribute && el.getAttribute("name"))
      ident = "[name=" + el.getAttribute("name") + "]";
    else if (el.classList && el.classList.length) ident = "." + el.classList[0];

    const isField = tag === "input" || tag === "textarea" || tag === "select";
    // Pre-sliced textContent rather than innerText: innerText forces
    // layout, and on a click over a large container that would cost a
    // full reflow.
    const label = clip(
      (
        (el.getAttribute && el.getAttribute("aria-label")) ||
        (isField ? "" : (el.textContent || "").slice(0, 300)) ||
        (el.getAttribute && el.getAttribute("placeholder")) ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
    );
    const type = isField && el.type ? " type=" + el.type : "";
    return "<" + tag + ident + type + (label ? " «" + label + "»" : "") + ">";
  }

  // Click: attributed to the closest interactive element, not to the
  // decorative span the pointer happened to land on.
  document.addEventListener(
    "click",
    (e) => {
      // Clicks on the annotation surface are drawing gestures, not user
      // steps on the page.
      if (e.target.closest && e.target.closest("#qa-recorder-annotate")) return;
      const el =
        (e.target.closest &&
          e.target.closest(
            "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[onclick]"
          )) ||
        e.target;
      post("Click on " + describeEl(el));
    },
    true
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      post("Change in " + describeEl(el) + " (value not recorded)");
    },
    true
  );

  document.addEventListener(
    "submit",
    (e) => {
      post("Form submitted " + describeEl(e.target));
    },
    true
  );
})();
