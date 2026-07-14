// Service worker (Manifest V3).
// Two capture flows:
//  - Current tab: tabCapture.getMediaStreamId -> offscreen document.
//  - Screen or window: recorder.html window, which opens the picker and
//    records in its own context (consuming the streamId elsewhere fails).
// State lives in chrome.storage.session; the popup reads it directly.

"use strict";

importScripts("issue-reporter.js");

const OFFSCREEN_URL = "offscreen.html";
const log = (...a) => console.log("[SW]", ...a);

// ---------- State ----------

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

// Notice shown in the popup: { kind: "ok"|"warn"|"error", text }
async function setNotice(kind, text) {
  await chrome.storage.session.set({
    notice: text ? { kind, text, at: Date.now() } : null,
  });
}

// ---------- Offscreen document (tab flow) ----------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  log("creating offscreen document");
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification: "Record the tab in the background with MediaRecorder.",
  });
}

// Send with retries: covers the gap between creating a context and its
// listener being registered.
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
    'The "' + target + '" context is not responding' +
      (lastErr ? " (" + (lastErr.message || lastErr) + ")" : "")
  );
}

// ---------- QA logs: console, network, steps (tab flow only) ----------

const injectableUrl = (url) => /^https?:/.test(url || "");

// Wrappers in the MAIN world (no chrome.runtime there) + a bridge in the
// isolated world that relays everything to the offscreen document.
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
    // User steps are visible from the isolated world: no MAIN needed.
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
  // The annotation surface ALWAYS ships with the tab flow (it does not
  // depend on the QA toggles): it draws DOM over the page and the capture
  // records it without touching the video pipeline.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["annotate-overlay.js"],
    injectImmediately: true,
  });
}

// Toggles the annotation surface on the recorded tab.
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
    log("could not toggle the annotation:", e);
    await setNotice("warn", "Could not open the annotation on this page.");
  }
}

// "The bug is here" marker: from the keyboard shortcut or the popup.
async function addMarker() {
  const { isRecording, captureTarget } = await chrome.storage.session.get({
    isRecording: false,
    captureTarget: null,
  });
  if (!isRecording || captureTarget !== "offscreen") return;
  try {
    await sendTo("offscreen", { type: "off:marker", t: Date.now() }, 2);
  } catch (e) {
    log("could not add the marker:", e);
  }
}

// If the recorded tab navigates, the content scripts vanish: re-inject
// them as soon as the new document starts loading.
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
    log("QA logs re-injected after navigation", tab.url);
  } catch (e) {
    log("could not re-inject the QA logs:", e);
  }
});

// ---------- Flow 1: current tab ----------

async function startTabRecording() {
  const { isRecording } = await chrome.storage.session.get({ isRecording: false });
  if (isRecording) {
    log("a recording is already in progress; ignored");
    return;
  }
  await setNotice(null);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error("no active tab");
    log("requesting streamId for tab", tab.id);
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
    // The offscreen only answers ok:true once getUserMedia and
    // MediaRecorder have truly started. No state races.
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
      throw new Error((res && res.error) || "the offscreen did not confirm the start");
    }
    await setRecordingState(true, Date.now(), "offscreen");
    await chrome.storage.session.set({
      recordedTabId: tab.id,
      consoleCapture,
      networkCapture,
      stepsCapture,
    });
    log("tab recording started");

    if (injectable) {
      try {
        // Injected even with all three toggles off: the annotation
        // surface does not depend on them.
        await injectQaCapture(tab.id, { consoleCapture, networkCapture, stepsCapture });
        log("QA logs active on tab", tab.id, {
          consoleCapture,
          networkCapture,
          stepsCapture,
        });
      } catch (e) {
        log("could not inject the QA logs:", e);
        await setNotice(
          "warn",
          "The video is recording, but the QA logs and annotation could not be enabled on this page."
        );
      }
    } else if (cfg.consoleLog || cfg.networkLog || cfg.stepsLog) {
      await setNotice(
        "warn",
        "QA logs (console, network, steps) and annotation only work on http(s) pages; this recording will go without them."
      );
    }
  } catch (e) {
    log("could not start tab capture:", e);
    await setNotice(
      "error",
      "Could not record this tab: " +
        (e.message || e) +
        '. Chrome internal pages (chrome://, Web Store) cannot be recorded; try "Screen or window".'
    );
    await setRecordingState(false);
  }
}

// ---------- Flow 2: screen or window (recorder window) ----------

async function startScreenRecording() {
  const { isRecording, recorderWindowId } = await chrome.storage.session.get({
    isRecording: false,
    recorderWindowId: null,
  });
  if (isRecording) {
    log("a recording is already in progress; ignored");
    return;
  }
  // If a recorder window is already open, bring it to the front.
  if (recorderWindowId) {
    try {
      await chrome.windows.update(recorderWindowId, { focused: true, state: "normal" });
      log("recorder window already open; focused");
      return;
    } catch (e) {
      await chrome.storage.session.set({ recorderWindowId: null });
    }
  }
  await setNotice(null);
  log("opening recorder window");

  // Large enough for the native dialog (a modal INSIDE this window) to be
  // fully visible, and centered over the active window.
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
    /* no centering */
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
    /* already closed */
  }
}

// ---------- Jira/Linear issue when the recording ends ----------

// If a provider is configured (options.html) with auto-create on, upload
// the report as a new issue and leave the link in the popup notice.
async function reportIssueIfConfigured(report) {
  const { issueReporter } = await chrome.storage.local.get({ issueReporter: null });
  if (!issueReporter || issueReporter.provider === "none" || !issueReporter.autoCreate) return;
  const providerName = issueReporter.provider === "jira" ? "Jira" : "Linear";
  try {
    const res = await createIssueFromReport(issueReporter, report.title, report.text);
    log("issue created:", res.key, res.url);
    await setNotice("ok", `Issue created in ${providerName}: ${res.key} — ${res.url}`);
  } catch (e) {
    log("could not create the issue:", e);
    await setNotice(
      "error",
      `The video and reports were saved, but the ${providerName} issue could not be created: ` +
        (e.message || e)
    );
  }
}

// ---------- Stop ----------

async function stopRecording() {
  const { isRecording, captureTarget } = await chrome.storage.session.get({
    isRecording: false,
    captureTarget: null,
  });
  if (!isRecording) return;
  log("stopping recording in", captureTarget);
  try {
    if (captureTarget === "recorder") {
      await sendTo("recorder", { type: "rec:stop" }, 5);
    } else {
      await sendTo("offscreen", { type: "off:stop" }, 5);
    }
  } catch (e) {
    log("the capture context is not responding to stop:", e);
    await setNotice("error", "The recording was lost: the capture process is not responding.");
    await setRecordingState(false);
  }
}

// ---------- Messages ----------

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
        log("screen recording started");
      })().catch((e) => log("rec:started:", e));
      break;

    case "rec:cancelled":
      log("screen recording cancelled");
      closeRecorderWindow().catch((e) => log("rec:cancelled:", e));
      break;

    case "rec:failed":
      (async () => {
        log("recorder window failed:", msg.message);
        await setNotice("error", msg.message);
        await setRecordingState(false);
        await closeRecorderWindow();
      })().catch((e) => log("rec:failed:", e));
      break;

    case "sw:complete":
      (async () => {
        // The offscreen sends files[] (video + QA logs); the recorder
        // still sends a bare url/filename pair.
        const files = msg.files || [{ url: msg.url, filename: msg.filename }];
        log(
          "recording complete (" + msg.from + "):",
          files.map((f) => f.filename).join(", "),
          msg.bytes,
          "video bytes"
        );
        const ids = [];
        const urls = [];
        let failed = 0;
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
            failed++;
            log("could not download", f.filename, e);
          }
        }
        if (ids.length) {
          // Download GROUPS: if the user chains recordings, the previous
          // recording's downloads may still be in flight. Each group is
          // cleaned up separately once ALL its downloads finish.
          const { pendingDownloads } = await chrome.storage.session.get({
            pendingDownloads: null,
          });
          const groups = (pendingDownloads && pendingDownloads.groups) || [];
          groups.push({ ids, urls, from: msg.from || "offscreen" });
          await chrome.storage.session.set({ pendingDownloads: { groups } });
        }
        if (failed) {
          await setNotice(
            "error",
            `Could not save ${failed} of ${files.length} files from the recording.`
          );
          if (!ids.length && (msg.from || "offscreen") === "recorder") {
            await closeRecorderWindow();
          }
        }
        await setRecordingState(false);
        if (msg.report) {
          // Does not block the downloads: creates the issue in the background.
          reportIssueIfConfigured(msg.report).catch((e) => log("issue:", e));
        }
      })().catch((e) => {
        log("download error:", e);
        setNotice("error", "Could not save the file: " + (e.message || e));
        setRecordingState(false);
        if (msg.from === "recorder") closeRecorderWindow();
      });
      break;

    case "sw:error":
      log("error from the capture:", msg.message);
      setNotice("error", msg.message);
      setRecordingState(false);
      break;

    case "sw:warn":
      log("warning from the capture:", msg.message);
      setNotice("warn", msg.message);
      break;
  }
  return false;
});

// Once ALL of a recording's downloads finish: revoke the blobs and close
// the capture context to release the recording from memory. Events are
// processed serially so two downloads (video + logs) finishing almost at
// once cannot clobber the shared state.
let downloadEventQueue = Promise.resolve();
chrome.downloads.onChanged.addListener((delta) => {
  downloadEventQueue = downloadEventQueue
    .then(() => handleDownloadChanged(delta))
    .catch((e) => log("error handling download completion:", e));
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
  log("download finished:", state, "·", group.ids.length, "left in its group");
  await chrome.storage.session.set({
    pendingDownloads: remainingGroups.length ? { groups: remainingGroups } : null,
  });
  if (group.ids.length) return;

  // The group is done: release its blobs and close its context if needed.
  if (group.from === "recorder") {
    try {
      await sendTo("recorder", { type: "rec:cleanup", urls: group.urls }, 2);
    } catch (e) {
      /* already gone */
    }
    await closeRecorderWindow();
  } else {
    try {
      await sendTo("offscreen", { type: "off:cleanup", urls: group.urls }, 2);
    } catch (e) {
      /* already gone */
    }
    // Only close the document if no other recording is running AND no
    // other offscreen download groups are in flight.
    const offscreenPending = remainingGroups.some((g) => g.from !== "recorder");
    if (!isRecording && !offscreenPending && (await hasOffscreen())) {
      try {
        await chrome.offscreen.closeDocument();
        log("offscreen document closed");
      } catch (e) {
        log("could not close the offscreen:", e);
      }
    }
  }
}

// If the user closes the recorder window by hand.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { recorderWindowId, isRecording, captureTarget } =
    await chrome.storage.session.get({
      recorderWindowId: null,
      isRecording: false,
      captureTarget: null,
    });
  if (recorderWindowId !== windowId) return;

  log("recorder window closed");
  await chrome.storage.session.set({ recorderWindowId: null });
  if (isRecording && captureTarget === "recorder") {
    await setRecordingState(false);
    await setNotice(
      "error",
      'The recorder window was closed and the recording in progress was lost. To save, use "Stop" in the popup or the shortcut.'
    );
  }
});

// Keyboard shortcuts. toggle-recording: stops if recording; otherwise
// opens the screen/window flow (works on any page, including chrome://).
// add-marker: bug marker on the tab recording. toggle-annotate: draw over
// the recorded tab.
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

// Clean state on install or browser startup.
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  log("extension installed/updated");
});
chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
