"use strict";

/* exported QUALITY, pad, stamp, pickMime, extForMime, humanError, buildAudioGraph, formatElapsed */

// Utilities shared by offscreen.js (tab recording), recorder.js
// (screen/window recording) and popup.js. Loaded before them.

const QUALITY = {
  high: { frameRate: 30, videoBitsPerSecond: 8_000_000 },
  medium: { frameRate: 30, videoBitsPerSecond: 4_000_000 },
  light: { frameRate: 15, videoBitsPerSecond: 1_500_000 },
};

const pad = (n) => String(n).padStart(2, "0");

function stamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

// Elapsed milliseconds → "mm:ss" ("hh:mm:ss" past the hour). Shared by
// the popup timer, the recorder timer and the report's duration line.
function formatElapsed(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
}

// MP4 FIRST, and not for compatibility: MediaRecorder writes WebM in
// streaming mode, with no Duration in the header and no Cues index, so the
// player reports duration Infinity and its scrub bar is useless — you cannot
// jump to the middle of your own recording. The MP4 container carries the
// real duration (measured: 4.98 s vs Infinity for the same clip). H.264 also
// travels better than VP9 outside the browser. AAC first because Opus inside
// MP4 is legal but not every desktop player decodes it; Chrome picks whatever
// its build supports and WebM stays as the last resort.
function pickMime() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,opus",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

// File extension for the container actually used. Never hardcode it: which
// mime pickMime() lands on depends on the Chrome build.
function extForMime(mimeType) {
  if (/mp4/i.test(mimeType)) return "mp4";
  if (/matroska/i.test(mimeType)) return "mkv";
  return "webm";
}

function humanError(e) {
  const name = e && e.name;
  if (name === "NotAllowedError") return "permission denied (NotAllowedError).";
  if (name === "NotFoundError") return "source not found (NotFoundError).";
  if (name === "NotReadableError") return "the source is in use or unreadable (NotReadableError).";
  return (name ? name + ": " : "") + (e && e.message ? e.message : String(e));
}

// Combines system audio and microphone into one track. With playthrough,
// it re-injects system audio into the speakers (needed when capturing
// tabs, because Chrome mutes them while they are captured).
function buildAudioGraph(sysTrack, micTrack, playthrough) {
  if (!sysTrack && !micTrack) return { audioTrack: null, audioCtx: null };
  if (!sysTrack) return { audioTrack: micTrack, audioCtx: null }; // mic only

  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();

  const sys = ctx.createMediaStreamSource(new MediaStream([sysTrack]));
  sys.connect(dest);
  if (playthrough) sys.connect(ctx.destination);

  if (micTrack) {
    ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
  }
  return { audioTrack: dest.stream.getAudioTracks()[0], audioCtx: ctx };
}
