# Grabador de pantalla (extensión Chrome MV3)

Extensión de grabación de pantalla sin límites de tiempo ni marca de agua,
con modo QA: consola, errores JS y red (export HAR) sincronizados con el
vídeo. JS plano, sin build: se carga descomprimida en Chrome.

## Arquitectura

- `background.js` (service worker): orquesta estado, mensajes y descargas.
  Estado en `chrome.storage.session` (el popup lo lee directamente).
- `offscreen.html/js`: graba la PESTAÑA actual a partir del streamId de
  `chrome.tabCapture.getMediaStreamId`. Invisible.
- `recorder.html/js`: ventana propia que graba PANTALLA o VENTANA. Abre el
  selector y consume el streamId en su MISMO frame. Se minimiza al grabar
  y se cierra sola al guardar. Si se cierra a mano, la grabación se pierde.
- `capture-common.js`: utilidades compartidas (calidad, mime, mezcla de audio).
- `popup.html/js`: UI de control. `permission.html/js`: concesión única del
  permiso de micrófono.
- Registros QA (SOLO flujo de pestaña): `console-capture-main.js`
  (world MAIN: envuelve console.*, window error/unhandledrejection y errores
  de carga de recursos) y `network-capture-main.js` (world MAIN: envuelve
  fetch y XMLHttpRequest; método, URL, status, duración, headers acotados)
  + `console-capture-bridge.js` (world aislado: agrupa en lotes y reenvía
  al offscreen; común a ambos). El background los inyecta según los
  interruptores con `chrome.scripting.executeScript` al iniciar y los
  REINYECTA en `tabs.onUpdated` (status "loading") si la pestaña navega.
  El offscreen acumula las entradas y al parar genera `.console.log` y
  `.console.json` (offsets `+mm:ss.mmm` relativos al inicio del vídeo) y
  `.har` (HAR 1.2; las navegaciones son las "pages"). En el `.console.log`
  la red solo aparece si falló (error de red/CORS o status >= 400); la red
  completa va al `.har`.
- Mensajería: `chrome.runtime.sendMessage` con campo `target`
  ("background" | "offscreen" | "recorder").

## Restricciones MV3 aprendidas (NO revertir)

1. `chrome.desktopCapture.chooseDesktopMedia` desde el service worker EXIGE
   `targetTab` ("A target tab is required when called from a service worker
   context"), y con `targetTab` el streamId queda ligado al origen de esa
   pestaña web, inconsumible desde contextos de la extensión. Por eso el
   selector vive en `recorder.html`, no en el SW.
2. El streamId del selector de escritorio solo se consume con fiabilidad en
   el MISMO frame que lo pidió. No transferirlo al documento offscreen.
3. Pestañas y escritorio usan fuentes distintas en getUserMedia:
   `chromeMediaSource: "tab"` para streamIds de tabCapture,
   `chromeMediaSource: "desktop"` para el selector de pantalla/ventana.
   Mezclarlos produce `AbortError: Error starting tab capture`.
4. Chrome silencia la pestaña mientras se captura: hay playthrough del audio
   via AudioContext SOLO en el flujo de pestaña (en pantalla completa
   duplicaría el sonido del sistema).
5. El documento offscreen no puede mostrar el aviso de permiso del
   micrófono: la concesión inicial se hace en `permission.html`.
6. La sintaxis `mandatory: { chromeMediaSource, chromeMediaSourceId }` es
   legacy pero es la requerida para este tipo de captura.
7. Registros QA: en el world MAIN no existe `chrome.runtime`, por eso
   hay scripts separados (main → postMessage → bridge → offscreen). Las
   entradas se acumulan en el OFFSCREEN, no en el service worker: el SW
   puede morir a mitad de grabación y perderlo todo. Los wrappers de
   console.*, fetch y XHR quedan instalados en la página tras parar
   (inofensivo: el bridge sigue enviando y nadie graba); por eso todos los
   scripts llevan guarda de doble inyección y una segunda grabación en la
   misma pestaña reutiliza los ya inyectados. Consecuencia: el offscreen
   FILTRA por tipo según los interruptores de la grabación en curso
   (`acceptsEntry`), porque un wrapper instalado en una grabación anterior
   sigue emitiendo aunque su interruptor esté ahora apagado.
8. `sw:complete` lleva `files[]` (vídeo + logs). El background lanza todas
   las descargas y solo limpia blobs/contextos cuando TODAS terminan
   (`pendingDownloads` en storage.session, eventos en serie).

## Probar

1. `chrome://extensions` → Modo de desarrollador → "Cargar descomprimida"
   → esta carpeta.
2. Recargar la extensión tras cada cambio (no hay hot reload).
3. Logs: consola del service worker (`[SW]`) y, en "Inspeccionar vistas",
   `offscreen.html` (`[offscreen]`) y `recorder.html` (`[recorder]`).
4. Salida: `Descargas/grabaciones-pantalla/grabacion-<fecha>.webm` y, según
   interruptores (flujo de pestaña, página http/https),
   `grabacion-<fecha>.console.log` + `.console.json` y `grabacion-<fecha>.har`.
   MP4: `ffmpeg -i entrada.webm -c:v libx264 -c:a aac salida.mp4`.
5. Probar el registro de consola: grabar una pestaña, ejecutar en su consola
   `console.warn("hola"); setTimeout(() => { throw new Error("boom"); });`
   y comprobar que ambos aparecen en el `.console.log` con su offset.
6. Probar el registro de red: en la misma grabación, ejecutar
   `fetch("https://httpstat.us/500"); fetch("/no-existe-404")` y comprobar
   que ambas aparecen como NET en el `.console.log` y que el `.har`
   (arrastrarlo a la pestaña Red de DevTools) contiene todas las peticiones.
