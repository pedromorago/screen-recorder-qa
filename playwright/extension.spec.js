"use strict";

// E2E de la extensión REAL cargada en Chromium: service worker, popup en
// chrome-extension://, chrome.storage y la inyección/reinyección de los
// registros QA vía chrome.scripting. Esta es la capa que Cypress no puede
// alcanzar; el motor de captura en sí se prueba en cypress/e2e/*.

const { test, expect, BASE } = require("./fixtures");

const SANDBOX = `${BASE}/cypress/pages/sandbox.html`;

test("el service worker registra y el manifest expone los permisos del modo QA", async ({ sw }) => {
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

test("el popup arranca en idle con el modo QA activo por defecto", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("body")).toHaveAttribute("data-state", "idle");
  await expect(popup.locator("#consoleLog")).toBeChecked();
  await expect(popup.locator("#networkLog")).toBeChecked();
  await expect(popup.locator("#stepsLog")).toBeChecked();
  await expect(popup.locator("#btnTab")).toBeVisible();
  await expect(popup.locator("#btnScreen")).toBeVisible();
});

test("los interruptores del popup persisten en chrome.storage.local", async ({ context, extensionId, sw }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // El clic directo sobre el checkbox funciona gracias al
  // pointer-events:none del track (fix de accesibilidad que destapó
  // precisamente esta suite).
  await popup.locator("#networkLog").uncheck();
  await expect
    .poll(async () => (await sw.evaluate(() => chrome.storage.local.get("networkLog"))).networkLog)
    .toBe(false);

  // El estado sobrevive a reabrir el popup.
  await popup.reload();
  await expect(popup.locator("#networkLog")).not.toBeChecked();
  await expect(popup.locator("#consoleLog")).toBeChecked();

  await popup.locator("#networkLog").check();
  await expect
    .poll(async () => (await sw.evaluate(() => chrome.storage.local.get("networkLog"))).networkLog)
    .toBe(true);
});

test("el popup refleja en vivo el estado de grabación (storage.session)", async ({ context, extensionId, sw }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("body")).toHaveAttribute("data-state", "idle");

  await sw.evaluate(() =>
    chrome.storage.session.set({ isRecording: true, startTime: Date.now() })
  );
  await expect(popup.locator("body")).toHaveAttribute("data-state", "recording");
  await expect(popup.locator("#timer")).toBeVisible();
  await expect(popup.locator("#consoleLog")).toBeDisabled();
  await expect(popup.locator("#btnStop")).toBeVisible();
  await expect(popup.locator("#btnMarker")).toBeVisible();

  await sw.evaluate(() =>
    chrome.storage.session.set({ isRecording: false, startTime: null })
  );
  await expect(popup.locator("body")).toHaveAttribute("data-state", "idle");
});

test("injectQaCapture instala los wrappers reales en el world MAIN de una página http", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(SANDBOX);

  // Colector en el mundo de la página, ANTES de inyectar.
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

  // Los wrappers funcionan de verdad: console, fetch y un click real
  // publican entradas (steps-capture.js corre en el mundo aislado, así que
  // su flag no es visible desde page.evaluate: se comprueba por conducta).
  await page.evaluate(() => {
    console.log("hola desde la página");
    return fetch("/api/error").then(() => {});
  });
  await page.click("#btnDemo");
  await page.waitForFunction(() =>
    window.__caught.some((e) => e.kind === "console" && e.text === "hola desde la página")
  );
  await page.waitForFunction(() =>
    window.__caught.some((e) => e.kind === "net" && e.net && e.net.status === 500)
  );
  await page.waitForFunction(() =>
    window.__caught.some((e) => e.kind === "step" && e.text.includes("<button#btnDemo"))
  );
});

test("si la pestaña grabada navega, tabs.onUpdated reinyecta los registros", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(SANDBOX);
  const tabId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab.id;
  }, SANDBOX);

  // Estado de "grabación de pestaña en curso" tal y como lo deja
  // startTabRecording (sin necesitar tabCapture, que exige gesto real).
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

  await page.goto(`${SANDBOX}?despues-de-navegar=1`);
  await expect.poll(() => page.evaluate(() => window.__qaRecorderMainInstalled === true)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__qaRecorderNetInstalled === true)).toBe(true);

  await sw.evaluate(() => chrome.storage.session.set({ isRecording: false, recordedTabId: null }));
});

test("startTabRecording sin gesto de usuario falla con aviso y sin quedarse grabando", async ({ context, sw }) => {
  const page = await context.newPage();
  await page.goto(SANDBOX);
  await page.bringToFront();

  // chrome.tabCapture exige que el usuario haya invocado la extensión; en
  // un test no hay gesto real, así que debe fallar por el camino
  // controlado: aviso en el popup y estado limpio.
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
  expect(s.notice.text).toContain("No se pudo grabar esta pestaña");
});
