# Screen Recorder (Chrome MV3 extension)

Screen recording extension with no time limits and no watermark, plus a
QA mode: console, JS errors, network (HAR export), user steps and a bug
report, all synced with the video. Plain JS, no build step: loaded
unpacked in Chrome.

## Architecture

- `background.js` (service worker): orchestrates state, messages and
  downloads. State in `chrome.storage.session` (the popup reads it
  directly).
- `offscreen.html/js`: records the current TAB from a
  `chrome.tabCapture.getMediaStreamId` streamId. Invisible.
- `recorder.html/js`: dedicated window that records SCREEN or WINDOW. It
  opens the picker and consumes the streamId in its OWN frame. Minimizes
  while recording and closes itself on save. If closed by hand, the
  recording is lost.
- `capture-common.js`: shared utilities (quality, mime, audio mixing).
- `popup.html/js`: control UI. `permission.html/js`: one-time microphone
  permission grant.
- QA logs (tab flow ONLY): `console-capture-main.js` (MAIN world: wraps
  console.*, window error/unhandledrejection and resource load errors),
  `network-capture-main.js` (MAIN world: wraps fetch and XMLHttpRequest;
  method, URL, status, duration, bounded headers) and `steps-capture.js`
  (ISOLATED world: clicks, field changes and submits; NEVER records typed
  values) + `console-capture-bridge.js` (isolated world: batches entries
  and relays them to the offscreen; shared by all). The background
  injects them according to the toggles with
  `chrome.scripting.executeScript` on start and RE-INJECTS them on
  `tabs.onUpdated` (status "loading") if the tab navigates. Markers: the
  `add-marker` command (Ctrl/Cmd+Shift+K) or the popup button →
  background → `off:marker`. The offscreen accumulates the entries and on
  stop generates `.console.log` and `.console.json` (offsets `+mm:ss.mmm`
  relative to the video start), `.har` (HAR 1.2; navigations are the
  "pages"), `.steps.md` (numbered navs + steps + markers) and
  `.report.md` (environment, counters, markers, errors, files). In the
  `.console.log`, network only shows up if it failed (network/CORS error
  or status >= 400); the full network goes to the `.har`.
- Annotations (tab flow ONLY): `annotate-overlay.js` (isolated world,
  ALWAYS injected with the others, independent of the toggles) mounts a
  fixed canvas over the page; being DOM, the capture records it without
  touching the video. Toggle: the `toggle-annotate` command
  (Ctrl/Cmd+Shift+Y) or the popup button → background →
  `chrome.tabs.sendMessage(recordedTabId, "annotate:toggle")`. Clicks on
  `#qa-recorder-annotate` are excluded from the steps log.
- Jira/Linear issues: `issue-reporter.js` (pure logic + fetch, NO
  chrome.*: loaded with importScripts in the SW, with <script> in
  options.html and in the tests) and `options.html/js` (credentials in
  `chrome.storage.local.issueReporter`, test-connection button). On stop,
  the offscreen adds `report: {title, text}` to `sw:complete` and the
  background creates the issue if a provider with autoCreate is set
  ("ok" notice with the link in the popup). Jira REST v2 (v3 requires
  ADF), Linear GraphQL with the team key resolved to an id. Test mocks
  live in `cypress/support/static-server.js` (`/mock/jira/*`,
  `/mock/linear/graphql`, `/mock/__last` returns the last request).
- Messaging: `chrome.runtime.sendMessage` with a `target` field
  ("background" | "offscreen" | "recorder").

## MV3 constraints learned the hard way (do NOT revert)

1. `chrome.desktopCapture.chooseDesktopMedia` from the service worker
   REQUIRES `targetTab` ("A target tab is required when called from a
   service worker context"), and with `targetTab` the streamId is bound
   to that web page's origin, unusable from extension contexts. That is
   why the picker lives in `recorder.html`, not in the SW.
2. The desktop picker's streamId is only reliably consumed in the SAME
   frame that requested it. Do not hand it to the offscreen document.
3. Tabs and desktop use different getUserMedia sources:
   `chromeMediaSource: "tab"` for tabCapture streamIds,
   `chromeMediaSource: "desktop"` for the screen/window picker. Mixing
   them produces `AbortError: Error starting tab capture`.
4. Chrome mutes the tab while it is captured: audio playthrough via
   AudioContext exists ONLY in the tab flow (in full screen it would
   duplicate system sound).
5. The offscreen document cannot show the microphone permission prompt:
   the initial grant happens in `permission.html`.
6. The `mandatory: { chromeMediaSource, chromeMediaSourceId }` syntax is
   legacy but it is the one required for this kind of capture.
7. QA logs: `chrome.runtime` does not exist in the MAIN world, hence the
   split scripts (main → postMessage → bridge → offscreen). Entries
   accumulate in the OFFSCREEN document, not the service worker: the SW
   can die mid-recording and lose everything. The console.*, fetch and
   XHR wrappers stay installed in the page after stopping (harmless: the
   bridge keeps sending and nobody records); that is why every script has
   a double-injection guard and a second recording on the same tab reuses
   the already-injected ones. Consequence: the offscreen FILTERS by kind
   according to the current recording's toggles (`acceptsEntry`), because
   a wrapper installed by a previous recording keeps emitting even if its
   toggle is now off.
8. `sw:complete` carries `files[]` (video + logs). The background starts
   every download and tracks them in GROUPS (`pendingDownloads.groups` in
   storage.session, events processed serially): if the user chains
   recordings, the previous one's downloads may still be in flight, so
   each group revokes its blobs separately (`off:cleanup`), the offscreen
   revokes NOTHING at finalize, and it is not closed while any of its
   groups are pending.

## Testing

1. `chrome://extensions` → Developer mode → "Load unpacked" → this
   folder.
2. Reload the extension after every change (no hot reload).
3. Logs: service worker console (`[SW]`) and, under "Inspect views",
   `offscreen.html` (`[offscreen]`) and `recorder.html` (`[recorder]`).
4. Output: `Downloads/screen-recordings/recording-<date>.webm` and,
   depending on the toggles (tab flow, http/https page),
   `recording-<date>.console.log` + `.console.json`, `.har`, `.steps.md`
   and `.report.md`.
   MP4: `ffmpeg -i input.webm -c:v libx264 -c:a aac output.mp4`.
5. Test the console log: record a tab, run in its console
   `console.warn("hi"); setTimeout(() => { throw new Error("boom"); });`
   and check both appear in the `.console.log` with their offset.
6. Test the network log: in the same recording, run
   `fetch("https://httpstat.us/500"); fetch("/missing-404")` and check
   both appear as NET in the `.console.log` and that the `.har` (drag it
   onto DevTools' Network tab) contains every request.
7. E2E tests: `npm install && npm run test:all`. Two suites:
   - Cypress (`cypress/e2e/`): the QA engine (wrappers, bridge, reports)
     injecting the REAL scripts into test pages served by
     `cypress/support/static-server.js`. The `reports.cy.js` harness
     loads offscreen.js with a chrome.* stub; if you rename top-level
     functions or variables of offscreen.js, those tests will notice.
   - Playwright (`playwright/`): the REAL extension loaded in Chromium
     (service worker, chrome-extension:// popup, storage, injection and
     re-injection via chrome.scripting). Requires
     `npx playwright install chromium` (or `CHROMIUM_PATH` pointing at a
     binary). Tests call top-level background.js functions
     (`injectQaCapture`, `startTabRecording`) by evaluating in the SW: if
     you rename them, those tests will notice.
   The ONLY thing not automated is the capture itself:
   tabCapture/desktopCapture demand a real user gesture (no framework can
   fabricate one); that stretch is covered by steps 1-6.
