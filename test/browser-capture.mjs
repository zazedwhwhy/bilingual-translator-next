import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output =
    process.env.BT_OUTPUT || path.join(os.tmpdir(), "bt-capture-verification");
await fs.mkdir(output, { recursive: true });
const bundle = path.join(output, "extension");
await fs.cp(path.join(root, "src"), path.join(bundle, "src"), {
  recursive: true,
});
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "manifest.json")),
);
manifest.host_permissions = ["http://127.0.0.1/*"];
await fs.writeFile(
  path.join(bundle, "manifest.json"),
  JSON.stringify(manifest),
);
const reg = path.join(bundle, "src/providers/registry.js");
await fs.writeFile(
  reg,
  (await fs.readFile(reg, "utf8"))
    .replace(
      "https://api.openai.com/v1/chat/completions",
      "http://127.0.0.1:8787/api/openai",
    )
    .replaceAll("https://api.openai.com/*", "http://127.0.0.1/*"),
);

const captureModule = path.join(bundle, "src/media/capture.js");
await fs.writeFile(
  captureModule,
  (await fs.readFile(captureModule, "utf8")).replace(
    /chunkMs\s*=\s*15000/,
    "chunkMs = 2200",
  ),
);
const controllerModule = path.join(bundle, "src/media/capture-controller.js");
await fs.writeFile(
  controllerModule,
  (await fs.readFile(controllerModule, "utf8"))
    .replace(
      "await addAudio(",
      "await new Promise(r=>setTimeout(r,300));await addAudio(",
    )
    .replace(
      "const stream = await navigator.mediaDevices.getUserMedia(",
      "await new Promise(r=>setTimeout(r,400));const stream = await navigator.mediaDevices.getUserMedia(",
    ),
);
const mock = await startMock();
let context;
const report = { checks: [], errors: [] };
try {
  context = await chromium.launchPersistentContext(
    path.join(output, "profile-" + Date.now()),
    {
      headless: true,
      channel: "chromium",
      args: [
        `--disable-extensions-except=${bundle}`,
        `--load-extension=${bundle}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
      viewport: { width: 1280, height: 1000 },
    },
  );
  context.on("page", (p) =>
    p.on("pageerror", (e) => report.errors.push(e.message)),
  );
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/ui/options.html`);
  await options.locator("#provider").selectOption("openai");
  await options.locator("#model").fill("mock-ok");
  await options.locator("#key").fill("test-key");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  await options.locator("#asr-endpoint").fill("http://127.0.0.1:8787/api/asr");
  await options.locator("#asr-model").fill("mock-capture");
  await options.locator("#asr-key").fill("asr-test-key");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  const video = await context.newPage();
  await video.goto("http://127.0.0.1:8787/static.html");
  const longVideo = await video.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(10),
      audio = new AudioContext(),
      osc = audio.createOscillator(),
      dest = audio.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const rec = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp8,opus",
      }),
      parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const done = new Promise((r) => (rec.onstop = r)),
      draw = setInterval(() => {
        ctx.fillStyle = "#174437";
        ctx.fillRect(0, 0, 400, 200);
        ctx.fillStyle = "white";
        ctx.font = "24px sans-serif";
        ctx.fillText("Tab audio fixture", 30, 100);
      }, 100);
    rec.start();
    await new Promise((r) => setTimeout(r, 8200));
    rec.stop();
    await done;
    clearInterval(draw);
    stream.getTracks().forEach((t) => t.stop());
    osc.stop();
    await audio.close();
    return [
      ...new Uint8Array(
        await new Blob(parts, { type: rec.mimeType }).arrayBuffer(),
      ),
    ];
  });
  await fs.writeFile(
    path.join(root, "test/fixtures/capture.webm"),
    new Uint8Array(longVideo),
  );
  await video.goto("http://127.0.0.1:8787/video.html");
  await video.evaluate(() => {
    document.querySelector("video").src = "/capture.webm";
  });
  await video.evaluate(async () => {
    const v = document.querySelector("video");
    await v.play();
    v.pause();
    v.currentTime = 0;
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets", {
    filter: [{ type: "tab", exclude: false }, { exclude: true }],
  });
  const tabTarget = targetInfos.find(
    (t) => t.url === "http://127.0.0.1:8787/video.html",
  );
  assert.ok(tabTarget, "browser protocol must expose the real tab target");
  await video.bringToFront();
  await cdp.send("Extensions.triggerAction", {
    id,
    targetId: tabTarget.targetId,
  });
  report.checks.push(
    "browser extension action invoked on the actual tab target",
  );
  // Action grants activeTab to the video; a separate UI page keeps automation stable.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ url: "http://127.0.0.1:8787/video.html" }))[0]
        .id,
  );
  const created = await popup.evaluate(async (tabId) => {
    const r = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type: "OPEN_WORKBENCH",
      tabId,
    });
    if (!r.ok) throw Error(r.error.message);
    return r.data;
  }, tabId);
  const page =
    context.pages().find((p) => p.url().includes("workbench.html")) ||
    (await context.waitForEvent("page"));
  const work =
    context
      .pages()
      .find(
        (p) => p.url() === `chrome-extension://${id}/src/ui/workbench.html`,
      ) || page;
  await work.waitForLoadState("domcontentloaded");
  assert.equal(
    await work.locator("#capture-start").count(),
    1,
    "workbench must offer active tab audio capture",
  );
  await work.locator("#subtitle-target-refresh").click();
  await video.evaluate(async () => {
    const v = document.querySelector("video");
    v.currentTime = 0.05;
    await v.play();
  });
  await work.locator("#capture-start").click();
  await work.waitForFunction(() =>
    ["recording", "error"].includes(
      document.querySelector("#capture-status").dataset.phase,
    ),
  );
  assert.equal(
    await work.locator("#capture-status").getAttribute("data-phase"),
    "recording",
    await work.locator("#capture-status").textContent(),
  );
  await new Promise((r) => setTimeout(r, 4900));
  await work.locator("#capture-stop").click();
  await work.waitForFunction(
    () =>
      ["complete", "error"].includes(
        document.querySelector("#capture-status").dataset.phase,
      ),
    null,
    { timeout: 45000 },
  );
  assert.equal(
    await work.locator("#capture-status").getAttribute("data-phase"),
    "complete",
    await work.locator("#capture-status").textContent(),
  );
  assert.ok(mock.requests.some((r) => r.provider === "asr" && r.bytes > 100));
  assert.ok(
    (await work.locator("#subtitle-list").textContent()).includes(
      "Recognized first line",
    ),
  );
  const cleanup = await work.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type: "ASR_MEDIA_STATUS",
    });
    if (!r.ok) throw Error(r.error.message);
    return r.data;
  });
  assert.ok(cleanup.capture.tracks.every((t) => t === "ended"));
  assert.equal(cleanup.capture.audioContext, "closed");
  report.checks.push(
    "real tabCapture → independently encoded audio → ASR → bilingual subtitles",
  );
  report.checks.push(
    "stop ends every captured audio track and closes the monitoring AudioContext",
  );
  const encoded = await work.evaluate(async () => {
    const { getRecord } = await import("../media/store.js");
    const live = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type: "ASR_MEDIA_STATUS",
    });
    const session = await getRecord(live.data.capture.sessionId);
    const audio = new AudioContext();
    const rows = [];
    for (const chunk of session.chunks) {
      const record = await getRecord(chunk.id);
      const decoded = await audio.decodeAudioData(
        await record.blob.arrayBuffer(),
      );
      rows.push({
        duration: decoded.duration,
        offset: chunk.offset,
        bytes: record.blob.size,
      });
    }
    await audio.close();
    return rows;
  });
  assert.ok(encoded.length >= 2);
  assert.ok(encoded.every((c) => c.duration > 0.3 && c.bytes > 100));
  assert.ok(encoded[1].offset > encoded[0].offset + 2);
  for (let i = 1; i < encoded.length; i++)
    assert.ok(
      encoded[i].offset - (encoded[i - 1].offset + encoded[i - 1].duration) <
        0.15,
      "recording must continue while previous chunk is decoded and stored",
    );
  report.checks.push(
    "multiple captured chunks decode independently and use measured video offsets",
  );
  const pageCues = await video.evaluate(
    () =>
      [...document.querySelector("video").textTracks].find(
        (t) => t.label === "双语阅读 Next",
      )?.cues?.length,
  );
  assert.ok(pageCues >= 4);
  report.checks.push(
    "translated live cues are applied to the original video without another translation request",
  );
  await options.locator("#asr-model").fill("mock-delay");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  await work.locator("#capture-clear").click();
  await work.waitForFunction(
    () => document.querySelector("#capture-status").dataset.phase === "idle",
  );
  await video.evaluate(async () => {
    const v = document.querySelector("video");
    v.currentTime = 0.1;
    await v.play();
  });
  await work.locator("#capture-start").click();
  await work.waitForFunction(
    () =>
      document.querySelector("#capture-status").dataset.phase === "recording",
  );
  await new Promise((r) => setTimeout(r, 2600));
  const requestsBefore = mock.requests.filter(
    (r) => r.provider === "asr",
  ).length;
  await video.evaluate(() => {
    document.querySelector("video").currentTime = 6;
  });
  await work.waitForFunction(() =>
    ["complete", "error", "cancelled"].includes(
      document.querySelector("#capture-status").dataset.phase,
    ),
  );
  const stopped = await work.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type: "ASR_MEDIA_STATUS",
    });
    return r.data.capture;
  });
  assert.equal(stopped.active, false);
  assert.ok(stopped.tracks.every((t) => t === "ended"));
  assert.equal(stopped.audioContext, "closed");
  assert.equal(
    mock.requests.filter(
      (r) => r.provider === "asr" && r.model === "mock-delay",
    ).length,
    1,
  );
  assert.ok(
    (await work.locator("#subtitle-list").textContent()).includes(
      "Recognized first line",
    ),
    "completed recorded chunk must survive seeking",
  );
  report.checks.push(
    "seeking discards only the tail, preserves completed audio and drains pending recognition",
  );
  await options.locator("#asr-model").fill("mock-capture");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  await work.locator("#capture-clear").click();
  await work.waitForFunction(
    () => document.querySelector("#capture-status").dataset.phase === "idle",
  );
  await video.evaluate(async () => {
    const v = document.querySelector("video");
    v.currentTime = 0.1;
    await v.play();
  });
  await work.locator("#capture-start").click();
  await work.waitForFunction(
    () =>
      document.querySelector("#capture-status").dataset.phase === "recording",
  );
  await new Promise((r) => setTimeout(r, 2100));
  await work.locator("#capture-stop").click();
  await work.waitForFunction(
    () =>
      document.querySelector("#capture-status").dataset.phase === "complete",
  );
  await work.locator("#capture-clear").click();
  await work.waitForFunction(
    () => document.querySelector("#capture-status").dataset.phase === "idle",
  );
  await options.locator("#asr-model").fill("mock-fail");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  await video.evaluate(async () => {
    const v = document.querySelector("video");
    v.currentTime = 0.1;
    await v.play();
  });
  await work.locator("#capture-start").click();
  await work.waitForFunction(
    () =>
      document.querySelector("#capture-status").dataset.phase === "recording",
  );
  await work.waitForFunction(
    () => document.querySelector("#capture-status").dataset.phase === "error",
  );
  const failedCalls = mock.requests.filter((r) => r.provider === "asr").length;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    mock.requests.filter((r) => r.provider === "asr").length,
    failedCalls,
  );
  assert.equal(
    await work.locator("#capture-retry").count(),
    1,
    "failed recorded chunks need an explicit retry action",
  );
  await options.locator("#asr-model").fill("mock-capture");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  await work.locator("#capture-retry").click();
  await work.waitForFunction(
    () =>
      document.querySelector("#capture-status").dataset.phase === "complete",
  );
  assert.equal(
    mock.requests.filter((r) => r.provider === "asr").length,
    failedCalls + 1,
  );
  report.checks.push(
    "ASR failure stops recording, never auto-retries, and explicit retry reuses the saved failed chunk",
  );
  await work.locator("#capture-clear").click();
  await work.waitForFunction(
    () => document.querySelector("#capture-status").dataset.phase === "idle",
  );
  await video.evaluate(async () => {
    const v = document.querySelector("video");
    v.currentTime = 0.1;
    await v.play();
  });
  await work.locator("#capture-start").click();
  await work.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const r = await chrome.runtime.sendMessage({
        channel: "BT_BG",
        type: "ASR_MEDIA_STATUS",
      });
      if (r.ok && r.data.capture?.starting) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("capture initialization was not observed");
  });
  await options.locator("#asr-clear").click();
  await options.getByText("语音密钥已移除", { exact: false }).waitFor();
  await new Promise((r) => setTimeout(r, 700));
  const keyClear = await work.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type: "ASR_MEDIA_STATUS",
    });
    return r.data.capture;
  });
  assert.equal(
    keyClear.active,
    false,
    "clearing a key must cancel even a capture that is still acquiring its stream",
  );
  report.checks.push(
    "clearing speech credentials also cancels capture initialization",
  );
  await options.locator("#asr-key").fill("asr-test-key");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  await work.locator("#capture-clear").click();
  await work.waitForFunction(
    () => document.querySelector("#capture-status").dataset.phase === "idle",
  );
  await video.evaluate(async () => {
    const v = document.querySelector("video");
    v.currentTime = 0.1;
    await v.play();
  });
  await work.locator("#capture-start").click();
  await work.waitForFunction(
    () =>
      document.querySelector("#capture-status").dataset.phase === "recording",
  );
  await work.close();
  // Options are forbidden to operate the offscreen recorder directly; use a new trusted workbench for observation.
  const observer = await context.newPage();
  await observer.goto(`chrome-extension://${id}/src/ui/workbench.html`);
  await observer.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      const r = await chrome.runtime.sendMessage({
        channel: "BT_BG",
        type: "ASR_MEDIA_STATUS",
      });
      if (r.ok && !r.data.capture?.active) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("closing workbench did not stop capture");
  });
  const closedState = await observer.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type: "ASR_MEDIA_STATUS",
    });
    return r.data.capture;
  });
  assert.equal(closedState.active, false);
  assert.ok(closedState.tracks.every((t) => t === "ended"));
  assert.equal(closedState.audioContext, "closed");
  report.checks.push(
    "closing the recording workbench stops capture and releases audio resources",
  );

  assert.equal(report.errors.length, 0);
  report.browser = context.browser().version();
  await observer.screenshot({
    path: path.join(output, "capture-workbench.png"),
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(output, "capture-results.json"),
    JSON.stringify(report, null, 2),
  );
  await context?.close();
  mock.server.closeAllConnections();
  await new Promise((r) => mock.server.close(r));
}
