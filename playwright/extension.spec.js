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

test("stopping a capture that died without saving recovers instead of hanging", async ({ context, sw }) => {
  // Regression: the offscreen used to answer "ok" to off:stop even with no
  // live recorder, so the background never saw the desync. isRecording stayed
  // true for ever: every stop was answered "ok", nothing happened, and the
  // user had no way to stop and no error. Reproduced by hand before the fix.
  await sw.evaluate(() => ensureOffscreen());
  await expect
    .poll(async () =>
      sw.evaluate(() => chrome.runtime.sendMessage({ target: "offscreen", type: "off:stop" }))
    )
    .toEqual({ ok: true, stopping: false });

  // The background believes it is recording; the offscreen has nothing to save.
  await sw.evaluate(() =>
    chrome.storage.session.set({
      isRecording: true,
      startTime: Date.now(),
      captureTarget: "offscreen",
    })
  );

  await sw.evaluate(() => stopRecording());

  await expect
    .poll(async () => {
      const s = await sw.evaluate(() =>
        chrome.storage.session.get({ isRecording: false, notice: null })
      );
      return s.isRecording;
    })
    .toBe(false);

  const { notice } = await sw.evaluate(() => chrome.storage.session.get({ notice: null }));
  expect(notice.kind).toBe("error");
  expect(notice.text).toContain("The recording was lost");
});

test("the recorded container carries a duration, so the player can seek", async ({ context, extensionId }) => {
  // Regression: MediaRecorder writes WebM in streaming mode, with no Duration
  // in the header and no Cues index, so the player reports duration Infinity
  // and its scrub bar is useless — you cannot jump to the middle of your own
  // recording. That is why pickMime() prefers MP4. If this ever falls back to
  // WebM the recordings silently stop being navigable, which is why the
  // assertion is on the duration a real player reads, not on the mime string.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);

  const r = await page.evaluate(async () => {
    const mimeType = pickMime();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const c = canvas.getContext("2d");
    let n = 0;
    const paint = setInterval(() => {
      c.fillStyle = `hsl(${(n++ * 9) % 360} 70% 45%)`;
      c.fillRect(0, 0, 320, 180);
    }, 33);

    const chunks = [];
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((res) => (rec.onstop = res));
    rec.start(200);
    await new Promise((res) => setTimeout(res, 1500));
    rec.stop();
    await stopped;
    clearInterval(paint);

    const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    await new Promise((res) => {
      v.onloadedmetadata = res;
      v.onerror = res;
      setTimeout(res, 5000);
    });
    const duration = v.duration;
    URL.revokeObjectURL(url);
    return { mimeType, ext: extForMime(mimeType), duration };
  });

  expect(r.mimeType).toContain("mp4");
  expect(r.ext).toBe("mp4");
  expect(Number.isFinite(r.duration)).toBe(true);
  expect(r.duration).toBeGreaterThan(0.5);
});

test("a stop with nothing to save releases the capture instead of holding the tab", async ({ context, extensionId }) => {
  // Regression: recovering the background's state was NOT enough. A capture
  // whose recorder died keeps its tracks live, the tab stays held and Chrome
  // refuses the next recording with "Cannot capture a tab with an active
  // stream" — hit in real use right after the stop fix landed.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);

  const r = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    canvas.getContext("2d").fillRect(0, 0, 320, 180);
    const fake = canvas.captureStream(10);
    // The real streamId cannot be obtained without a user gesture; what is
    // under test is the lifecycle after the recorder dies, not the capture.
    navigator.mediaDevices.getUserMedia = async () => fake;

    await start({
      streamId: "irrelevant",
      systemAudio: false,
      mic: false,
      quality: "medium",
      consoleCapture: false,
      networkCapture: false,
      stepsCapture: false,
      tabUrl: "http://localhost/",
      tabTitle: "t",
    });
    const tracks = displayStream.getTracks();
    const before = tracks.map((t) => t.readyState);
    recorder = null; // the recorder died without ever finalizing
    const stopping = stopCapture();
    return { before, stopping, after: tracks.map((t) => t.readyState) };
  });

  expect(r.before.every((s) => s === "live")).toBe(true);
  expect(r.stopping).toBe(false);
  expect(r.after.every((s) => s === "ended")).toBe(true);
});

test("a report that throws costs its own file, never the video", async ({ context, extensionId }) => {
  // Regression, seen in the wild: chrome.runtime.getManifest() lived inside
  // buildHar(), i.e. inside finalize(). When an extension reload orphaned the
  // offscreen document its chrome.* APIs were gutted, the call threw
  // "is not a function", finalize() died before sw:complete and the whole
  // recording went with it — video included — leaving the state stuck.
  // The version is now read once at load; this covers the general rule.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);

  const r = await page.evaluate(() => {
    const sent = [];
    const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...rest) => {
      sent.push(m);
      try {
        return realSend(m, ...rest);
      } catch (e) {
        return undefined;
      }
    };

    const t0 = Date.now() - 20000;
    videoStartTime = t0;
    consoleEnabled = networkEnabled = stepsEnabled = true;
    qaMeta = { url: "https://example.test/checkout", title: "Checkout" };
    qaDropped = 0;
    chunks = [new Blob(["video"], { type: "video/mp4" })];
    recorder = { mimeType: "video/mp4;codecs=avc1.42E01E,opus" };
    qaEntries = [{ kind: "nav", level: "info", t: t0 + 100, text: "https://example.test/checkout" }];

    const realBuildHar = buildHar;
    buildHar = () => {
      throw new TypeError("chrome.runtime.getManifest is not a function");
    };
    let threw = null;
    try {
      finalize();
    } catch (e) {
      threw = e.message;
    }
    buildHar = realBuildHar;

    const complete = sent.find((m) => m.type === "sw:complete");
    const warn = sent.find((m) => m.type === "sw:warn");
    return {
      threw,
      files: complete ? complete.files.map((f) => f.filename.split("/").pop()) : [],
      warn: warn ? warn.message : null,
    };
  });

  expect(r.threw).toBeNull();
  // The video survives; only the report that threw is missing, and it is told.
  expect(r.files.some((f) => f.endsWith(".mp4"))).toBe(true);
  expect(r.files.some((f) => f.endsWith(".har"))).toBe(false);
  expect(r.files.some((f) => f.endsWith(".console.log"))).toBe(true);
  expect(r.warn).toContain(".har");
});
