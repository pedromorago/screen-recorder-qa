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

function render({ isRecording, startTime, notice }) {
  document.body.dataset.state = isRecording ? "recording" : "idle";
  micIn.disabled = consoleIn.disabled = networkIn.disabled = stepsIn.disabled = qualitySel.disabled = isRecording;

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
  });
  render(s);
}

// Actualización en vivo mientras el popup está abierto
// (por ejemplo, si llega un error del offscreen).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") refresh();
});

// ---------- Ajustes ----------

micIn.addEventListener("change", async () => {
  await chrome.storage.local.set({ mic: micIn.checked });
  if (!micIn.checked) return;

  // El documento offscreen no puede mostrar el aviso de permiso del
  // micrófono, así que se concede una vez desde una página visible.
  let state = "prompt";
  try {
    const st = await navigator.permissions.query({ name: "microphone" });
    state = st.state;
  } catch (e) {
    /* si no se puede consultar, se abre la página igualmente */
  }
  if (state === "granted") return;
  if (state === "denied") {
    await chrome.storage.session.set({
      notice: {
        kind: "warn",
        text: "El micrófono está bloqueado para la extensión. Ábrelo en Configuración de sitios de Chrome (Micrófono) y permítelo.",
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

// ---------- Grabar / parar ----------

btnTab.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:startTab" });
  window.close();
});

btnScreen.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:startScreen" });
  // Se cierra para que el selector de captura quede en primer plano.
  window.close();
});

btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:stop" });
  // El popup queda abierto: se ve el cambio de estado y cualquier aviso.
});

btnMarker.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:marker" });
  // Feedback breve sin cerrar el popup.
  btnMarker.textContent = "💥 Marcado";
  setTimeout(() => (btnMarker.textContent = "💥 Marcar bug aquí"), 900);
});

btnAnnotate.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ target: "background", type: "popup:annotate" });
  // Se cierra para que el usuario pueda dibujar sobre la página al momento.
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
