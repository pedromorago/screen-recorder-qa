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
let blobUrls = [];
let timerInterval = null;
// See offscreen.js: tells "already saving" apart from "died without saving".
let finalizePending = false;
// Optional separate audio file (see the twin in offscreen.js).
let audioCapture = null;

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
    // Same contract as off:stop: report whether a save is really under way.
    sendResponse({ ok: true, stopping: stopCapture() });
    return false;
  }

  if (msg.type === "rec:cleanup") {
    const urls = msg.urls || (msg.url ? [msg.url] : []);
    for (const url of urls) {
      URL.revokeObjectURL(url);
      blobUrls = blobUrls.filter((u) => u !== url);
    }
    if (urls.length) log("blobs revoked after download:", urls.length);
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
  const cfg = await chrome.storage.local.get({ mic: false, quality: "medium", audioFile: false });
  const q = QUALITY[cfg.quality] || QUALITY.medium;
  log("start", { systemAudio, mic: cfg.mic, audioFile: cfg.audioFile, quality: cfg.quality });
  finalizePending = false;
  audioCapture = null;

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
    stopCapture();
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

  // Separate audio file: second recorder on the mixed track, started after
  // the video one (see the twin in offscreen.js).
  if (cfg.audioFile && graph.audioTrack) {
    audioCapture = startAudioRecorder(graph.audioTrack, (message) =>
      toBackground("sw:warn", { message })
    );
    if (audioCapture) log("separate audio file with", audioCapture.mimeType);
  } else if (cfg.audioFile) {
    toBackground("sw:warn", {
      message:
        "This recording has no audio track (no system audio or microphone); the separate audio file is skipped.",
    });
  }

  // UI + timer
  setView("recording");
  const startedAt = Date.now();
  const tick = () => (timerEl.textContent = formatElapsed(Date.now() - startedAt));
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

// Named stopCapture (not stop) to avoid shadowing window.stop().
// Returns whether a save is under way (see the twin in offscreen.js).
function stopCapture() {
  if (recorder && recorder.state !== "inactive") {
    finalizePending = true;
    // Audio first: both flushes run while finalize() awaits the video's.
    if (audioCapture && audioCapture.rec.state !== "inactive") audioCapture.rec.stop();
    recorder.stop();
    return true;
  }
  if (finalizePending) return true;
  // Nothing to save: release the tracks so the capture does not leak
  // (see the twin in offscreen.js).
  cleanupStreams();
  return false;
}

async function finalize() {
  try {
    await saveRecording();
  } finally {
    // In a finally, not at the top: saving awaits the MP4 indexing, and a
    // stop during that window must answer "saving", not "it died". See the
    // twin in offscreen.js.
    finalizePending = false;
  }
}

async function saveRecording() {
  clearInterval(timerInterval);
  setView("saving");
  log("finalizing;", chunks.length, "chunks");
  const type = (recorder && recorder.mimeType) || "video/webm";
  let blob = new Blob(chunks, { type });
  chunks = [];
  // See offscreen.js: fragmented MP4 has no seek index and Windows Media
  // Player needs one. Failing to index must not cost the recording.
  try {
    blob = await withMp4Index(blob, type);
  } catch (e) {
    log("could not index the MP4 (it still plays, but seeking may not):", e);
  }
  const base = `screen-recordings/recording-${stamp()}`;
  const files = [{ url: trackBlobUrl(blob), filename: `${base}.${extForMime(type)}` }];

  // Separate audio file, if one was recording. Bounded await, local catch:
  // it may cost its own file, never the video (see the twin in offscreen.js).
  const audio = audioCapture;
  audioCapture = null;
  try {
    const audioBlob = await finishAudioRecorder(audio);
    if (audioBlob) {
      files.push({
        url: trackBlobUrl(audioBlob),
        filename: `${base}.${audioExtForMime(audioBlob.type)}`,
      });
    }
  } catch (e) {
    log("could not build the separate audio file:", e);
    toBackground("sw:warn", {
      message: "The video was saved, but the separate audio file could not be generated.",
    });
  }

  toBackground("sw:complete", { from: "recorder", files, bytes: blob.size });
  cleanupStreams();
  // The service worker closes this window once the downloads finish.
}

function trackBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  return url;
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
  if (audioCapture && audioCapture.rec.state !== "inactive") {
    try {
      audioCapture.rec.stop();
    } catch (e) {
      /* already stopping */
    }
  }
  audioCapture = null;
  recorder = null;
}

btnStop.addEventListener("click", stopCapture);
