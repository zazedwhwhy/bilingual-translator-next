import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, "../../../.tmp/bt-capture-probe/extension");
const profileDir = path.resolve(here, "../../../.tmp/bt-capture-probe/profile");
const resultPath = path.resolve(
  here,
  "../../../.tmp/bt-capture-probe/result.json",
);
const browserRoot = "C:/Users/wange/Documents/ChatGPT/rea/.tmp/bt-browsers";
const executablePath = path.join(
  browserRoot,
  "chromium-1234/chrome-win64/chrome.exe",
);
const playwrightDir =
  "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const { chromium } = await import(
  pathToFileURL(path.join(playwrightDir, "index.mjs")).href
);
process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;

await fs.rm(extDir, { recursive: true, force: true });
await fs.rm(profileDir, { recursive: true, force: true });
await fs.mkdir(extDir, { recursive: true });
await fs.mkdir(profileDir, { recursive: true });

const files = {
  "manifest.json": JSON.stringify(
    {
      manifest_version: 3,
      name: "Isolated tab capture probe",
      version: "1.0.0",
      permissions: ["activeTab", "tabCapture", "offscreen", "tabs"],
      background: { service_worker: "worker.js" },
      action: { default_title: "Capture probe", default_popup: "popup.html" },
    },
    null,
    2,
  ),
  "popup.html":
    '<!doctype html><meta charset="utf-8"><button id="capture">Capture 500ms</button><pre id="status">ready</pre><script src="popup.js"></script>',
  "popup.js": `
const status = document.querySelector('#status');
document.querySelector('#capture').addEventListener('click', async () => {
  try {
    status.textContent = 'query active tab';
    const [tab] = await chrome.tabs.query({ url: ['http://127.0.0.1/*'] });
    if (!tab?.id) throw new Error('No active tab id');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    status.textContent = 'got stream id; starting offscreen';
    const result = await chrome.runtime.sendMessage({ type: 'capture', streamId });
    status.textContent = JSON.stringify(result);
    document.body.dataset.result = JSON.stringify(result);
  } catch (error) {
    const result = { error: String(error), stack: error?.stack };
    status.textContent = JSON.stringify(result);
    document.body.dataset.result = JSON.stringify(result);
  }
});
`,
  "worker.js": `
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'capture') return;
  (async () => {
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contexts.length) await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Capture a short local tab audio probe'
      });
      const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'record', streamId: message.streamId });
      sendResponse(result);
    } catch (error) { sendResponse({ error: String(error), stack: error?.stack }); }
  })();
  return true;
});
`,
  "offscreen.html":
    '<!doctype html><meta charset="utf-8"><script src="offscreen.js"></script>',
  "offscreen.js": `
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message?.type !== 'record') return;
  (async () => {
    let stream, context, recorder, outcome;
    const events = [];
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false });
      const track = stream.getAudioTracks()[0];
      track?.addEventListener('ended', () => events.push('track-ended'));
      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      source.connect(context.destination);
      if (context.state === 'suspended') await context.resume();
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      await new Promise(resolve => setTimeout(resolve, 500));
      recorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      let decoded = false, decodedDuration = null, decodeError = null;
      try { const decodedBuffer = await context.decodeAudioData(await blob.arrayBuffer()); decoded = true; decodedDuration = decodedBuffer.duration; }
      catch (error) { decodeError = String(error); }
      outcome = { ok: true, blobSize: blob.size, mimeType: blob.type, decoded, decodedDuration, decodeError, tracksBeforeStop: stream.getTracks().map(t => ({ kind: t.kind, state: t.readyState })), events, contextBeforeClose: context.state };
    } catch (error) { outcome = { error: String(error), stack: error?.stack, events }; }
    finally {
      try { recorder?.state !== 'inactive' && recorder?.stop(); } catch {}
      for (const track of stream?.getTracks() || []) track.stop();
      try { await context?.close(); } catch {}
      if (stream) events.push(...stream.getTracks().map(t => 'after-stop:' + t.readyState));
      events.push('context:' + (context?.state || 'none'));
    }
    if (outcome) { outcome.events = events; outcome.tracksAfterStop = stream?.getTracks().map(t => t.readyState) || []; outcome.contextAfterClose = context?.state || null; }
    sendResponse(outcome || { error: 'capture produced no outcome' });
  })();
  return true;
});
`,
};
for (const [name, body] of Object.entries(files))
  await fs.writeFile(path.join(extDir, name), body);

const browser = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: false,
  viewport: { width: 1100, height: 800 },
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const interactive = process.argv.includes("--interactive");
const result = {
  startedAt: new Date().toISOString(),
  executablePath,
  playwrightDir,
  extensionDir: extDir,
  profileDir,
  userActionPath:
    "Click the visible extension toolbar action, then click Capture 500ms in its popup.",
};
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><title>Capture tone</title><button id="start">Start oscillator</button><script>document.querySelector("#start").onclick=()=>{const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=.1;o.connect(g).connect(c.destination);o.start();window.testAudio={c,o,g};}</script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const testUrl = `http://127.0.0.1:${server.address().port}/`;
result.testUrl = testUrl;
try {
  const page = await browser.newPage();
  await page.goto(testUrl);
  await page.getByText("Start oscillator").click();
  const browserCdp = await browser.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send("Target.getTargets");
  const targetInfo = targetInfos.find((target) => target.url === testUrl);
  result.testTarget = targetInfo
    ? { targetId: targetInfo.targetId, type: targetInfo.type }
    : null;
  const sw =
    browser.serviceWorkers()[0] ||
    (await browser.waitForEvent("serviceworker", { timeout: 10000 }));
  result.serviceWorker = sw.url();
  const extensionId = new URL(sw.url()).host;
  if (interactive) {
    result.extensionId = extensionId;
    result.chromePid = null;
    result.instructions =
      "In this isolated Chrome window, click the extension action in the toolbar (or its Extensions menu), then click Capture 500ms. The popup displays JSON including blobSize, decoded, tracksAfterStop, and contextAfterClose. Press Enter in this terminal after observing it to close this isolated profile.";
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify(
        {
          resultPath,
          testUrl,
          extensionId,
          chromePid: result.chromePid,
          instructions: result.instructions,
        },
        null,
        2,
      ),
    );
    await new Promise((resolve) => process.stdin.once("data", resolve));
    throw new Error("interactive session finished");
  }
  try {
    const pageCdp = await browser.newCDPSession(page);
    await pageCdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: targetInfo.targetId,
    });
    result.cdpTriggerAction = { ok: true };
  } catch (error) {
    result.cdpTriggerAction = { ok: false, error: String(error) };
  }
  const popupPromise = browser.waitForEvent("page", { timeout: 5000 });
  await page.bringToFront();
  result.actionOpenPopup = await sw.evaluate(async () => {
    try {
      await chrome.action.openPopup();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  let popup = await popupPromise.catch(() => null);
  if (!popup) {
    result.popupAutomationNote =
      "The action shortcut did not expose a popup page target; opening the test popup page directly after the shortcut.";
    popup = await browser.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  }
  await popup.waitForLoadState("domcontentloaded");
  result.popupUrl = popup.url();
  await popup.locator("#capture").click();
  await popup.waitForFunction(() => document.body.dataset.result, {
    timeout: 15000,
  });
  result.capture = JSON.parse(
    await popup.locator("body").getAttribute("data-result"),
  );
  await page.evaluate(() => {
    window.testAudio?.o.stop();
    window.testAudio?.c.close();
  });
} catch (error) {
  if (error?.message === "interactive session finished")
    result.interactiveStopped = true;
  else result.failure = { error: String(error), stack: error?.stack };
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  await new Promise((resolve) => server.close(resolve));
  await browser.close();
}
console.log(JSON.stringify({ resultPath, result }, null, 2));
