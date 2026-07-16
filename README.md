# Screen Recorder · QA mode

[![tests](https://github.com/pedro-morago/grabador-pantalla/actions/workflows/tests.yml/badge.svg)](https://github.com/pedro-morago/grabador-pantalla/actions/workflows/tests.yml)

A Chrome extension (Manifest V3) that records your screen, a window or a tab, built for bug reporting: besides the video, it logs the page's console, JS errors, network and user steps — all synced with the recording — and condenses everything into a paste-ready report. No time limits, no watermark, no account.

## What it does

- Records the current tab in one click, audio included automatically
- **QA mode**: while recording a tab, it captures `console.log/warn/error`, uncaught exceptions, unhandled promise rejections and resources that fail to load (image/script 404s), each entry with its `+mm:ss.mmm` offset into the video — "the error popped at second 12" stops being a sentence and becomes a log line
- **Network included**: records every `fetch`/XHR request (method, URL, status, duration, headers) and exports it as **HAR**, which opens by dragging it onto any DevTools' Network tab; failures (network/CORS errors and 4xx/5xx) also show up on the log's timeline, right between the console errors
- **Automatic steps to reproduce**: clicks (attributed to the real button, not the decorative `<span>`), field changes, form submits and navigations — **including SPA route changes** (`pushState`, verified to be observable from the isolated world via the Navigation API) — numbered with their offset in `*.steps.md`. Privacy rule: **typed values are never recorded** — a bug report doesn't need the tester's password
- **"The bug is here" markers**: `Ctrl/Cmd+Shift+K` or the popup's 💥 button drop a timestamped mark mid-recording, highlighted later in the report
- **On-video annotations**: `Ctrl/Cmd+Shift+Y` or the popup's ✏️ button open a drawing canvas over the recorded tab (three colors, clear, Esc to exit). Since the strokes are DOM inside the page, the capture records them without touching the video pipeline — and drawing gestures don't pollute the steps log
- **Recording report** `*.report.md`: environment (URL, Chrome, OS, language, timezone, duration), a summary of JS errors / broken resources / failed requests, markers, timeline errors and steps — the ticket almost writes itself
- **Automatic Jira or Linear issue**: configure your credentials in the extension's Options (token kept in `chrome.storage.local` only, "Test connection" button) and, when each recording stops, the report becomes a new issue — the link shows up in the popup. Jira Cloud via REST (Basic auth with an API token) and Linear via GraphQL (the team key is resolved to an id automatically)
- Alongside the `.webm` it downloads `*.console.log` (readable), `*.console.json` (structured), `*.har` (full network), `*.steps.md` and `*.report.md`
- Records the full screen or a window through Chrome's native picker
- Optional microphone, mixed with the captured audio
- Three quality levels (bitrate/fps)
- Exports `.webm`; MP4 conversion documented below

Example `*.console.log`:

```
# Console log — Screen Recorder (QA mode)
# Page: Checkout — https://shop.example/checkout
# Video start: 2026-07-14T11:02:41.000Z
# 5 entries

[+00:00.000] NAV   https://shop.example/checkout
[+00:07.412] WARN  low stock for SKU-1042
[+00:11.951] NET   POST https://api.example/cart/total → 500 Internal Server Error (132 ms)
[+00:12.083] ERROR TypeError: Cannot read properties of undefined (reading 'total')
    at https://shop.example/js/cart.js:88:17
[+00:12.090] ERROR Resource failed to load: <img> https://cdn.example/promo.png
```

The API's 500 and the `TypeError` it causes, 130 ms apart, in the same file: the root cause ships pre-installed in the report.

## Why it exists

A portfolio exercise: reproduce the mechanics of tools like Nimbus or Loom using only native browser APIs, no external dependencies. The screen-recorder market is saturated and better free alternatives exist (Screenity, for one), so the point is not competing with them. The point is understanding how Manifest V3 behaves when the capture has to survive in the background, and debugging it with the same method I use in QA: isolate the symptom, read the console, take nothing for granted.

## Decisions and dead ends

Manifest V3 imposes security constraints that aren't well documented until you break them. Four of the costliest:

**1. The service worker cannot open the desktop picker without `targetTab`, and with `targetTab` the result is useless.**
`chrome.desktopCapture.chooseDesktopMedia` demands a target tab when called from a service worker (`A target tab is required when called from a service worker context`). But passing that tab binds the resulting `streamId` to that web page's origin, and no extension context can consume it afterwards. The way out: the picker doesn't live in the service worker, it lives in a dedicated extension window (`recorder.html`), which also consumes the `streamId` in the same frame that requested it — the only place Chrome guarantees it works.

**2. Tabs and desktop don't share a pipe.**
A `chrome.tabCapture` `streamId` is only valid with `chromeMediaSource: "tab"`; one from the desktop picker, only with `"desktop"`. Mixing them yields `AbortError: Error starting tab capture`, with no further context. They are two separate flows: tab via `tabCapture.getMediaStreamId` (invisible offscreen document), desktop via the picker (a visible window that minimizes itself while recording).

**3. Chrome mutes the tab you capture.**
Without fixing it, you record video with audio but stop hearing the tab while recording. The solution re-injects the captured audio into the speakers via `AudioContext`, only in the tab flow (in full screen it would duplicate system sound).

**4. To wrap `console.*` (or `fetch`) you must live in the page's world, where the extension doesn't exist.**
A normal content script runs in an isolated world: it sees the same DOM but ANOTHER `console` and ANOTHER `fetch`, so wrapping them there captures nothing the page does. Real capture demands injecting into `world: "MAIN"`, where in exchange there is no `chrome.runtime` to talk to the extension. Hence the structure: the MAIN-world scripts wrap `console.*`, `fetch` and `XMLHttpRequest` and publish each entry with `postMessage`; a bridge in the isolated world batches and relays them. And they accumulate in the offscreen document, not the service worker, because the service worker can die mid-recording and take the log with it. A third trap from the same pit: when the tab navigates, the injected scripts vanish — `tabs.onUpdated` re-injects them as soon as the new document starts loading. And a fourth: the wrappers stay installed in the page after stopping, so the offscreen filters what arrives by the current recording's toggles, not by which wrappers exist.

The full technical detail, written so a Claude Code session can read it before touching code, is in [`CLAUDE.md`](./CLAUDE.md).

## Install

1. Clone the repo
2. `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the repo folder

## E2E tests (Cypress + Playwright)

```bash
npm install
npx playwright install chromium   # first time only

npm run lint              # ESLint (flat config), also enforced in CI
npm run test:e2e          # Cypress headless (Electron)
npm run test:e2e:chrome   # Cypress in Chrome, also loading the real extension
npm run cypress:open      # Cypress interactive
npm run test:ext          # Playwright: the real extension loaded in Chromium
npm run test:all          # everything
```

Two tools, one layer each — choosing what gets tested with which, and knowing what each one CANNOT test, is part of what this repo wants to demonstrate:

**Cypress covers the capture engine** (`cypress/e2e/`). The tests start a local server, load test pages, inject the **extension's real scripts** (the same files `chrome.scripting.executeScript` injects in production) and verify the observable behavior:

- `console-capture.cy.js` — console wrapper: levels and arguments, exceptions, rejected promises, 404 resources, circular objects, symbols/bigints, huge-message truncation, double-injection guard
- `network-capture.cy.js` — network wrapper: fetch 200/500, relative URL resolution, network failures with status 0, XHR with request/response headers, reused XHR without duplicates, double-injection guard
- `bridge.cy.js` — isolated-world bridge: navigation entries (including SPA `pushState` navigations via the Navigation API, deduped by href), batching, immediate flush at 50 entries
- `reports.cy.js` — offscreen report builders: offset format, toggle filtering, `.console.log`/`.console.json`, `.steps.md`, `.report.md` and HAR validity (pages per navigation, `pageref` by timestamp, queryString)
- `annotate.cy.js` — annotation surface: toggle, drawing with pixels verified on the canvas, clear, Esc, and drawing gestures not polluting the steps log
- `issue-reporter.cy.js` — issue creation with real fetch against Jira/Linear mocks that capture the request: auth, payload, Linear team resolution, HTTP error propagation

Cypress cannot navigate to `chrome-extension://` or talk to the service worker, and that's where the other suite comes in.

**Playwright covers the real extension** (`playwright/`): a persistent context with `--load-extension`, direct access to the MV3 service worker and to the popup as a `chrome-extension://` page:

- the service worker registers and the manifest exposes the QA-mode permissions
- the popup starts idle with QA mode on by default, and its toggles persist in `chrome.storage.local`
- the popup reacts live to the recording state (`storage.session` + `storage.onChanged`)
- `injectQaCapture` injects the real wrappers via `chrome.scripting` into the MAIN world, and they work (console, fetch and a real click publish entries)
- if the recorded tab navigates, `tabs.onUpdated` re-injects the logs
- the annotation is toggled from the background (same path as the popup and the shortcut) and a real mouse stroke paints pixels on the canvas
- downloads are tracked in groups: two chained recordings don't clobber each other's blob cleanup
- with Jira configured, the report creates an issue from the real service worker (against the mock), and without `autoCreate` nothing is created even with credentials
- `startTabRecording` without a user gesture fails down the controlled path: a popup notice and clean state

**The only stretch not automated** is the heart of the capture: `tabCapture`/`desktopCapture` require a real user gesture on the extension (a toolbar click or the native picker), which no framework can fabricate. That stretch is covered by the manual checklist in [`CLAUDE.md`](./CLAUDE.md) — and the Playwright test at least verifies that, without that gesture, the failure is clean and explained.

## Roadmap

The direction is a recorder built for QA bug reports. Done and pending:

- [x] Console and JS error log synced with the video
- [x] Network requests (`fetch`/XHR with status, duration and headers), exported as HAR; failures also on the log's timeline
- [x] Automatically generated steps to reproduce (clicks, fields and forms with timestamps, no values)
- [x] Packaged report: environment + summary + markers + errors + steps, paste-ready for Jira or Linear
- [x] Mid-recording markers ("the bug is here") with a keyboard shortcut and a popup button
- [x] Two-layer E2E tests (Cypress + Playwright) with CI on GitHub Actions
- [x] On-video annotations while recording (a DOM canvas over the tab: the capture records it for free)
- [x] Direct report upload to Jira/Linear via API, with an options page and connection test
- [ ] Automatically attach the files (video, HAR) to the created issue
- [ ] Firefox port (WebExtensions: `browser.*`, no offscreen documents)

QA logs only apply to the tab flow (a full-screen recording has no associated tab to read from) and to `http(s)` pages.

## License

MIT. See [`LICENSE`](./LICENSE).
