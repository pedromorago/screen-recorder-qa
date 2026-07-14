"use strict";

// SCREEN or WINDOW recording. Everything happens in this window:
// chooseDesktopMedia and getUserMedia in the same frame, the only
// streamId consumption Chrome guarantees. Requires capture-common.js.

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

// ---------- Messages (stop from the popup or the shortcut) ----------

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
    if (urls.length) log("blob revoked after download");
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------- Picker ----------

log("requesting capture picker");
chrome.desktopCapture.chooseDesktopMedia(
  ["screen", "window", "audio"],
  async (streamId, opts) => {
    if (chrome.runtime.lastError) {
      log("picker returned an error:", chrome.runtime.lastError.message);
      toBackground("rec:failed", {
        message: "Capture picker: " + chrome.runtime.lastError.message,
      });
      return;
    }
    if (!streamId) {
      log("picker cancelled by the user");
      toBackground("rec:cancelled");
      return;
    }
    // Another recording may have started while the picker was open.
    const { isRecording } = await chrome.storage.session.get({ isRecording: false });
    if (isRecording) {
      log("a recording is already in progress; cancelling this one");
      toBackground("rec:cancelled");
      return;
    }
    try {
      await start(streamId, !!(opts && opts.canRequestAudioTrack));
    } catch (e) {
      log("failed to start:", e);
      cleanupStreams();
      toBackground("rec:failed", {
        message: "Could not start the recording: " + humanError(e),
      });
    }
  }
);

// ---------- Capture and recording ----------

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
  log("capture obtained:", displayStream.getTracks().map((t) => t.kind + " · " + t.label));

  let micTrack = null;
  if (cfg.mic) {
    try {
      // Being a visible window, the permission prompt can be shown here.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micTrack = micStream.getAudioTracks()[0];
      log("microphone:", micTrack.label);
    } catch (e) {
      log("microphone unavailable:", e.name, e.message);
      toBackground("sw:warn", {
        message: "Recording without microphone: " + humanError(e),
      });
    }
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  const sysTrack = displayStream.getAudioTracks()[0] || null;
  if (systemAudio && !sysTrack) {
    toBackground("sw:warn", {
      message:
        "Chrome did not deliver system audio (did you check 'Share audio' in the picker?). Recording without it.",
    });
  }

  // Screen/window: no playthrough (system sound is not muted while being
  // captured; re-injecting it would duplicate it or create a loop).
  const graph = buildAudioGraph(sysTrack, micTrack, false);
  audioCtx = graph.audioCtx;
  const combined = new MediaStream(
    graph.audioTrack ? [videoTrack, graph.audioTrack] : [videoTrack]
  );

  // "Stop sharing" in Chrome's bar.
  videoTrack.addEventListener("ended", () => {
    log("sharing ended by the user");
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
    const detail = (e.error && e.error.message) || "unknown";
    log("MediaRecorder error:", detail);
    cleanupStreams();
    toBackground("rec:failed", { message: "Recorder error: " + detail });
  };
  recorder.start(1000);
  log("recording with", recorder.mimeType || "default codec");

  // UI + timer
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

  // Minimized to stay out of the way; the popup and shortcut still control it.
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.update(win.id, { state: "minimized" });
  } catch (e) {
    log("could not minimize:", e);
  }
}

function stop() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function finalize() {
  clearInterval(timerInterval);
  setView("saving");
  log("finalizing;", chunks.length, "chunks");
  const type = (recorder && recorder.mimeType) || "video/webm";
  const blob = new Blob(chunks, { type });
  chunks = [];
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);

  toBackground("sw:complete", {
    from: "recorder",
    url: blobUrl,
    filename: `screen-recordings/recording-${stamp()}.webm`,
    bytes: blob.size,
  });
  cleanupStreams();
  // The service worker closes this window once the download finishes.
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
