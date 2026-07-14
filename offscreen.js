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

// Registros QA (consola y red). Se acumulan aquí y no en el service worker
// porque este documento vive toda la grabación y el SW puede morir.
const MAX_QA_ENTRIES = 10_000;
let consoleEnabled = false;
let networkEnabled = false;
let stepsEnabled = false;
let qaMeta = null; // { url, title }
let qaEntries = []; // console/exception/rejection/resource/nav/net/step/marker
let qaDropped = 0;
let videoStartTime = null;

const anyQaEnabled = () => consoleEnabled || networkEnabled || stepsEnabled;

// Los wrappers quedan instalados en la página entre grabaciones (ver
// CLAUDE.md), así que puede llegar de todo: se filtra por tipo según los
// interruptores de ESTA grabación.
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

  // Marcador de bug (atajo o botón del popup, vía background).
  if (msg.type === "off:marker") {
    if (anyQaEnabled() && recorder && qaEntries.length < MAX_QA_ENTRIES) {
      qaEntries.push({
        kind: "marker",
        level: "warn",
        t: msg.t || Date.now(),
        text: "Marcador del usuario: aquí está el bug",
      });
      log("marcador añadido");
    }
    sendResponse({ ok: true });
    return false;
  }

  // Lotes de entradas desde console-capture-bridge.js (pestaña grabada).
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

// ---------- Captura de pestaña ----------

async function start({ streamId, systemAudio, mic, quality, consoleCapture, networkCapture, stepsCapture, tabUrl, tabTitle }) {
  const q = QUALITY[quality] || QUALITY.medium;
  log("start", { systemAudio, mic, quality, consoleCapture, networkCapture, stepsCapture });

  consoleEnabled = !!consoleCapture;
  networkEnabled = !!networkCapture;
  stepsEnabled = !!stepsCapture;
  qaMeta = { url: tabUrl || "", title: tabTitle || "" };
  qaEntries = [];
  qaDropped = 0;

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
  // OJO: aquí NO se revocan los blobs anteriores. Si el usuario encadena
  // grabaciones, las descargas de la anterior pueden seguir en vuelo y
  // revocar su URL las interrumpe. Cada grupo se revoca en off:cleanup
  // cuando el background confirma que TODAS sus descargas terminaron.

  const name = `grabacion-${stamp()}`;
  const base = `grabaciones-pantalla/${name}`;
  const durationMs = videoStartTime ? Date.now() - videoStartTime : 0;
  const files = [{ url: track(blob), filename: `${base}.webm`, bytes: blob.size }];

  // El puente puede haber enviado lotes desordenados: orden estable por t.
  qaEntries.sort((a, b) => a.t - b.t);

  if (consoleEnabled) {
    const { text, json } = buildConsoleReport();
    files.push(
      { url: track(new Blob([text], { type: "text/plain" })), filename: `${base}.console.log` },
      { url: track(new Blob([json], { type: "application/json" })), filename: `${base}.console.json` }
    );
  }
  if (networkEnabled) {
    files.push({
      url: track(new Blob([buildHar()], { type: "application/json" })),
      filename: `${base}.har`,
    });
  }
  if (stepsEnabled) {
    files.push({
      url: track(new Blob([buildStepsReport()], { type: "text/markdown" })),
      filename: `${base}.pasos.md`,
    });
  }
  if (anyQaEnabled()) {
    // El informe se genera el último: lista los nombres del resto.
    const informe = buildInformeReport(
      name,
      durationMs,
      files.map((f) => f.filename.split("/").pop()).concat(`${name}.informe.md`)
    );
    files.push({
      url: track(new Blob([informe], { type: "text/markdown" })),
      filename: `${base}.informe.md`,
    });
    log("registros QA:", qaEntries.length, "entradas");
  }

  toBackground("sw:complete", { from: "offscreen", files, bytes: blob.size });
  consoleEnabled = networkEnabled = stepsEnabled = false;
  cleanupStreams();
}

function track(blob) {
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  return url;
}

// ---------- Registros QA: ficheros de salida ----------

// Offset respecto al inicio del vídeo, como "+mm:ss.mmm".
function offset(t) {
  const ms = Math.max(0, t - (videoStartTime || t));
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  return `+${pad(m)}:${pad(s)}.${String(ms % 1000).padStart(3, "0")}`;
}

const isNetFailure = (e) =>
  e.kind === "net" && !!(e.net && (e.net.error || e.net.status >= 400));

// .console.log (texto) y .console.json. En el texto, la red aparece solo
// cuando falla: la línea de tiempo del bug sin el ruido de la red sana,
// que ya está completa en el .har.
function buildConsoleReport() {
  const startedAt = new Date(videoStartTime || Date.now()).toISOString();
  const textEntries = qaEntries.filter((e) => e.kind !== "net" || isNetFailure(e));
  const jsonEntries = qaEntries.filter((e) => e.kind !== "net");

  const header =
    "# Registro de consola — Grabador de pantalla (modo QA)\n" +
    `# Página: ${qaMeta.title || "(sin título)"} — ${qaMeta.url}\n` +
    `# Inicio del vídeo: ${startedAt}\n` +
    `# Navegador: ${navigator.userAgent}\n` +
    `# ${textEntries.length} entradas` +
    (qaDropped ? ` (${qaDropped} descartadas por límite)` : "") +
    (networkEnabled ? " · red completa en el .har adjunto" : "") +
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
      : "(sin entradas de consola durante la grabación)\n");

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
      // offsetMs: milisegundos desde el inicio del vídeo.
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

// .pasos.md: lista numerada de navegaciones, pasos del usuario y
// marcadores, con su offset. Pegable tal cual en un ticket.
function buildStepsReport() {
  const pasos = qaEntries.filter(
    (e) => e.kind === "step" || e.kind === "nav" || e.kind === "marker"
  );
  const header =
    `# Pasos para reproducir — ${qaMeta.title || qaMeta.url || "grabación"}\n\n` +
    `Grabación iniciada el ${new Date(videoStartTime || Date.now()).toISOString()} en ${qaMeta.url}\n` +
    "Los offsets son relativos al inicio del vídeo. Los valores tecleados por el usuario NO se registran.\n\n";

  if (!pasos.length) return header + "(sin pasos registrados durante la grabación)\n";

  return (
    header +
    pasos
      .map((e, i) => {
        const texto =
          e.kind === "nav" ? `Ir a ${e.text}` : e.kind === "marker" ? `💥 ${e.text}` : e.text;
        return `${i + 1}. [${offset(e.t)}] ${texto}`;
      })
      .join("\n") +
    "\n"
  );
}

// .informe.md: el resumen ejecutivo de la grabación (entorno, contadores,
// marcadores, errores y pasos), listo para pegar en Jira/Linear.
function buildInformeReport(name, durationMs, fileNames) {
  const fmtDur = (ms) => {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    return (h ? pad(h) + ":" : "") + `${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  const chrome_ = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "?";
  const count = (fn) => qaEntries.filter(fn).length;

  const erroresJs = count((e) => e.kind === "exception" || e.kind === "rejection");
  const recursos = count((e) => e.kind === "resource");
  const redTotal = count((e) => e.kind === "net");
  const redFallida = count(isNetFailure);
  const marcadores = qaEntries.filter((e) => e.kind === "marker");
  const pasos = count((e) => e.kind === "step");
  const errores = qaEntries.filter((e) => e.level === "error");

  const lineas = [];
  lineas.push(`# Informe de grabación QA — ${qaMeta.title || "(sin título)"}`);
  lineas.push("");
  lineas.push("## Entorno");
  lineas.push("");
  lineas.push(`- URL: ${qaMeta.url}`);
  lineas.push(`- Inicio: ${new Date(videoStartTime || Date.now()).toISOString()}`);
  lineas.push(`- Duración: ${fmtDur(durationMs)}`);
  lineas.push(`- Chrome: ${chrome_} · SO: ${navigator.platform}`);
  lineas.push(`- Idioma: ${navigator.language} · Zona horaria: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  lineas.push(`- User agent: ${navigator.userAgent}`);
  lineas.push("");
  lineas.push("## Resumen");
  lineas.push("");
  lineas.push(`- Errores JS (excepciones y promesas rechazadas): ${erroresJs}`);
  lineas.push(`- Recursos que no cargaron: ${recursos}`);
  lineas.push(`- Peticiones fallidas: ${redFallida} de ${redTotal} registradas`);
  lineas.push(`- Marcadores del usuario: ${marcadores.length}`);
  lineas.push(`- Pasos registrados: ${pasos}`);
  if (qaDropped) lineas.push(`- Entradas descartadas por límite: ${qaDropped}`);

  if (marcadores.length) {
    lineas.push("");
    lineas.push("## Marcadores («aquí está el bug»)");
    lineas.push("");
    for (const m of marcadores) lineas.push(`- [${offset(m.t)}] 💥 ${m.text}`);
  }

  if (errores.length) {
    lineas.push("");
    lineas.push("## Errores en la línea de tiempo");
    lineas.push("");
    for (const e of errores.slice(0, 50)) {
      lineas.push(`- [${offset(e.t)}] ${e.text.split("\n")[0]}`);
    }
    if (errores.length > 50) lineas.push(`- … y ${errores.length - 50} más (ver .console.log)`);
  }

  lineas.push("");
  lineas.push("## Ficheros de esta grabación");
  lineas.push("");
  for (const f of fileNames) lineas.push(`- ${f}`);
  lineas.push("");
  return lineas.join("\n");
}

// HAR 1.2 con todas las peticiones fetch/XHR. Las navegaciones de la
// grabación se convierten en "pages", y cada petición se cuelga de la
// página vigente cuando arrancó.
function buildHar() {
  const navs = qaEntries.filter((e) => e.kind === "nav");
  const nets = qaEntries.filter((e) => e.kind === "net");

  const pageMarks = navs.length
    ? navs.map((n) => ({ t: n.t, title: n.text }))
    : [{ t: videoStartTime || Date.now(), title: qaMeta.url || "(desconocida)" }];

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
      /* URL truncada o inválida */
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
        (n.initiator || "") + (n.error ? " · fallo: " + n.error : ""),
    };
  });

  return JSON.stringify(
    {
      log: {
        version: "1.2",
        creator: {
          name: "Grabador de pantalla (modo QA)",
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
