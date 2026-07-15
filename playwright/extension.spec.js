"use strict";

// E2E for the REAL extension loaded in Chromium: service worker, popup on
// chrome-extension://, chrome.storage and the QA-log injection and
// re-injection via chrome.scripting. This is the layer Cypress cannot
// reach; the capture engine itself is tested in cypress/e2e/*.

const { test, expect, BASE } = require("./fixtures");

const SANDBOX = `${BASE}/cypress/pages/sandbox.html`;

test("the service worker registers and the manifest exposes the QA-mode permissions", async ({ sw }) => {
  expect(sw.url()).toContain("background.js");
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(
    expect.arrayContaining(["tabCapture", "desktopCapture", "offscreen", "scripting", "downloads"])
  );
  expect(manifest.host_permissions).toEqual(
    expect.arrayContaining(["http://*/*", "https://*/*"])
  );
});

test("the popup starts idle with QA mode on by default", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("body")).toHaveAttribute("data-state", "idle");
  await expect(popup.locator("#consoleLog")).toBeChecked();
  await expect(popup.locator("#networkLog")).toBeChecked();
  await expect(popup.locator("#stepsLog")).toBeChecked();
  await expect(popup.locator("#btnTab")).toBeVisible();
  await expect(popup.locator("#btnScreen")).toBeVisible();
});

test("the popup toggles persist in chrome.storage.local", async ({ context, extensionId, sw }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // The checkbox is unchecked in the raw HTML and the popup's async init
  // checks it from storage defaults. Interacting before init finishes
  // would make uncheck() a no-op (flaky on slow CI runners): wait for the
  // init to land first.
  await expect(popup.locator("#networkLog")).toBeChecked();

  // Clicking the checkbox directly works thanks to the switch track's
  // pointer-events:none (an accessibility fix this very suite surfaced).
  await popup.locator("#networkLog").uncheck();
  await expect
    .poll(async () => (await sw.evaluate(() => chrome.storage.local.get("networkLog"))).networkLog)
    .toBe(false);

  // The state survives reopening the popup.
  await popup.reload();
  await expect(popup.locator("#networkLog")).not.toBeChecked();
  await expect(popup.locator("#consoleLog")).toBeChecked();

  await popup.locator("#networkLog").check();
  await expect
    .poll(async () => (await sw.evaluate(() => chrome.storage.local.get("networkLog"))).networkLog)
    .toBe(true);
});

test("the popup reflects the recording state live (storage.session)", async ({ context, extensionId, sw }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("body")).toHaveAttribute("data-state", "idle");

  await sw.evaluate(() =>
    chrome.storage.session.set({ isRecording: true, startTime: Date.now(), captureTarget: "offscreen" })
  );
  await expect(popup.locator("body")).toHaveAttribute("data-state", "recording");
  await expect(popup.locator("#timer")).toBeVisible();
  await expect(popup.locator("#consoleLog")).toBeDisabled();
  await expect(popup.locator("#btnStop")).toBeVisible();
  await expect(popup.locator("#btnMarker")).toBeVisible();
  await expect(popup.locator("#btnAnnotate")).toBeVisible();

  // Markers/annotations only exist in the tab flow: in a screen/window
  // recording the buttons hide instead of being silent no-ops.
  await sw.evaluate(() => chrome.storage.session.set({ captureTarget: "recorder" }));
  await expect(popup.locator("#btnMarker")).toBeHidden();
  await expect(popup.locator("#btnAnnotate")).toBeHidden();
  await expect(popup.locator("#btnStop")).toBeVisible();

  await sw.evaluate(() =>
    chrome.storage.session.set({ isRecording: false, startTime: null, captureTarget: null })
  );
  await expect(popup.locator("body")).toHaveAttribute("data-state", "idle");
});

test("injectQaCapture installs the real wrappers into a page's MAIN world", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(SANDBOX);

  // Collector in the page's world, BEFORE injecting.
  await page.evaluate(() => {
    window.__caught = [];
    window.addEventListener("message", (e) => {
      const entry = e.data && e.data.__qaRecorderConsole;
      if (entry) window.__caught.push(entry);
    });
  });

  const tabId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab.id;
  }, SANDBOX);

  await sw.evaluate(
    (tabId) =>
      injectQaCapture(tabId, { consoleCapture: true, networkCapture: true, stepsCapture: true }),
    tabId
  );

  await expect.poll(() => page.evaluate(() => window.__qaRecorderMainInstalled)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__qaRecorderNetInstalled)).toBe(true);

  // The wrappers actually work: console, fetch and a real click publish
  // entries (steps-capture.js runs in the isolated world, so its flag is
  // not visible from page.evaluate: it is verified by behavior).
  await page.evaluate(() => {
    console.log("hello from the page");
    return fetch("/api/error").then(() => {});
  });
  await page.click("#btnDemo");
  await page.waitForFunction(() =>
    window.__caught.some((e) => e.kind === "console" && e.text === "hello from the page")
  );
  await page.waitForFunction(() =>
    window.__caught.some((e) => e.kind === "net" && e.net && e.net.status === 500)
  );
  await page.waitForFunction(() =>
    window.__caught.some((e) => e.kind === "step" && e.text.includes("<button#btnDemo"))
  );
});

test("if the recorded tab navigates, tabs.onUpdated re-injects the logs", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(SANDBOX);
  const tabId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab.id;
  }, SANDBOX);

  // "Tab recording in progress" state exactly as startTabRecording leaves
  // it (without needing tabCapture, which requires a real user gesture).
  await sw.evaluate((tabId) =>
    chrome.storage.session.set({
      isRecording: true,
      captureTarget: "offscreen",
      recordedTabId: tabId,
      consoleCapture: true,
      networkCapture: true,
    }),
    tabId
  );

  await page.goto(`${SANDBOX}?after-navigation=1`);
  await expect.poll(() => page.evaluate(() => window.__qaRecorderMainInstalled === true)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__qaRecorderNetInstalled === true)).toBe(true);

  await sw.evaluate(() => chrome.storage.session.set({ isRecording: false, recordedTabId: null }));
});

test("the annotation is toggled from the background and draws over the recorded page", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(SANDBOX);
  const tabId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab.id;
  }, SANDBOX);
  await sw.evaluate(
    (tabId) =>
      injectQaCapture(tabId, { consoleCapture: false, networkCapture: false, stepsCapture: false }),
    tabId
  );

  // Same path as the popup button and the shortcut: a message to the tab.
  await sw.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "annotate:toggle" }), tabId);
  await expect(page.locator("#qa-recorder-annotate")).toBeVisible();

  // A real mouse stroke paints pixels on the canvas.
  await page.mouse.move(200, 300);
  await page.mouse.down();
  await page.mouse.move(280, 360, { steps: 5 });
  await page.mouse.up();
  const painted = await page.evaluate(() => {
    const c = document.querySelector("#qa-recorder-annotate canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
  });
  expect(painted).toBe(true);

  await sw.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "annotate:toggle" }), tabId);
  await expect(page.locator("#qa-recorder-annotate")).toBeHidden();
});

test("downloads are tracked in groups: chained recordings do not clobber each other", async ({ sw }) => {
  // Two recordings with downloads in flight at once (the 2nd finished
  // before the 1st's downloads did). handleDownloadChanged must clean up
  // each group separately without touching the other.
  await sw.evaluate(() =>
    chrome.storage.session.set({
      isRecording: false,
      pendingDownloads: {
        groups: [
          { ids: [101, 102], urls: ["blob:a", "blob:b"], from: "offscreen" },
          { ids: [201], urls: ["blob:c"], from: "offscreen" },
        ],
      },
    })
  );

  await sw.evaluate(() => handleDownloadChanged({ id: 101, state: { current: "complete" } }));
  let s = await sw.evaluate(() => chrome.storage.session.get("pendingDownloads"));
  expect(s.pendingDownloads.groups).toEqual([
    { ids: [102], urls: ["blob:a", "blob:b"], from: "offscreen" },
    { ids: [201], urls: ["blob:c"], from: "offscreen" },
  ]);

  // An id that belongs to none of our downloads touches nothing.
  await sw.evaluate(() => handleDownloadChanged({ id: 999, state: { current: "complete" } }));
  s = await sw.evaluate(() => chrome.storage.session.get("pendingDownloads"));
  expect(s.pendingDownloads.groups).toHaveLength(2);

  // The whole first group finishes: it disappears; the second stays intact.
  await sw.evaluate(() => handleDownloadChanged({ id: 102, state: { current: "interrupted" } }));
  s = await sw.evaluate(() => chrome.storage.session.get("pendingDownloads"));
  expect(s.pendingDownloads.groups).toEqual([{ ids: [201], urls: ["blob:c"], from: "offscreen" }]);

  // And once the last group finishes, no bookkeeping is left.
  await sw.evaluate(() => handleDownloadChanged({ id: 201, state: { current: "complete" } }));
  s = await sw.evaluate(() => chrome.storage.session.get("pendingDownloads"));
  expect(s.pendingDownloads).toBeNull();
});

test("with Jira configured, the report creates an issue from the service worker (mock)", async ({ sw }) => {
  await sw.evaluate(
    (base) =>
      chrome.storage.local.set({
        issueReporter: {
          provider: "jira",
          autoCreate: true,
          jira: {
            siteUrl: base + "/mock/jira",
            email: "tester@example.com",
            apiToken: "secret-token",
            projectKey: "QA",
          },
        },
      }),
    BASE
  );

  // Same path as when a recording with a report stops.
  await sw.evaluate(() =>
    reportIssueIfConfigured({ title: "[QA Recorder] Demo", text: "# test report" })
  );

  const { notice } = await sw.evaluate(() => chrome.storage.session.get({ notice: null }));
  expect(notice.kind).toBe("ok");
  expect(notice.text).toContain("QA-123");
  expect(notice.text).toContain("/mock/jira/browse/QA-123");

  // The mock received the authenticated request with the right title.
  const last = await sw.evaluate(async (base) => (await fetch(base + "/mock/__last")).json(), BASE);
  expect(last.jira.authorization).toContain("Basic ");
  expect(last.jira.body.fields.summary).toBe("[QA Recorder] Demo");
});

test("without autoCreate, the report creates NO issues even with credentials", async ({ sw }) => {
  await sw.evaluate(
    (base) =>
      chrome.storage.local.set({
        issueReporter: {
          provider: "jira",
          autoCreate: false,
          jira: { siteUrl: base + "/mock/jira", email: "x@x", apiToken: "t", projectKey: "QA" },
        },
      }),
    BASE
  );
  await sw.evaluate(() => reportIssueIfConfigured({ title: "Should not upload", text: "x" }));
  const { notice } = await sw.evaluate(() => chrome.storage.session.get({ notice: null }));
  expect(notice).toBeNull();
});

test("startTabRecording without a user gesture fails with a notice and no stuck recording", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(SANDBOX);
  await page.bringToFront();

  // chrome.tabCapture requires the user to have invoked the extension; in
  // a test there is no real gesture, so it must fail down the controlled
  // path: a popup notice and clean state.
  await sw.evaluate(() => startTabRecording());

  await expect
    .poll(async () => {
      const s = await sw.evaluate(() =>
        chrome.storage.session.get({ notice: null, isRecording: false })
      );
      return s.notice && s.notice.kind;
    })
    .toBe("error");

  const s = await sw.evaluate(() =>
    chrome.storage.session.get({ notice: null, isRecording: false })
  );
  expect(s.isRecording).toBe(false);
  expect(s.notice.text).toContain("Could not record this tab");
});
