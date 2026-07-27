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

  function post(text, sel) {
    try {
      const entry = { kind: "step", level: "info", t: Date.now(), text };
      if (sel) entry.sel = sel;
      window.postMessage({ [MARK]: entry }, "*");
    } catch (e) {
      /* page tearing down */
    }
  }

  const clip = (s) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s);

  // ---------- Test selector (Cypress or Playwright flavor) ----------

  const TEST_ATTRS = ["data-cy", "data-test", "data-testid"];
  const CONTAINABLE = ["a", "button", "label", "summary"];
  // ARIA widgets whose accessible name is their text: allowed into the
  // text path alongside the classic tags.
  const TEXT_ROLES = ["button", "link", "tab", "menuitem"];
  // Same limit as MAX_LABEL: a real recording lost the selector of a
  // 44-char crossword clue when this sat at 40.
  const MAX_CONTAINS = 60;

  // String literal for a pasteable JS command.
  const jsStr = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  // String inside a CSS [attr="…"] selector.
  const attrVal = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  };

  // Output flavor, configurable in the extension's Options. This script
  // runs in the ISOLATED world, which does have chrome.storage: it reads
  // the value itself and keeps it fresh via onChanged, because it stays
  // installed in the page across recordings and cannot re-read at
  // injection time. Guarded: the Cypress harness injects this file into
  // plain pages with no chrome.* at all (the default then stands).
  let flavor = "cypress";
  try {
    chrome.storage.local.get({ selectorFlavor: "cypress" }, (cfg) => {
      if (cfg && cfg.selectorFlavor) flavor = cfg.selectorFlavor;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.selectorFlavor) {
        flavor = changes.selectorFlavor.newValue || "cypress";
      }
    });
  } catch (e) {
    /* no chrome.storage on this page: keep the default */
  }

  // The chain in selectorFor decides WHICH handle identifies the element;
  // these only decide how to SPELL it in the configured flavor.
  const pw = () => flavor === "playwright";
  const fmtCss = (sel) => (pw() ? "page.locator(" : "cy.get(") + jsStr(sel) + ")";
  const fmtAttr = (attr, v) =>
    pw() && attr === "data-testid"
      ? "page.getByTestId(" + jsStr(v) + ")" // the one attribute getByTestId covers
      : fmtCss("[" + attr + "=" + attrVal(v) + "]");
  const fmtAria = (label) =>
    pw() ? "page.getByLabel(" + jsStr(label) + ")" : fmtCss("[aria-label=" + attrVal(label) + "]");
  // containerSel narrows WHERE the text counts ('button', '[role="tab"]',
  // 'yt-tab-shape'); role is the validated ARIA role, "" if none.
  const IMPLICIT_ROLE = { button: "button", a: "link" };
  const fmtText = (containerSel, role, tag, text) => {
    if (!pw()) return "cy.contains(" + jsStr(containerSel) + ", " + jsStr(text) + ")";
    const pwRole = role || IMPLICIT_ROLE[tag] || "";
    if (pwRole) return "page.getByRole(" + jsStr(pwRole) + ", { name: " + jsStr(text) + " })";
    // A custom element is a real scope worth keeping; a plain tag is not.
    return tag.includes("-")
      ? "page.locator(" + jsStr(containerSel) + ", { hasText: " + jsStr(text) + " })"
      : "page.getByText(" + jsStr(text) + ")";
  };

  // Paste-ready selector in the configured flavor (Cypress by default,
  // Playwright optional), following the priority the Cypress docs
  // recommend: test attributes first, then id/name/aria-label (only
  // while unique in THIS document — duplicate ids exist in the wild),
  // then the visible text, then a short structural path as the
  // documented last resort. Returns "" when nothing reliable exists:
  // a missing selector beats a wrong one in a bug report.
  function selectorFor(el) {
    if (!el || !el.getAttribute || !el.tagName) return "";
    const tag = el.tagName.toLowerCase();

    // Test attributes are the app's own contract: returned without a
    // uniqueness check, because a duplicated data-cy is the app's bug and
    // the report should surface it, not silently route around it.
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) return fmtAttr(attr, v);
    }

    if (el.id && unique("#" + CSS.escape(el.id))) {
      return fmtCss("#" + CSS.escape(el.id));
    }
    const name = el.getAttribute("name");
    if (name) {
      const sel = tag + "[name=" + attrVal(name) + "]";
      if (unique(sel)) return fmtCss(sel);
    }

    // aria-label: markup, stable, and often the only handle on icon
    // buttons whose visible text is dynamic (a running timer once made a
    // cy.contains selector that could never match again).
    const aria = el.getAttribute("aria-label");
    if (aria) {
      const sel = "[aria-label=" + attrVal(aria) + "]";
      if (unique(sel)) return fmtAria(aria);
    }

    // Visible text, only for elements whose text IS their identity and only
    // when it singles them out. Long text is skipped, not clipped: a
    // clipped needle would still match, but nobody keeps it in a test.
    // Besides the classic tags: ARIA widgets (role=button/link/tab/
    // menuitem) and custom elements — YouTube's <yt-tab-shape> tabs were
    // walking away with nth-of-type paths while carrying a perfect text
    // identity.
    const role = TEXT_ROLES.includes(el.getAttribute("role")) ? el.getAttribute("role") : "";
    const containerSel = CONTAINABLE.includes(tag)
      ? tag
      : role
        ? '[role="' + role + '"]'
        : tag.includes("-")
          ? tag
          : "";
    if (containerSel) {
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (text && text.length <= MAX_CONTAINS) {
        const same = Array.prototype.filter.call(
          document.querySelectorAll(containerSel),
          (n) => (n.textContent || "").includes(text)
        );
        if (same.length === 1) return fmtText(containerSel, role, tag, text);
      }
    }

    // Structural path, anchored at the nearest ancestor with a unique id
    // and bounded: past 5 levels a selector stops being something anyone
    // would keep in a test.
    const parts = [];
    let node = el;
    while (node && node.tagName && parts.length < 5) {
      const t = node.tagName.toLowerCase();
      if (t === "html") break;
      if (node.id && unique("#" + CSS.escape(node.id))) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let part = t;
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(
          parent.children,
          (c) => c.tagName === node.tagName
        );
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (Array.prototype.indexOf.call(siblings, node) + 1) + ")";
        }
      }
      parts.unshift(part);
      if (t === "body") break;
      node = parent;
    }
    const sel = parts.join(" > ");
    return sel && unique(sel) ? fmtCss(sel) : "";
  }

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
      post("Click on " + describeEl(el), selectorFor(el));
    },
    true
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      post("Change in " + describeEl(el) + " (value not recorded)", selectorFor(el));
    },
    true
  );

  document.addEventListener(
    "submit",
    (e) => {
      post("Form submitted " + describeEl(e.target), selectorFor(e.target));
    },
    true
  );
})();
