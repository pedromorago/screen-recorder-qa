"use strict";

// Documento offscreen: graba la PESTAÑA actual a partir del streamId de
// chrome.tabCapture. La grabación de pantalla/ventana vive en recorder.js.
// Requiere capture-common.js cargado antes.

const log = (...a) => console.log("[offscreen]", ...a);

let recorder = null;
let chunks = [];
let displayStream = null;
let micStream = null;
let audioCtx = null;
let blobUrls = [];

// Registro de consola (modo QA). Se acumula aquí y no en el service worker
// porque este documento vive toda la grabación y el SW puede morir.
const MAX_CONSOLE_ENTRIES = 10_000;
let consoleEnabled = false;
let consoleMeta = null; // { url, title }
let consoleEntries = [];
let consoleDropped = 0;
let videoStartTime = null;

function toBackground(type, extra) {
  chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

// ---------- Mensajes ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "off:start") {
    start(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        log("error al iniciar:", e);
        cleanupStreams();
        sendResponse({ ok: false, error: humanError(e) });
      });
    return true; // respuesta asíncrona
  }

  if (msg.type === "off:stop") {
    stop();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "off:cleanup") {
    const urls = msg.urls || (msg.url ? [msg.url] : []);
    for (const url of urls) {
      URL.revokeObjectURL(url);
      blobUrls = blobUrls.filter((u) => u !== url);
    }
    if (urls.length) log("blobs revocados tras la descarga:", urls.length);
    sendResponse({ ok: true });
    return false;
  }

  // Lotes de entradas desde console-capture-bridge.js (pestaña grabada).
  if (msg.type === "off:consoleEntries") {
    if (consoleEnabled && recorder && Array.isArray(msg.entries)) {
      const room = MAX_CONSOLE_ENTRIES - consoleEntries.length;
      if (room >= msg.entries.length) {
        consoleEntries.push(...msg.entries);
      } else {
        if (room > 0) consoleEntries.push(...msg.entries.slice(0, room));
        consoleDropped += msg.entries.length - Math.max(room, 0);
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------- Captura de pestaña ----------

async function start({ streamId, systemAudio, mic, quality, consoleCapture, tabUrl, tabTitle }) {
  const q = QUALITY[quality] || QUALITY.medium;
  log("start", { systemAudio, mic, quality, consoleCapture });

  consoleEnabled = !!consoleCapture;
  consoleMeta = { url: tabUrl || "", title: tabTitle || "" };
  consoleEntries = [];
  consoleDropped = 0;

  // streamId de tabCapture: se consume como chromeMediaSource "tab".
  displayStream = await navigator.mediaDevices.getUserMedia({
    audio: systemAudio
      ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: q.frameRate,
      },
    },
  });
  log("captura obtenida:", displayStream.getTracks().map((t) => t.kind + " · " + t.label));

  // Micrófono, opcional. Si falla, se sigue grabando y se avisa.
  let micTrack = null;
  if (mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micTrack = micStream.getAudioTracks()[0];
      log("micrófono:", micTrack.label);
    } catch (e) {
      log("micrófono no disponible:", e.name, e.message);
      toBackground("sw:warn", {
        message:
          "Grabando sin micrófono: " +
          humanError(e) +
          " Concede el permiso desde el popup (interruptor de micrófono).",
      });
    }
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  const sysTrack = displayStream.getAudioTracks()[0] || null;
  if (systemAudio && !sysTrack) {
    toBackground("sw:warn", {
      message: "Chrome no entregó la pista de audio de la pestaña; se graba sin ella.",
    });
  }

  // Chrome silencia la pestaña capturada: playthrough siempre.
  const graph = buildAudioGraph(sysTrack, micTrack, true);
  audioCtx = graph.audioCtx;
  const combined = new MediaStream(
    graph.audioTrack ? [videoTrack, graph.audioTrack] : [videoTrack]
  );

  videoTrack.addEventListener("ended", () => {
    log("captura finalizada por el usuario");
    stop();
  });

  const mimeType = pickMime();
  chunks = [];
  recorder = new MediaRecorder(
    combined,
    mimeType
      ? { mimeType, videoBitsPerSecond: q.videoBitsPerSecond }
      : { videoBitsPerSecond: q.videoBitsPerSecond }
  );
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = finalize;
  recorder.onerror = (e) => {
    const detail = (e.error && e.error.message) || "desconocido";
    log("MediaRecorder error:", detail);
    toBackground("sw:error", { message: "Error del grabador: " + detail });
    cleanupStreams();
  };
  recorder.start(1000);
  videoStartTime = Date.now(); // t0 de los offsets del registro de consola
  log("grabando con", recorder.mimeType || "codec por defecto");
}

function stop() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function finalize() {
  log("finalizando;", chunks.length, "fragmentos");
  const type = (recorder && recorder.mimeType) || "video/webm";
  const blob = new Blob(chunks, { type });
  chunks = [];
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls = [];

  const base = `grabaciones-pantalla/grabacion-${stamp()}`;
  const files = [{ url: track(blob), filename: `${base}.webm`, bytes: blob.size }];

  if (consoleEnabled) {
    const { text, json } = buildConsoleReport();
    files.push(
      { url: track(new Blob([text], { type: "text/plain" })), filename: `${base}.console.log` },
      { url: track(new Blob([json], { type: "application/json" })), filename: `${base}.console.json` }
    );
    log("registro de consola:", consoleEntries.length, "entradas");
  }

  toBackground("sw:complete", { from: "offscreen", files, bytes: blob.size });
  consoleEnabled = false;
  cleanupStreams();
}

function track(blob) {
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  return url;
}

// ---------- Registro de consola: ficheros de salida ----------

// Offset respecto al inicio del vídeo, como "+mm:ss.mmm".
function offset(t) {
  const ms = Math.max(0, t - (videoStartTime || t));
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  return `+${pad(m)}:${pad(s)}.${String(ms % 1000).padStart(3, "0")}`;
}

function buildConsoleReport() {
  const startedAt = new Date(videoStartTime || Date.now()).toISOString();
  const header =
    "# Registro de consola — Grabador de pantalla (modo QA)\n" +
    `# Página: ${consoleMeta.title || "(sin título)"} — ${consoleMeta.url}\n` +
    `# Inicio del vídeo: ${startedAt}\n` +
    `# Navegador: ${navigator.userAgent}\n` +
    `# ${consoleEntries.length} entradas` +
    (consoleDropped ? ` (${consoleDropped} descartadas por límite)` : "") +
    "\n\n";

  const text =
    header +
    (consoleEntries.length
      ? consoleEntries
          .map((e) => {
            const label = e.kind === "nav" ? "NAV" : (e.level || "log").toUpperCase();
            return `[${offset(e.t)}] ${label.padEnd(5)} ${e.text}`;
          })
          .join("\n") + "\n"
      : "(sin entradas de consola durante la grabación)\n");

  const json = JSON.stringify(
    {
      meta: {
        url: consoleMeta.url,
        title: consoleMeta.title,
        videoStart: startedAt,
        userAgent: navigator.userAgent,
        entries: consoleEntries.length,
        dropped: consoleDropped,
      },
      // offsetMs: milisegundos desde el inicio del vídeo.
      entries: consoleEntries.map((e) => ({
        offsetMs: Math.max(0, e.t - (videoStartTime || e.t)),
        offset: offset(e.t),
        kind: e.kind,
        level: e.level,
        text: e.text,
      })),
    },
    null,
    2
  );

  return { text, json };
}

function cleanupStreams() {
  [displayStream, micStream].forEach(
    (s) => s && s.getTracks().forEach((t) => t.stop())
  );
  displayStream = micStream = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  recorder = null;
}
