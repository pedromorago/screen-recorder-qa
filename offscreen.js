"use strict";

// Offscreen document: records the current TAB from a chrome.tabCapture
// streamId. Screen/window recording lives in recorder.js.
// Requires capture-common.js to be loaded first.

const log = (...a) => console.log("[offscreen]", ...a);

let recorder = null;
let chunks = [];
let displayStream = null;
let micStream = null;
let audioCtx = null;
let blobUrls = [];

// QA logs (console and network). They accumulate here and not in the
// service worker: this document lives for the whole recording, the SW can die.
const MAX_QA_ENTRIES = 10_000;
let consoleEnabled = false;
let networkEnabled = false;
let stepsEnabled = false;
let qaMeta = null; // { url, title }
let qaEntries = []; // console/exception/rejection/resource/nav/net/step/marker
let qaDropped = 0;
let videoStartTime = null;

const anyQaEnabled = () => consoleEnabled || networkEnabled || stepsEnabled;

// Wrappers stay installed in the page between recordings (see CLAUDE.md),
// so anything can arrive: filter by kind according to THIS recording's
// toggles.
function acceptsEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (e.kind === "net") return networkEnabled;
  if (e.kind === "step") return stepsEnabled;
  if (e.kind === "nav") return anyQaEnabled();
  return consoleEnabled;
}

function toBackground(type, extra) {
  chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "off:start") {
    start(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        log("failed to start:", e);
        cleanupStreams();
        sendResponse({ ok: false, error: humanError(e) });
      });
    return true; // async response
  }

  if (msg.type === "off:stop") {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "off:cleanup") {
    const urls = msg.urls || (msg.url ? [msg.url] : []);
    for (const url of urls) {
      URL.revokeObjectURL(url);
      blobUrls = blobUrls.filter((u) => u !== url);
    }
    if (urls.length) log("blobs revoked after download:", urls.length);
    sendResponse({ ok: true });
    return false;
  }

  // Bug marker (keyboard shortcut or popup button, via the background).
  if (msg.type === "off:marker") {
    if (anyQaEnabled() && recorder && qaEntries.length < MAX_QA_ENTRIES) {
      qaEntries.push({
        kind: "marker",
        level: "warn",
        t: msg.t || Date.now(),
        text: "User marker: the bug is here",
      });
      log("marker added");
    }
    sendResponse({ ok: true });
    return false;
  }

  // Entry batches from console-capture-bridge.js (the recorded tab).
  if (msg.type === "off:consoleEntries") {
    if (recorder && Array.isArray(msg.entries)) {
      for (const e of msg.entries) {
        if (!acceptsEntry(e)) continue;
        if (qaEntries.length >= MAX_QA_ENTRIES) {
          qaDropped++;
          continue;
        }
        qaEntries.push(e);
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------- Tab capture ----------

async function start({ streamId, systemAudio, mic, quality, consoleCapture, networkCapture, stepsCapture, tabUrl, tabTitle }) {
  const q = QUALITY[quality] || QUALITY.medium;
  log("start", { systemAudio, mic, quality, consoleCapture, networkCapture, stepsCapture });

  consoleEnabled = !!consoleCapture;
  networkEnabled = !!networkCapture;
  stepsEnabled = !!stepsCapture;
  qaMeta = { url: tabUrl || "", title: tabTitle || "" };
  qaEntries = [];
  qaDropped = 0;

  // A tabCapture streamId is consumed with chromeMediaSource "tab".
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
  log("capture obtained:", displayStream.getTracks().map((t) => t.kind + " · " + t.label));

  // Microphone, optional. If it fails, keep recording and warn.
  let micTrack = null;
  if (mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micTrack = micStream.getAudioTracks()[0];
      log("microphone:", micTrack.label);
    } catch (e) {
      log("microphone unavailable:", e.name, e.message);
      toBackground("sw:warn", {
        message:
          "Recording without microphone: " +
          humanError(e) +
          " Grant the permission from the popup (microphone toggle).",
      });
    }
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  const sysTrack = displayStream.getAudioTracks()[0] || null;
  if (systemAudio && !sysTrack) {
    toBackground("sw:warn", {
      message: "Chrome did not deliver the tab's audio track; recording without it.",
    });
  }

  // Chrome mutes the captured tab: always play audio through.
  const graph = buildAudioGraph(sysTrack, micTrack, true);
  audioCtx = graph.audioCtx;
  const combined = new MediaStream(
    graph.audioTrack ? [videoTrack, graph.audioTrack] : [videoTrack]
  );

  videoTrack.addEventListener("ended", () => {
    log("capture ended by the user");
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
    toBackground("sw:error", { message: "Recorder error: " + detail });
    cleanupStreams();
  };
  recorder.start(1000);
  videoStartTime = Date.now(); // t0 for the QA log offsets
  log("recording with", recorder.mimeType || "default codec");
}

// Named stopCapture (not stop) to avoid shadowing window.stop().
function stopCapture() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function finalize() {
  log("finalizing;", chunks.length, "chunks");
  const type = (recorder && recorder.mimeType) || "video/webm";
  const blob = new Blob(chunks, { type });
  chunks = [];
  // NOTE: previous blobs are NOT revoked here. If the user chains
  // recordings, the previous recording's downloads may still be in flight
  // and revoking their URLs would interrupt them. Each group is revoked in
  // off:cleanup once the background confirms ALL its downloads finished.

  const name = `recording-${stamp()}`;
  const base = `screen-recordings/${name}`;
  const durationMs = videoStartTime ? Date.now() - videoStartTime : 0;
  const files = [{ url: trackBlobUrl(blob), filename: `${base}.webm`, bytes: blob.size }];

  // The bridge may have sent batches out of order: stable sort by t.
  qaEntries.sort((a, b) => a.t - b.t);

  if (consoleEnabled) {
    const { text, json } = buildConsoleReport();
    files.push(
      { url: trackBlobUrl(new Blob([text], { type: "text/plain" })), filename: `${base}.console.log` },
      { url: trackBlobUrl(new Blob([json], { type: "application/json" })), filename: `${base}.console.json` }
    );
  }
  if (networkEnabled) {
    files.push({
      url: trackBlobUrl(new Blob([buildHar()], { type: "application/json" })),
      filename: `${base}.har`,
    });
  }
  if (stepsEnabled) {
    files.push({
      url: trackBlobUrl(new Blob([buildStepsReport()], { type: "text/markdown" })),
      filename: `${base}.steps.md`,
    });
  }
  let reportMsg = null;
  if (anyQaEnabled()) {
    // The report is generated last: it lists the other file names.
    const report = buildRecordingReport(
      name,
      durationMs,
      files.map((f) => f.filename.split("/").pop()).concat(`${name}.report.md`)
    );
    files.push({
      url: trackBlobUrl(new Blob([report], { type: "text/markdown" })),
      filename: `${base}.report.md`,
    });
    // For the Jira/Linear issue (if configured; handled by the background).
    reportMsg = {
      title: "[QA Recorder] " + (qaMeta.title || qaMeta.url || name),
      text: report,
    };
    log("QA logs:", qaEntries.length, "entries");
  }

  toBackground("sw:complete", { from: "offscreen", files, bytes: blob.size, report: reportMsg });
  consoleEnabled = networkEnabled = stepsEnabled = false;
  cleanupStreams();
}

function trackBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  return url;
}

// ---------- QA logs: output files ----------

// Offset relative to the video start, as "+mm:ss.mmm".
function offset(t) {
  const ms = Math.max(0, t - (videoStartTime || t));
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  return `+${pad(m)}:${pad(s)}.${String(ms % 1000).padStart(3, "0")}`;
}

const isNetFailure = (e) =>
  e.kind === "net" && !!(e.net && (e.net.error || e.net.status >= 400));

// .console.log (text) and .console.json. In the text file, network shows
// up only when it failed: the bug's timeline without healthy-network
// noise, which is already complete in the .har.
function buildConsoleReport() {
  const startedAt = new Date(videoStartTime || Date.now()).toISOString();
  const textEntries = qaEntries.filter((e) => e.kind !== "net" || isNetFailure(e));
  const jsonEntries = qaEntries.filter((e) => e.kind !== "net");

  const header =
    "# Console log — Screen Recorder (QA mode)\n" +
    `# Page: ${qaMeta.title || "(untitled)"} — ${qaMeta.url}\n` +
    `# Video start: ${startedAt}\n` +
    `# Browser: ${navigator.userAgent}\n` +
    `# ${textEntries.length} entries` +
    (qaDropped ? ` (${qaDropped} dropped due to limit)` : "") +
    (networkEnabled ? " · full network in the attached .har" : "") +
    "\n\n";

  const label = (e) =>
    e.kind === "nav" ? "NAV"
    : e.kind === "net" ? "NET"
    : e.kind === "step" ? "STEP"
    : e.kind === "marker" ? "MARK"
    : (e.level || "log").toUpperCase();

  const text =
    header +
    (textEntries.length
      ? textEntries.map((e) => `[${offset(e.t)}] ${label(e).padEnd(5)} ${e.text}`).join("\n") + "\n"
      : "(no console entries during the recording)\n");

  const json = JSON.stringify(
    {
      meta: {
        url: qaMeta.url,
        title: qaMeta.title,
        videoStart: startedAt,
        userAgent: navigator.userAgent,
        entries: jsonEntries.length,
        dropped: qaDropped,
      },
      // offsetMs: milliseconds since the video start.
      entries: jsonEntries.map((e) => ({
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

// .steps.md: numbered list of navigations, user steps and markers, each
// with its offset. Paste-ready for a ticket.
function buildStepsReport() {
  const steps = qaEntries.filter(
    (e) => e.kind === "step" || e.kind === "nav" || e.kind === "marker"
  );
  const header =
    `# Steps to reproduce — ${qaMeta.title || qaMeta.url || "recording"}\n\n` +
    `Recording started at ${new Date(videoStartTime || Date.now()).toISOString()} on ${qaMeta.url}\n` +
    "Offsets are relative to the video start. Values typed by the user are NEVER recorded.\n\n";

  if (!steps.length) return header + "(no steps recorded during the recording)\n";

  return (
    header +
    steps
      .map((e, i) => {
        const text =
          e.kind === "nav" ? `Go to ${e.text}` : e.kind === "marker" ? `💥 ${e.text}` : e.text;
        return `${i + 1}. [${offset(e.t)}] ${text}`;
      })
      .join("\n") +
    "\n"
  );
}

// .report.md: the recording's executive summary (environment, counters,
// markers, errors and steps), paste-ready for Jira/Linear.
function buildRecordingReport(name, durationMs, fileNames) {
  const chromeVersion = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "?";
  const count = (fn) => qaEntries.filter(fn).length;

  const jsErrors = count((e) => e.kind === "exception" || e.kind === "rejection");
  const resources = count((e) => e.kind === "resource");
  const netTotal = count((e) => e.kind === "net");
  const netFailed = count(isNetFailure);
  const markers = qaEntries.filter((e) => e.kind === "marker");
  const steps = count((e) => e.kind === "step");
  const errors = qaEntries.filter((e) => e.level === "error");

  const lines = [];
  lines.push(`# QA recording report — ${qaMeta.title || "(untitled)"}`);
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push(`- URL: ${qaMeta.url}`);
  lines.push(`- Started: ${new Date(videoStartTime || Date.now()).toISOString()}`);
  lines.push(`- Duration: ${formatElapsed(durationMs)}`);
  lines.push(`- Chrome: ${chromeVersion} · OS: ${navigator.platform}`);
  lines.push(`- Language: ${navigator.language} · Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  lines.push(`- User agent: ${navigator.userAgent}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- JS errors (exceptions and unhandled rejections): ${jsErrors}`);
  lines.push(`- Resources that failed to load: ${resources}`);
  lines.push(`- Failed requests: ${netFailed} of ${netTotal} recorded`);
  lines.push(`- User markers: ${markers.length}`);
  lines.push(`- Steps recorded: ${steps}`);
  if (qaDropped) lines.push(`- Entries dropped due to limit: ${qaDropped}`);

  if (markers.length) {
    lines.push("");
    lines.push('## Markers ("the bug is here")');
    lines.push("");
    for (const m of markers) lines.push(`- [${offset(m.t)}] 💥 ${m.text}`);
  }

  if (errors.length) {
    lines.push("");
    lines.push("## Timeline errors");
    lines.push("");
    for (const e of errors.slice(0, 50)) {
      lines.push(`- [${offset(e.t)}] ${e.text.split("\n")[0]}`);
    }
    if (errors.length > 50) lines.push(`- … and ${errors.length - 50} more (see .console.log)`);
  }

  lines.push("");
  lines.push("## Files in this recording");
  lines.push("");
  for (const f of fileNames) lines.push(`- ${f}`);
  lines.push("");
  return lines.join("\n");
}

// HAR 1.2 with every fetch/XHR request. Navigations during the recording
// become the "pages", and each request hangs off the page that was current
// when it started.
function buildHar() {
  const navs = qaEntries.filter((e) => e.kind === "nav");
  const nets = qaEntries.filter((e) => e.kind === "net");

  const pageMarks = navs.length
    ? navs.map((n) => ({ t: n.t, title: n.text }))
    : [{ t: videoStartTime || Date.now(), title: qaMeta.url || "(unknown)" }];

  const pages = pageMarks.map((p, i) => ({
    startedDateTime: new Date(p.t).toISOString(),
    id: "page_" + (i + 1),
    title: p.title,
    pageTimings: { onContentLoad: -1, onLoad: -1 },
  }));

  const pageref = (t) => {
    let idx = 0;
    for (let i = 0; i < pageMarks.length; i++) if (pageMarks[i].t <= t) idx = i;
    return "page_" + (idx + 1);
  };

  const entries = nets.map((e) => {
    const n = e.net || {};
    let queryString = [];
    try {
      queryString = [...new URL(n.url).searchParams].map(([name, value]) => ({ name, value }));
    } catch (err) {
      /* truncated or invalid URL */
    }
    return {
      pageref: pageref(e.t),
      startedDateTime: new Date(e.t).toISOString(),
      time: n.durationMs || 0,
      request: {
        method: n.method || "GET",
        url: n.url || "",
        httpVersion: "",
        cookies: [],
        headers: n.requestHeaders || [],
        queryString,
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: n.status || 0,
        statusText: n.statusText || "",
        httpVersion: "",
        cookies: [],
        headers: n.responseHeaders || [],
        content: {
          size: typeof n.contentLength === "number" ? n.contentLength : -1,
          mimeType: n.contentType || "x-unknown",
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: n.durationMs || 0, receive: 0 },
      comment:
        (n.initiator || "") + (n.error ? " · failed: " + n.error : ""),
    };
  });

  return JSON.stringify(
    {
      log: {
        version: "1.2",
        creator: {
          name: "Screen Recorder (QA mode)",
          version: chrome.runtime.getManifest().version,
        },
        pages,
        entries,
      },
    },
    null,
    2
  );
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
