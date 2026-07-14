# Grabador de pantalla · modo QA

Extensión de Chrome (Manifest V3) para grabar pantalla, ventana o pestaña, pensada para reportar bugs: además del vídeo, registra la consola y los errores JS de la página, sincronizados con la grabación. Sin límites de tiempo, sin marca de agua, sin cuenta.

## Qué hace

- Graba la pestaña actual con un clic, audio incluido automáticamente
- **Modo QA**: al grabar una pestaña, captura `console.log/warn/error`, excepciones no controladas, promesas rechazadas y recursos que no cargan (404 de imágenes/scripts), cada entrada con su offset `+mm:ss.mmm` respecto al vídeo — "el error saltó en el segundo 12" deja de ser una frase y pasa a ser una línea de log
- **Red incluida**: registra todas las peticiones `fetch`/XHR (método, URL, status, duración, headers) y las exporta en formato **HAR**, que se abre arrastrándolo a la pestaña Red de cualquier DevTools; los fallos (errores de red/CORS y 4xx/5xx) aparecen además en la línea de tiempo del log, entre los errores de consola
- Junto al `.webm` descarga `*.console.log` (legible, listo para pegar en un ticket), `*.console.json` (estructurado, con metadatos de página y navegador) y `*.har` (red completa)
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

## Roadmap

La dirección es un grabador orientado a reportes de bugs de QA. Hecho y pendiente:

- [x] Registro de consola y errores JS sincronizado con el vídeo
- [x] Peticiones de red (`fetch`/XHR con status, duración y headers), exportadas en HAR; los fallos, también en la línea de tiempo del log
- [ ] Pasos para reproducir generados automáticamente (clicks y navegaciones con timestamp)
- [ ] Informe empaquetado: vídeo + logs + red + pasos + metadatos del entorno, listo para pegar en Jira o Linear
- [ ] Marcadores durante la grabación («aquí está el bug») con atajo de teclado

El registro de consola solo aplica al flujo de pestaña (una grabación de pantalla completa no tiene una pestaña asociada de la que leer) y a páginas `http(s)`.

## Licencia

MIT. Ver [`LICENSE`](./LICENSE).
