"use strict";

// Se inyecta en el mundo AISLADO de la pestaña grabada: los pasos del
// usuario (clicks, cambios de campo, envíos de formulario) se ven igual
// desde cualquier mundo, así que no hace falta world MAIN. Publica por el
// mismo canal postMessage que los scripts MAIN y console-capture-bridge.js
// lo reenvía al offscreen.
//
// PRIVACIDAD: nunca se registra el VALOR de un campo, solo qué campo
// cambió. Un reporte de bug no necesita la contraseña del tester.

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
      /* página cerrándose */
    }
  }

  const clip = (s) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s);

  // Descripción de un elemento SIN su valor: <button#enviar «Enviar»>.
  function describeEl(el) {
    if (!el || !el.tagName) return "(elemento desconocido)";
    const tag = el.tagName.toLowerCase();
    let ident = "";
    if (el.id) ident = "#" + el.id;
    else if (el.getAttribute && el.getAttribute("name"))
      ident = "[name=" + el.getAttribute("name") + "]";
    else if (el.classList && el.classList.length) ident = "." + el.classList[0];

    const isField = tag === "input" || tag === "textarea" || tag === "select";
    // textContent pre-recortado y no innerText: innerText fuerza layout y
    // en un click sobre un contenedor grande costaría un reflujo entero.
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
    const tipo = isField && el.type ? " tipo=" + el.type : "";
    return "<" + tag + ident + tipo + (label ? " «" + label + "»" : "") + ">";
  }

  // Click: se atribuye al elemento interactivo más cercano, no al span
  // decorativo donde cayó el puntero.
  document.addEventListener(
    "click",
    (e) => {
      const el =
        (e.target.closest &&
          e.target.closest(
            "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[onclick]"
          )) ||
        e.target;
      post("Click en " + describeEl(el));
    },
    true
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      post("Cambio en " + describeEl(el) + " (valor no registrado)");
    },
    true
  );

  document.addEventListener(
    "submit",
    (e) => {
      post("Envío del formulario " + describeEl(e.target));
    },
    true
  );
})();
