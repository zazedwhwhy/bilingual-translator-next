import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    process.env.BT_OUTPUT || path.join(os.tmpdir(), "bt-video-verification");
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
const popupScript = path.join(bundle, "src/ui/popup.js");
await fs.writeFile(
  popupScript,
  (await fs.readFile(popupScript, "utf8")).replace(
    /tabId\s*=\s*tab\?\.id/,
    "tabId=(await chrome.tabs.query({url:'http://127.0.0.1:8787/video.html'}))[0]?.id",
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
      viewport: { width: 1280, height: 900 },
    },
  );
  context.on("page", (p) =>
    p.on("pageerror", (e) => report.errors.push(e.message)),
  );
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const generator = await context.newPage();
  await generator.goto("http://127.0.0.1:8787/static.html");
  const videoBytes = await generator.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 450;
    const draw = () => {
      const c = canvas.getContext("2d");
      c.fillStyle = "#1e493c";
      c.fillRect(0, 0, 800, 450);
      c.fillStyle = "white";
      c.font = "32px sans-serif";
      c.fillText("Bilingual subtitle fixture", 50, 160);
    };
    draw();
    const stream = canvas.captureStream(10),
      audio = new AudioContext(),
      osc = audio.createOscillator(),
      gain = audio.createGain(),
      dest = audio.createMediaStreamDestination();
    gain.gain.value = 0.03;
    osc.connect(gain).connect(dest);
    osc.start();
    const combined = new MediaStream([
        ...stream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]),
      recorder = new MediaRecorder(combined, {
        mimeType: "video/webm;codecs=vp8,opus",
      }),
      chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((resolve) => (recorder.onstop = resolve));
    const interval = setInterval(draw, 100);
    recorder.start();
    await new Promise((r) => setTimeout(r, 3100));
    recorder.stop();
    await done;
    clearInterval(interval);
    combined.getTracks().forEach((t) => t.stop());
    osc.stop();
    await audio.close();
    return [
      ...new Uint8Array(
        await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer(),
      ),
    ];
  });
  await fs.writeFile(
    path.join(root, "test/fixtures/fixture.webm"),
    new Uint8Array(videoBytes),
  );
  await generator.close();
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/ui/options.html`);
  await options.locator("#provider").selectOption("openai");
  await options.locator("#model").fill("mock-ok");
  await options.locator("#key").fill("test-key");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  const article = await context.newPage();
  await article.goto("http://127.0.0.1:8787/video.html");
  await article.waitForFunction(
    () => document.querySelector("video").textTracks[0]?.cues?.length === 2,
  );
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  await popup.locator("#video-open").click();
  await popup.locator("#video-start").click();
  await popup.waitForFunction(() =>
    document
      .querySelector("#video-status")
      .textContent.includes("字幕翻译完成"),
  );
  const cues = await article.evaluate(
    () =>
      [...document.querySelector("video").textTracks].find(
        (t) => t.label === "双语阅读 Next",
      ).cues,
  );
  const state = await article.evaluate(() => {
    const track = [...document.querySelector("video").textTracks].find(
      (t) => t.label === "双语阅读 Next",
    );
    return {
      mode: track.mode,
      cues: [...track.cues].map((c) => ({
        text: c.text,
        start: c.startTime,
        end: c.endTime,
      })),
    };
  });
  assert.equal(state.cues.length, 2);
  assert.ok(
    state.cues[0].text.includes("Hello") && state.cues[0].text.includes("MOCK"),
  );
  assert.equal(mock.requests.length, 1);
  report.checks.push(
    "native track → batch translation → native bilingual cues",
  );
  await article.bringToFront();
  await article.evaluate(async () => {
    const v = document.querySelector("video");
    await v.play();
    v.currentTime = 1.7;
  });
  await article.waitForFunction(() =>
    [...document.querySelector("video").textTracks]
      .find((t) => t.label === "双语阅读 Next")
      .activeCues?.[0]?.text.includes("Second"),
  );
  await article.evaluate(() => document.querySelector("video").pause());
  report.checks.push("seek selects the correct bilingual cue");
  await article.locator("#fullscreen").click();
  await article.waitForFunction(
    () => document.fullscreenElement === document.querySelector("video"),
  );
  await article.screenshot({
    path: path.join(output, "fullscreen-subtitles.png"),
  });
  report.checks.push("video fullscreen retains native subtitle track");
  await article.evaluate(() => document.exitFullscreen());
  const dl = popup.waitForEvent("download");
  await popup.locator("#video-export").click();
  const downloaded = await dl;
  await downloaded.saveAs(path.join(output, "video-双语.srt"));
  assert.ok(
    (await fs.readFile(path.join(output, "video-双语.srt"), "utf8")).includes(
      "00:00:01,300",
    ),
  );
  report.checks.push("bilingual SRT export preserves cue boundaries");
  await popup.locator("#video-stop").click();
  await popup.waitForFunction(() =>
    document
      .querySelector("#video-status")
      .textContent.includes("已恢复原字幕"),
  );
  assert.equal(
    await article.evaluate(
      () =>
        [...document.querySelector("video").textTracks].find(
          (t) => t.label === "双语阅读 Next",
        ).mode,
    ),
    "disabled",
  );
  assert.equal(
    await article.evaluate(
      () => document.querySelector("video").textTracks[0].mode,
    ),
    "showing",
  );
  report.checks.push("restore returns original track mode");
  await popup.locator("#video-start").click();
  await popup.waitForFunction(() =>
    document
      .querySelector("#video-status")
      .textContent.includes("字幕翻译完成"),
  );
  await article.evaluate(() => {
    const v = document.querySelector("video");
    v.removeAttribute("src");
    v.load();
  });
  await popup.waitForFunction(
    () =>
      !document.querySelector("#video-status").textContent.includes("正在翻译"),
  );
  await new Promise((r) => setTimeout(r, 700));
  console.log(
    "after-source-change",
    await article.evaluate(() => {
      const v = document.querySelector("video"),
        t = [...v.textTracks].find((t) => t.label === "双语阅读 Next");
      return { source: v.currentSrc, mode: t?.mode, count: t?.cues?.length };
    }),
  );
  assert.equal(
    await article.evaluate(
      () =>
        [...document.querySelector("video").textTracks].find(
          (t) => t.label === "双语阅读 Next",
        ).mode,
    ),
    "disabled",
  );
  report.checks.push("source replacement cancels old video session");
  const workbench = await context.newPage();
  await workbench.goto(`chrome-extension://${id}/src/ui/workbench.html`);
  await workbench
    .locator("#subtitle-file")
    .setInputFiles(path.join(root, "test/fixtures/fixture.vtt"));
  await workbench.waitForFunction(
    () => document.querySelector("#subtitle-status").dataset.phase === "ready",
  );
  await workbench.locator("#subtitle-translate").click();
  await workbench.waitForFunction(
    () =>
      document.querySelector("#subtitle-status").dataset.phase === "complete",
  );
  const vttDownload = workbench.waitForEvent("download");
  await workbench.locator("#subtitle-vtt").click();
  await (await vttDownload).saveAs(path.join(output, "workbench-双语.vtt"));
  report.checks.push("subtitle workbench import → translation → VTT export");
  assert.equal(report.errors.length, 0);
  report.browser = context.browser().version();
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(output, "video-results.json"),
    JSON.stringify(report, null, 2),
  );
  await context?.close();
  mock.server.closeAllConnections();
  await new Promise((r) => mock.server.close(r));
}
