"use strict";

// Grabación de PANTALLA o VENTANA. Todo ocurre en esta ventana:
// chooseDesktopMedia y getUserMedia en el mismo frame, que es el único
// consumo del streamId que Chrome garantiza. Requiere capture-common.js.

const log = (...a) => console.log("[recorder]", ...a);

const timerEl = document.getElementById("timer");
const btnStop = document.getElementById("btnStop");

let recorder = null;
let chunks = [];
let displayStream = null;
let micStream = null;
let audioCtx = null;
let blobUrl = null;
let timerInterval = null;

function setView(state) {
  document.body.dataset.state = state; // picking | recording | saving
}

function toBackground(type, extra) {
  chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

// ---------- Mensajes (parar desde el popup o el atajo) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "recorder") return false;

  if (msg.type === "rec:stop") {
    stop();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "rec:cleanup") {
    const urls = msg.urls || (msg.url ? [msg.url] : []);
    for (const url of urls) {
      URL.revokeObjectURL(url);
      if (url === blobUrl) blobUrl = null;
    }
    if (urls.length) log("blob revocado tras la descarga");
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------- Selector ----------

log("solicitando selector de captura");
chrome.desktopCapture.chooseDesktopMedia(
  ["screen", "window", "audio"],
  async (streamId, opts) => {
    if (chrome.runtime.lastError) {
      log("selector devolvió error:", chrome.runtime.lastError.message);
      toBackground("rec:failed", {
        message: "Selector de captura: " + chrome.runtime.lastError.message,
      });
      return;
    }
    if (!streamId) {
      log("selector cancelado por el usuario");
      toBackground("rec:cancelled");
      return;
    }
    // Otra grabación pudo empezar mientras el selector estaba abierto.
    const { isRecording } = await chrome.storage.session.get({ isRecording: false });
    if (isRecording) {
      log("ya hay una grabación en curso; se cancela esta");
      toBackground("rec:cancelled");
      return;
    }
    try {
      await start(streamId, !!(opts && opts.canRequestAudioTrack));
    } catch (e) {
      log("error al iniciar:", e);
      cleanupStreams();
      toBackground("rec:failed", {
        message: "No se pudo iniciar la grabación: " + humanError(e),
      });
    }
  }
);

// ---------- Captura y grabación ----------

async function start(streamId, systemAudio) {
  const cfg = await chrome.storage.local.get({ mic: false, quality: "medium" });
  const q = QUALITY[cfg.quality] || QUALITY.medium;
  log("start", { systemAudio, mic: cfg.mic, quality: cfg.quality });

  displayStream = await navigator.mediaDevices.getUserMedia({
    audio: systemAudio
      ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
        maxFrameRate: q.frameRate,
      },
    },
  });
  log("captura obtenida:", displayStream.getTracks().map((t) => t.kind + " · " + t.label));

  let micTrack = null;
  if (cfg.mic) {
    try {
      // Al ser una ventana visible, el aviso de permiso puede mostrarse aquí.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micTrack = micStream.getAudioTracks()[0];
      log("micrófono:", micTrack.label);
    } catch (e) {
      log("micrófono no disponible:", e.name, e.message);
      toBackground("sw:warn", {
        message: "Grabando sin micrófono: " + humanError(e),
      });
    }
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  const sysTrack = displayStream.getAudioTracks()[0] || null;
  if (systemAudio && !sysTrack) {
    toBackground("sw:warn", {
      message:
        "Chrome no entregó audio del sistema (¿marcaste «Compartir audio» en el selector?). Se graba sin él.",
    });
  }

  // Pantalla/ventana: sin playthrough (el sonido del sistema no se silencia
  // al capturarlo; reinyectarlo lo duplicaría o crearía un bucle).
  const graph = buildAudioGraph(sysTrack, micTrack, false);
  audioCtx = graph.audioCtx;
  const combined = new MediaStream(
    graph.audioTrack ? [videoTrack, graph.audioTrack] : [videoTrack]
  );

  // "Dejar de compartir" en la barra de Chrome.
  videoTrack.addEventListener("ended", () => {
    log("compartición finalizada por el usuario");
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
    cleanupStreams();
    toBackground("rec:failed", { message: "Error del grabador: " + detail });
  };
  recorder.start(1000);
  log("grabando con", recorder.mimeType || "codec por defecto");

  // UI + cronómetro
  setView("recording");
  const startedAt = Date.now();
  const tick = () => {
    const t = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    const s = t % 60;
    timerEl.textContent =
      (h > 0 ? String(h).padStart(2, "0") + ":" : "") +
      String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  };
  tick();
  timerInterval = setInterval(tick, 500);

  toBackground("rec:started");

  // Se minimiza para no estorbar; el popup y el atajo siguen controlando.
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.update(win.id, { state: "minimized" });
  } catch (e) {
    log("no se pudo minimizar:", e);
  }
}

function stop() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function finalize() {
  clearInterval(timerInterval);
  setView("saving");
  log("finalizando;", chunks.length, "fragmentos");
  const type = (recorder && recorder.mimeType) || "video/webm";
  const blob = new Blob(chunks, { type });
  chunks = [];
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);

  toBackground("sw:complete", {
    from: "recorder",
    url: blobUrl,
    filename: `grabaciones-pantalla/grabacion-${stamp()}.webm`,
    bytes: blob.size,
  });
  cleanupStreams();
  // El service worker cierra esta ventana cuando la descarga termina.
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

btnStop.addEventListener("click", stop);
