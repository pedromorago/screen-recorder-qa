"use strict";

const micIn = document.getElementById("mic");
const consoleIn = document.getElementById("consoleLog");
const networkIn = document.getElementById("networkLog");
const stepsIn = document.getElementById("stepsLog");
const qualitySel = document.getElementById("quality");
const btnTab = document.getElementById("btnTab");
const btnScreen = document.getElementById("btnScreen");
const btnStop = document.getElementById("btnStop");
const btnMarker = document.getElementById("btnMarker");
const btnAnnotate = document.getElementById("btnAnnotate");
const timerEl = document.getElementById("timer");
const noticeEl = document.getElementById("notice");

let timerInterval = null;

const pad = (n) => String(n).padStart(2, "0");
function fmt(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function render({ isRecording, startTime, notice, captureTarget }) {
  document.body.dataset.state = isRecording ? "recording" : "idle";
  micIn.disabled = consoleIn.disabled = networkIn.disabled = stepsIn.disabled = qualitySel.disabled = isRecording;

  // Markers and annotations only exist in the tab flow: a screen/window
  // recording has no tab to send them to, so the buttons would be no-ops.
  const tabFlow = captureTarget === "offscreen";
  btnMarker.style.display = tabFlow ? "" : "none";
  btnAnnotate.style.display = tabFlow ? "" : "none";

  clearInterval(timerInterval);
  if (isRecording && startTime) {
    const tick = () => (timerEl.textContent = fmt(Date.now() - startTime));
    tick();
    timerInterval = setInterval(tick, 500);
  }

  if (notice && notice.text) {
    noticeEl.textContent = notice.text;
    noticeEl.className = "notice show " + (notice.kind || "warn");
  } else {
    noticeEl.className = "notice";
  }
}

async function refresh() {
  const s = await chrome.storage.session.get({
    isRecording: false,
    startTime: null,
    notice: null,
    captureTarget: null,
  });
  render(s);
}

// Live updates while the popup is open (e.g. an error arriving from the
// offscreen document).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") refresh();
});

// ---------- Settings ----------

micIn.addEventListener("change", async () => {
  await chrome.storage.local.set({ mic: micIn.checked });
  if (!micIn.checked) return;

  // The offscreen document cannot show the microphone permission prompt,
  // so it is granted once from a visible page.
  let state = "prompt";
  try {
    const st = await navigator.permissions.query({ name: "microphone" });
    state = st.state;
  } catch (e) {
    /* if it cannot be queried, open the page anyway */
  }
  if (state === "granted") return;
  if (state === "denied") {
    await chrome.storage.session.set({
      notice: {
        kind: "warn",
        text: "The microphone is blocked for this extension. Open Chrome's Site settings (Microphone) and allow it.",
        at: Date.now(),
      },
    });
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
});

consoleIn.addEventListener("change", () =>
  chrome.storage.local.set({ consoleLog: consoleIn.checked })
);

networkIn.addEventListener("change", () =>
  chrome.storage.local.set({ networkLog: networkIn.checked })
);

stepsIn.addEventListener("change", () =>
  chrome.storage.local.set({ stepsLog: stepsIn.checked })
);

qualitySel.addEventListener("change", () =>
  chrome.storage.local.set({ quality: qualitySel.value })
);

// ---------- Record / stop ----------

btnTab.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:startTab" });
  window.close();
});

btnScreen.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:startScreen" });
  // Closed so the capture picker ends up in the foreground.
  window.close();
});

btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:stop" });
  // The popup stays open: the state change and any notice are visible.
});

btnMarker.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:marker" });
  // Brief feedback without closing the popup.
  btnMarker.textContent = "💥 Marked";
  setTimeout(() => (btnMarker.textContent = "💥 Mark bug here"), 900);
});

btnAnnotate.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:annotate" });
  // Closed so the user can draw on the page right away.
  window.close();
});

// ---------- Init ----------

(async () => {
  const cfg = await chrome.storage.local.get({
    mic: false,
    quality: "medium",
    consoleLog: true,
    networkLog: true,
    stepsLog: true,
  });
  micIn.checked = cfg.mic;
  consoleIn.checked = cfg.consoleLog;
  networkIn.checked = cfg.networkLog;
  stepsIn.checked = cfg.stepsLog;
  qualitySel.value = cfg.quality;
  await refresh();
})();
