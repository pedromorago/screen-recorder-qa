# Grabador de pantalla · modo QA

[![tests](https://github.com/pedro-morago/grabador-pantalla/actions/workflows/tests.yml/badge.svg)](https://github.com/pedro-morago/grabador-pantalla/actions/workflows/tests.yml)

Extensión de Chrome (Manifest V3) para grabar pantalla, ventana o pestaña, pensada para reportar bugs: además del vídeo, registra la consola, los errores JS, la red y los pasos del usuario, todo sincronizado con la grabación, y lo condensa en un informe listo para pegar en un ticket. Sin límites de tiempo, sin marca de agua, sin cuenta.

## Qué hace

- Graba la pestaña actual con un clic, audio incluido automáticamente
- **Modo QA**: al grabar una pestaña, captura `console.log/warn/error`, excepciones no controladas, promesas rechazadas y recursos que no cargan (404 de imágenes/scripts), cada entrada con su offset `+mm:ss.mmm` respecto al vídeo — "el error saltó en el segundo 12" deja de ser una frase y pasa a ser una línea de log
- **Red incluida**: registra todas las peticiones `fetch`/XHR (método, URL, status, duración, headers) y las exporta en formato **HAR**, que se abre arrastrándolo a la pestaña Red de cualquier DevTools; los fallos (errores de red/CORS y 4xx/5xx) aparecen además en la línea de tiempo del log, entre los errores de consola
- **Pasos para reproducir automáticos**: clicks (atribuidos al botón real, no al `<span>` decorativo), cambios de campo y envíos de formulario, numerados con su offset en `*.pasos.md`. Regla de privacidad: **jamás se registra el valor tecleado** — un reporte no necesita la contraseña del tester
- **Marcadores «aquí está el bug»**: `Ctrl/Cmd+Shift+K` o el botón 💥 del popup dejan una marca con timestamp en plena grabación, que luego destaca en el informe
- **Anotaciones sobre el vídeo**: `Ctrl/Cmd+Shift+Y` o el botón ✏️ del popup abren un lienzo de dibujo sobre la pestaña grabada (tres colores, borrar, Esc para salir). Como el trazo es DOM de la página, la captura lo graba sin tocar el pipeline de vídeo — y los gestos de dibujo no ensucian el registro de pasos
- **Informe empaquetado** `*.informe.md`: entorno (URL, Chrome, SO, idioma, zona horaria, duración), resumen de errores JS / recursos rotos / peticiones fallidas, marcadores, errores en línea de tiempo y pasos — el ticket casi se escribe solo
- Junto al `.webm` descarga `*.console.log` (legible), `*.console.json` (estructurado), `*.har` (red completa), `*.pasos.md` e `*.informe.md`
- Sobrevive a navegaciones: si la pestaña cambia de página a mitad de grabación, el registro continúa y anota la URL nueva en la línea de tiempo
- Graba pantalla completa o una ventana, con el selector nativo de Chrome
- Micrófono opcional, mezclado con el audio capturado
- Tres niveles de calidad (bitrate/fps)
- Exporta a `.webm`; conversión a MP4 documentada más abajo

Ejemplo de `*.console.log`:

```
# Registro de consola — Grabador de pantalla (modo QA)
# Página: Checkout — https://tienda.example/checkout
# Inicio del vídeo: 2026-07-14T11:02:41.000Z
# 4 entradas

[+00:00.000] NAV   https://tienda.example/checkout
[+00:07.412] WARN  stock bajo para SKU-1042
[+00:11.951] NET   POST https://api.example/cart/total → 500 Internal Server Error (132 ms)
[+00:12.083] ERROR TypeError: Cannot read properties of undefined (reading 'total')
    en https://tienda.example/js/cart.js:88:17
[+00:12.090] ERROR Recurso no cargado: <img> https://cdn.example/promo.png
```

El 500 de la API y el `TypeError` que provoca, a 130 ms el uno del otro, en el mismo fichero: la causa raíz viene puesta de serie en el reporte.

## Por qué existe

Ejercicio de portfolio: reproducir la mecánica de herramientas como Nimbus o Loom usando solo APIs nativas del navegador, sin dependencias externas. El mercado de grabadores de pantalla está saturado y hay alternativas gratuitas mejores (Screenity, por ejemplo), así que el interés no es competir con eso. Es entender cómo se comporta Manifest V3 cuando la captura tiene que sobrevivir en segundo plano, y depurarlo con el mismo método que uso en QA: aislar el síntoma, mirar la consola, no dar nada por sentado.

## Decisiones y callejones sin salida

Manifest V3 impone restricciones de seguridad que no están bien documentadas hasta que las rompes. Tres de las que más costaron:

**1. El service worker no puede abrir el selector de escritorio sin `targetTab`, y con `targetTab` el resultado es inservible.**
`chrome.desktopCapture.chooseDesktopMedia` exige una pestaña de destino si se llama desde un service worker (`A target tab is required when called from a service worker context`). Pero pasar esa pestaña ata el `streamId` resultante al origen de esa pestaña web, y ningún contexto de la extensión puede consumirlo después. La salida: el selector no vive en el service worker, vive en una ventana propia de la extensión (`recorder.html`), que además consume el `streamId` en el mismo frame que lo pidió — el único punto donde Chrome garantiza que funcione.

**2. Pestañas y escritorio no comparten tubería.**
Un `streamId` de `chrome.tabCapture` solo es válido con `chromeMediaSource: "tab"`; uno del selector de escritorio, solo con `"desktop"`. Mezclarlos da `AbortError: Error starting tab capture`, sin más contexto. Son dos flujos separados: pestaña por `tabCapture.getMediaStreamId` (documento offscreen, invisible), escritorio por el selector (ventana visible que se minimiza sola mientras graba).

**3. Chrome silencia la pestaña que capturas.**
Sin corregirlo, grabas vídeo con audio pero dejas de oír la pestaña mientras grabas. La solución reinyecta el audio capturado a los altavoces vía `AudioContext`, solo en el flujo de pestaña (en pantalla completa duplicaría el sonido del sistema).

**4. Para envolver `console.*` (o `fetch`) hay que vivir en el mundo de la página, donde la extensión no existe.**
Un content script normal corre en un mundo aislado: ve el mismo DOM pero OTRO objeto `console` y OTRO `fetch`, así que envolverlos ahí no captura nada de lo que hace la página. La captura real exige inyectar en el `world: "MAIN"`, donde a cambio no hay `chrome.runtime` para hablar con la extensión. De ahí la estructura: los scripts del mundo principal envuelven `console.*`, `fetch` y `XMLHttpRequest` y publican cada entrada con `postMessage`; un puente en el mundo aislado las agrupa y reenvía. Y las acumula el documento offscreen, no el service worker, porque el service worker puede morir a mitad de grabación y llevarse el registro consigo. Tercera trampa del mismo pozo: al navegar la pestaña, los scripts inyectados desaparecen — `tabs.onUpdated` los reinyecta en cuanto el documento nuevo empieza a cargar. Y una cuarta: los wrappers quedan instalados en la página después de parar, así que el offscreen filtra lo que llega según los interruptores de la grabación en curso, no según qué wrappers existan.

El detalle técnico completo, pensado para que una sesión de Claude Code lo lea antes de tocar código, está en [`CLAUDE.md`](./CLAUDE.md).

## Instalar

1. Clona el repo
2. `chrome://extensions` → activa **Modo de desarrollador**
3. **Cargar descomprimida** → selecciona la carpeta del repo

## Tests E2E (Cypress + Playwright)

```bash
npm install
npx playwright install chromium   # solo la primera vez

npm run test:e2e          # Cypress headless (Electron)
npm run test:e2e:chrome   # Cypress en Chrome, cargando además la extensión real
npm run cypress:open      # Cypress interactivo
npm run test:ext          # Playwright: la extensión real cargada en Chromium
npm run test:all          # todo
```

Dos herramientas, una capa cada una — elegir qué se testea con qué, y saber qué NO puede testear cada una, es parte de lo que este repo quiere demostrar:

**Cypress cubre el motor de captura** (`cypress/e2e/`). Los tests levantan un servidor local, cargan páginas de prueba e inyectan los **scripts reales de la extensión** (los mismos ficheros que inyecta `chrome.scripting.executeScript` en producción) y verifican el comportamiento observable:

- `console-capture.cy.js` — wrapper de consola: niveles y argumentos, excepciones, promesas rechazadas, recursos 404, objetos circulares, symbols/bigints, recorte de mensajes gigantes, guarda de doble inyección
- `network-capture.cy.js` — wrapper de red: fetch 200/500, resolución de URLs relativas, fallos de red con status 0, XHR con headers de petición/respuesta, XHR reutilizado sin duplicados, guarda de doble inyección
- `bridge.cy.js` — puente del mundo aislado: entrada de navegación, agrupación en lotes, vaciado inmediato a las 50 entradas
- `reports.cy.js` — generadores de informes del offscreen: formato de offsets, filtrado por interruptores, `.console.log`/`.console.json` y validez del HAR (pages por navegación, `pageref` por timestamp, queryString)
- `annotate.cy.js` — superficie de anotación: toggle, dibujo con píxeles verificados en el canvas, borrar, Esc, y que los gestos de dibujo no contaminan el registro de pasos

Cypress no puede navegar a `chrome-extension://` ni hablar con el service worker, y ahí es donde entra la otra suite.

**Playwright cubre la extensión real** (`playwright/`): contexto persistente con `--load-extension`, acceso directo al service worker MV3 y al popup como página `chrome-extension://`:

- el service worker registra y el manifest expone los permisos del modo QA
- el popup arranca en idle con el modo QA activo por defecto, y sus interruptores persisten en `chrome.storage.local`
- el popup reacciona en vivo al estado de grabación (`storage.session` + `storage.onChanged`)
- `injectQaCapture` inyecta los wrappers reales vía `chrome.scripting` en el world MAIN, y funcionan (console y fetch publican entradas)
- si la pestaña grabada navega, `tabs.onUpdated` reinyecta los registros
- la anotación se activa desde el background (mismo camino que el popup y el atajo) y un trazo real del ratón pinta píxeles en el lienzo
- las descargas se contabilizan por grupos: dos grabaciones encadenadas no se pisan la limpieza de blobs
- `startTabRecording` sin gesto de usuario falla por el camino controlado: aviso en el popup y estado limpio

**El único tramo no automatizado** es el corazón de la captura: `tabCapture`/`desktopCapture` exigen un gesto real del usuario sobre la extensión (clic en la barra de herramientas o selector nativo), que ningún framework puede fabricar. Ese tramo queda en el checklist manual de [`CLAUDE.md`](./CLAUDE.md) — y el test de Playwright verifica al menos que, sin ese gesto, el fallo es limpio y explicado.

## Roadmap

La dirección es un grabador orientado a reportes de bugs de QA. Hecho y pendiente:

- [x] Registro de consola y errores JS sincronizado con el vídeo
- [x] Peticiones de red (`fetch`/XHR con status, duración y headers), exportadas en HAR; los fallos, también en la línea de tiempo del log
- [x] Pasos para reproducir generados automáticamente (clicks, campos y formularios con timestamp, sin valores)
- [x] Informe empaquetado: entorno + resumen + marcadores + errores + pasos, listo para pegar en Jira o Linear
- [x] Marcadores durante la grabación («aquí está el bug») con atajo de teclado y botón en el popup
- [x] Tests E2E en dos capas (Cypress + Playwright) con CI en GitHub Actions
- [x] Anotaciones sobre el vídeo durante la grabación (lienzo DOM sobre la pestaña: la captura lo graba gratis)
- [ ] Subida directa del informe a Jira/Linear vía API

Los registros QA solo aplican al flujo de pestaña (una grabación de pantalla completa no tiene una pestaña asociada de la que leer) y a páginas `http(s)`.

## Licencia

MIT. Ver [`LICENSE`](./LICENSE).
