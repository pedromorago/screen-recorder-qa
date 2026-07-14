// Service worker (Manifest V3).
// Dos flujos de captura:
//  - Pestaña actual: tabCapture.getMediaStreamId -> documento offscreen.
//  - Pantalla o ventana: ventana recorder.html, que abre el selector y graba
//    en su propio contexto (consumir el streamId en otro contexto falla).
// Estado en chrome.storage.session; el popup lo lee directamente.

"use strict";

importScripts("issue-reporter.js");

const OFFSCREEN_URL = "offscreen.html";
const log = (...a) => console.log("[SW]", ...a);

// ---------- Estado ----------

async function setRecordingState(recording, startTime = null, captureTarget = null) {
  await chrome.storage.session.set({
    isRecording: recording,
    startTime,
    captureTarget: recording ? captureTarget : null,
  });
  await chrome.action.setBadgeText({ text: recording ? "REC" : "" });
  if (recording) {
    await chrome.action.setBadgeBackgroundColor({ color: "#FF3B30" });
  }
}

// Aviso visible en el popup: { kind: "error"|"warn", text }
async function setNotice(kind, text) {
  await chrome.storage.session.set({
    notice: text ? { kind, text, at: Date.now() } : null,
  });
}

// ---------- Documento offscreen (flujo de pestaña) ----------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  log("creando documento offscreen");
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification: "Grabar la pestaña en segundo plano con MediaRecorder.",
  });
}

// Envío con reintentos: cubre el hueco entre crear un contexto
// y que su listener esté registrado.
async function sendTo(target, msg, attempts = 12) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.runtime.sendMessage({ ...msg, target });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(
    "El contexto «" + target + "» no responde" +
      (lastErr ? " (" + (lastErr.message || lastErr) + ")" : "")
  );
}

// ---------- Registros QA: consola y red (solo flujo de pestaña) ----------

const injectableUrl = (url) => /^https?:/.test(url || "");

// Wrappers en el mundo MAIN (ahí no hay chrome.runtime) + un puente en el
// mundo aislado que reenvía todo al offscreen.
async function injectQaCapture(tabId, { consoleCapture, networkCapture, stepsCapture }) {
  if (consoleCapture) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["console-capture-main.js"],
      world: "MAIN",
      injectImmediately: true,
    });
  }
  if (networkCapture) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["network-capture-main.js"],
      world: "MAIN",
      injectImmediately: true,
    });
  }
  if (stepsCapture) {
    // Los pasos del usuario se ven desde el mundo aislado: no necesita MAIN.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["steps-capture.js"],
      injectImmediately: true,
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["console-capture-bridge.js"],
    injectImmediately: true,
  });
  // La superficie de anotación va SIEMPRE en el flujo de pestaña (no
  // depende de los interruptores QA): dibuja DOM sobre la página y la
  // captura lo graba sin tocar el pipeline de vídeo.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["annotate-overlay.js"],
    injectImmediately: true,
  });
}

// Activa/desactiva la anotación sobre la pestaña grabada.
async function toggleAnnotate() {
  const { isRecording, captureTarget, recordedTabId } = await chrome.storage.session.get({
    isRecording: false,
    captureTarget: null,
    recordedTabId: null,
  });
  if (!isRecording || captureTarget !== "offscreen" || recordedTabId == null) return;
  try {
    await chrome.tabs.sendMessage(recordedTabId, { type: "annotate:toggle" });
  } catch (e) {
    log("no se pudo alternar la anotación:", e);
    await setNotice("warn", "No se pudo abrir la anotación en esta página.");
  }
}

// Marcador «aquí está el bug»: desde el atajo de teclado o el popup.
async function addMarker() {
  const { isRecording, captureTarget } = await chrome.storage.session.get({
    isRecording: false,
    captureTarget: null,
  });
  if (!isRecording || captureTarget !== "offscreen") return;
  try {
    await sendTo("offscreen", { type: "off:marker", t: Date.now() }, 2);
  } catch (e) {
    log("no se pudo añadir el marcador:", e);
  }
}

// Si la pestaña grabada navega, los content scripts desaparecen:
// se reinyectan en cuanto empieza a cargar el documento nuevo.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;
  const { isRecording, captureTarget, recordedTabId, consoleCapture, networkCapture, stepsCapture } =
    await chrome.storage.session.get({
      isRecording: false,
      captureTarget: null,
      recordedTabId: null,
      consoleCapture: false,
      networkCapture: false,
      stepsCapture: false,
    });
  if (!isRecording || captureTarget !== "offscreen" || tabId !== recordedTabId) return;
  if (!injectableUrl(tab.url)) return;
  try {
    await injectQaCapture(tabId, { consoleCapture, networkCapture, stepsCapture });
    log("registros QA reinyectados tras navegar", tab.url);
  } catch (e) {
    log("no se pudieron reinyectar los registros QA:", e);
  }
});

// ---------- Flujo 1: pestaña actual ----------

async function startTabRecording() {
  const { isRecording } = await chrome.storage.session.get({ isRecording: false });
  if (isRecording) {
    log("ya hay una grabación en curso; ignorado");
    return;
  }
  await setNotice(null);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error("no hay pestaña activa");
    log("solicitando streamId de la pestaña", tab.id);
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    const cfg = await chrome.storage.local.get({
      mic: false,
      quality: "medium",
      consoleLog: true,
      networkLog: true,
      stepsLog: true,
    });
    const injectable = injectableUrl(tab.url);
    const consoleCapture = cfg.consoleLog && injectable;
    const networkCapture = cfg.networkLog && injectable;
    const stepsCapture = cfg.stepsLog && injectable;
    await ensureOffscreen();
    // El offscreen solo responde ok:true cuando getUserMedia y
    // MediaRecorder han arrancado de verdad. Sin carreras de estado.
    const res = await sendTo("offscreen", {
      type: "off:start",
      streamId,
      systemAudio: true,
      mic: cfg.mic,
      quality: cfg.quality,
      consoleCapture,
      networkCapture,
      stepsCapture,
      tabUrl: tab.url,
      tabTitle: tab.title,
    });
    if (!res || !res.ok) {
      throw new Error((res && res.error) || "el offscreen no confirmó el inicio");
    }
    await setRecordingState(true, Date.now(), "offscreen");
    await chrome.storage.session.set({
      recordedTabId: tab.id,
      consoleCapture,
      networkCapture,
      stepsCapture,
    });
    log("grabación de pestaña iniciada");

    if (injectable) {
      try {
        // Aunque los tres interruptores estén apagados se inyecta igual:
        // la superficie de anotación no depende de ellos.
        await injectQaCapture(tab.id, { consoleCapture, networkCapture, stepsCapture });
        log("registros QA activos en la pestaña", tab.id, {
          consoleCapture,
          networkCapture,
          stepsCapture,
        });
      } catch (e) {
        log("no se pudieron inyectar los registros QA:", e);
        await setNotice(
          "warn",
          "Se graba el vídeo, pero no se pudieron activar los registros QA ni la anotación en esta página."
        );
      }
    } else if (cfg.consoleLog || cfg.networkLog || cfg.stepsLog) {
      await setNotice(
        "warn",
        "Los registros QA (consola, red, pasos) y la anotación solo funcionan en páginas http(s); esta grabación irá sin ellos."
      );
    }
  } catch (e) {
    log("no se pudo iniciar la captura de pestaña:", e);
    await setNotice(
      "error",
      "No se pudo grabar esta pestaña: " +
        (e.message || e) +
        ". Las páginas internas de Chrome (chrome://, Web Store) no se pueden grabar; prueba con «Pantalla o ventana»."
    );
    await setRecordingState(false);
  }
}

// ---------- Flujo 2: pantalla o ventana (ventana recorder) ----------

async function startScreenRecording() {
  const { isRecording, recorderWindowId } = await chrome.storage.session.get({
    isRecording: false,
    recorderWindowId: null,
  });
  if (isRecording) {
    log("ya hay una grabación en curso; ignorado");
    return;
  }
  // Si ya hay una ventana de grabación abierta, se trae al frente.
  if (recorderWindowId) {
    try {
      await chrome.windows.update(recorderWindowId, { focused: true, state: "normal" });
      log("ventana de grabación ya abierta; enfocada");
      return;
    } catch (e) {
      await chrome.storage.session.set({ recorderWindowId: null });
    }
  }
  await setNotice(null);
  log("abriendo ventana de grabación");

  // Tamaño suficiente para que el diálogo nativo (modal DENTRO de esta
  // ventana) se vea entero, y centrado sobre la ventana activa.
  const width = 640;
  const height = 720;
  let left, top;
  try {
    const cur = await chrome.windows.getLastFocused();
    if (cur && cur.width != null) {
      left = Math.max(0, Math.round(cur.left + (cur.width - width) / 2));
      top = Math.max(0, Math.round(cur.top + (cur.height - height) / 2));
    }
  } catch (e) {
    /* sin centrado */
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("recorder.html"),
    type: "popup",
    width,
    height,
    left,
    top,
    focused: true,
  });
  await chrome.storage.session.set({ recorderWindowId: win.id });
}

async function closeRecorderWindow() {
  const { recorderWindowId } = await chrome.storage.session.get({ recorderWindowId: null });
  if (!recorderWindowId) return;
  await chrome.storage.session.set({ recorderWindowId: null });
  try {
    await chrome.windows.remove(recorderWindowId);
  } catch (e) {
    /* ya estaba cerrada */
  }
}

// ---------- Issue en Jira/Linear al terminar ----------

// Si hay proveedor configurado (options.html) con auto-crear activo, sube
// el informe como issue nuevo y deja el enlace en el aviso del popup.
async function reportIssueIfConfigured(informe) {
  const { issueReporter } = await chrome.storage.local.get({ issueReporter: null });
  if (!issueReporter || issueReporter.provider === "none" || !issueReporter.autoCreate) return;
  const nombre = issueReporter.provider === "jira" ? "Jira" : "Linear";
  try {
    const res = await createIssueFromReport(issueReporter, informe.title, informe.text);
    log("issue creado:", res.key, res.url);
    await setNotice("ok", `Issue creado en ${nombre}: ${res.key} — ${res.url}`);
  } catch (e) {
    log("no se pudo crear el issue:", e);
    await setNotice(
      "error",
      `El vídeo y los informes se guardaron, pero no se pudo crear el issue en ${nombre}: ` +
        (e.message || e)
    );
  }
}

// ---------- Parar ----------

async function stopRecording() {
  const { isRecording, captureTarget } = await chrome.storage.session.get({
    isRecording: false,
    captureTarget: null,
  });
  if (!isRecording) return;
  log("parando grabación en", captureTarget);
  try {
    if (captureTarget === "recorder") {
      await sendTo("recorder", { type: "rec:stop" }, 5);
    } else {
      await sendTo("offscreen", { type: "off:stop" }, 5);
    }
  } catch (e) {
    log("el contexto de captura no responde al parar:", e);
    await setNotice("error", "La grabación se perdió: el proceso de captura no responde.");
    await setRecordingState(false);
  }
}

// ---------- Mensajes ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "background") return false;

  switch (msg.type) {
    case "popup:startTab":
      startTabRecording().catch((e) => log("startTabRecording:", e));
      break;

    case "popup:startScreen":
      startScreenRecording().catch((e) => log("startScreenRecording:", e));
      break;

    case "popup:stop":
      stopRecording().catch((e) => log("stopRecording:", e));
      break;

    case "popup:marker":
      addMarker().catch((e) => log("addMarker:", e));
      break;

    case "popup:annotate":
      toggleAnnotate().catch((e) => log("toggleAnnotate:", e));
      break;

    case "rec:started":
      (async () => {
        await setRecordingState(true, Date.now(), "recorder");
        log("grabación de pantalla iniciada");
      })().catch((e) => log("rec:started:", e));
      break;

    case "rec:cancelled":
      log("grabación de pantalla cancelada");
      closeRecorderWindow().catch((e) => log("rec:cancelled:", e));
      break;

    case "rec:failed":
      (async () => {
        log("fallo en la ventana de grabación:", msg.message);
        await setNotice("error", msg.message);
        await setRecordingState(false);
        await closeRecorderWindow();
      })().catch((e) => log("rec:failed:", e));
      break;

    case "sw:complete":
      (async () => {
        // El offscreen manda files[] (vídeo + registros de consola);
        // el recorder sigue mandando url/filename sueltos.
        const files = msg.files || [{ url: msg.url, filename: msg.filename }];
        log(
          "grabación completa (" + msg.from + "):",
          files.map((f) => f.filename).join(", "),
          msg.bytes,
          "bytes de vídeo"
        );
        const ids = [];
        const urls = [];
        let fallidas = 0;
        for (const f of files) {
          try {
            const id = await chrome.downloads.download({
              url: f.url,
              filename: f.filename,
              saveAs: false,
            });
            ids.push(id);
            urls.push(f.url);
          } catch (e) {
            fallidas++;
            log("no se pudo descargar", f.filename, e);
          }
        }
        if (ids.length) {
          // GRUPOS de descargas: si el usuario encadena grabaciones, las
          // descargas de la anterior pueden seguir en vuelo. Cada grupo se
          // limpia por separado cuando TODAS sus descargas terminan.
          const { pendingDownloads } = await chrome.storage.session.get({
            pendingDownloads: null,
          });
          const groups = (pendingDownloads && pendingDownloads.groups) || [];
          groups.push({ ids, urls, from: msg.from || "offscreen" });
          await chrome.storage.session.set({ pendingDownloads: { groups } });
        }
        if (fallidas) {
          await setNotice(
            "error",
            `No se pudieron guardar ${fallidas} de ${files.length} ficheros de la grabación.`
          );
          if (!ids.length && (msg.from || "offscreen") === "recorder") {
            await closeRecorderWindow();
          }
        }
        await setRecordingState(false);
        if (msg.informe) {
          // No bloquea las descargas: crea el issue en segundo plano.
          reportIssueIfConfigured(msg.informe).catch((e) => log("issue:", e));
        }
      })().catch((e) => {
        log("error al descargar:", e);
        setNotice("error", "No se pudo guardar el archivo: " + (e.message || e));
        setRecordingState(false);
        if (msg.from === "recorder") closeRecorderWindow();
      });
      break;

    case "sw:error":
      log("error desde la captura:", msg.message);
      setNotice("error", msg.message);
      setRecordingState(false);
      break;

    case "sw:warn":
      log("aviso desde la captura:", msg.message);
      setNotice("warn", msg.message);
      break;
  }
  return false;
});

// Cuando TODAS las descargas de la grabación terminan: revocar los blobs y
// cerrar el contexto de captura para liberar la grabación de la memoria.
// Los eventos se procesan en serie para no pisar el estado compartido si
// dos descargas (vídeo + logs) acaban casi a la vez.
let downloadEventQueue = Promise.resolve();
chrome.downloads.onChanged.addListener((delta) => {
  downloadEventQueue = downloadEventQueue
    .then(() => handleDownloadChanged(delta))
    .catch((e) => log("error gestionando fin de descarga:", e));
});

async function handleDownloadChanged(delta) {
  const { pendingDownloads, isRecording } = await chrome.storage.session.get({
    pendingDownloads: null,
    isRecording: false,
  });
  const groups = (pendingDownloads && pendingDownloads.groups) || [];
  const group = groups.find((g) => g.ids.includes(delta.id));
  if (!group) return;
  const state = delta.state && delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;

  group.ids = group.ids.filter((id) => id !== delta.id);
  const remainingGroups = groups.filter((g) => g.ids.length);
  log("descarga finalizada:", state, "· quedan", group.ids.length, "en su grupo");
  await chrome.storage.session.set({
    pendingDownloads: remainingGroups.length ? { groups: remainingGroups } : null,
  });
  if (group.ids.length) return;

  // El grupo terminó: liberar sus blobs y cerrar su contexto si procede.
  if (group.from === "recorder") {
    try {
      await sendTo("recorder", { type: "rec:cleanup", urls: group.urls }, 2);
    } catch (e) {
      /* ya no existe */
    }
    await closeRecorderWindow();
  } else {
    try {
      await sendTo("offscreen", { type: "off:cleanup", urls: group.urls }, 2);
    } catch (e) {
      /* ya no existe */
    }
    // Solo se cierra el documento si no hay otra grabación en marcha NI
    // otros grupos de descargas del offscreen en vuelo.
    const offscreenPending = remainingGroups.some((g) => g.from !== "recorder");
    if (!isRecording && !offscreenPending && (await hasOffscreen())) {
      try {
        await chrome.offscreen.closeDocument();
        log("documento offscreen cerrado");
      } catch (e) {
        log("no se pudo cerrar el offscreen:", e);
      }
    }
  }
}

// Si el usuario cierra la ventana de grabación a mano.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { recorderWindowId, isRecording, captureTarget } =
    await chrome.storage.session.get({
      recorderWindowId: null,
      isRecording: false,
      captureTarget: null,
    });
  if (recorderWindowId !== windowId) return;

  log("ventana de grabación cerrada");
  await chrome.storage.session.set({ recorderWindowId: null });
  if (isRecording && captureTarget === "recorder") {
    await setRecordingState(false);
    await setNotice(
      "error",
      "La ventana de grabación se cerró y la grabación en curso se perdió. Para guardar, usa «Parar» en el popup o el atajo."
    );
  }
});

// Atajos de teclado. toggle-recording: para si está grabando; si no, abre
// el flujo de pantalla/ventana (funciona en cualquier página, incluidas
// chrome://). add-marker: marcador de bug en la grabación de pestaña.
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "add-marker") {
    addMarker().catch((e) => log("addMarker:", e));
    return;
  }
  if (command === "toggle-annotate") {
    toggleAnnotate().catch((e) => log("toggleAnnotate:", e));
    return;
  }
  if (command !== "toggle-recording") return;
  const { isRecording } = await chrome.storage.session.get({ isRecording: false });
  isRecording ? stopRecording() : startScreenRecording();
});

// Estado limpio al instalar o arrancar el navegador.
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  log("extensión instalada/actualizada");
});
chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
