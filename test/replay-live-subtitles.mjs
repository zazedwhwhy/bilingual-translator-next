import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseSubtitles } from "../src/subtitles/cues.js";
const require = createRequire(import.meta.url),
  {
    chromium,
  } = require("C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output = path.resolve(process.env.BT_OUTPUT),
  original = JSON.parse(
    await fs.readFile(path.join(output, "real-results.json")),
  ),
  profile = path.join(output, "owned-replay-profile-" + Date.now()),
  bundle = path.join(output, "replay-extension");
assert.equal(original.success, true);
const parsed = parseSubtitles(original.subtitleExport, "srt");
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
let context;
let networkCalls = 0;
const server = http.createServer(async (req, res) => {
  if (req.url === "/fixture.webm") {
    res.setHeader("Content-Type", "video/webm");
    res.end(await fs.readFile(path.join(root, "test/fixtures/fixture.webm")));
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><style>video{width:800px}</style><video controls src="/fixture.webm"></video><button id="full">Fullscreen</button><script>document.querySelector("#full").onclick=()=>document.querySelector("video").requestFullscreen()</script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + server.address().port + "/";
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    args: [
      `--load-extension=${bundle}`,
      `--disable-extensions-except=${bundle}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
    viewport: { width: 1280, height: 1000 },
  });
  await context.route("https://**/*", (route) => {
    networkCalls++;
    return route.abort("blockedbyclient");
  });
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(async () => {
    const v = document.querySelector("video");
    await v.play();
    v.pause();
  });
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/src/ui/popup.html`);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    url,
  );
  await ui.evaluate(
    async ({ tabId, cues }) => {
      const rpc = async (type, data = {}) => {
        const r = await chrome.runtime.sendMessage({
          channel: "BT_BG",
          type,
          tabId,
          ...data,
        });
        if (!r.ok) throw Error(r.error.message);
        return r.data;
      };
      const list = await rpc("VIDEO_LIST");
      await rpc("VIDEO_APPLY", { videoId: list[0].id, cues });
    },
    { tabId, cues: parsed },
  );
  await page.bringToFront();
  await page.evaluate(async () => {
    const v = document.querySelector("video");
    await v.play();
    v.currentTime = 1.3;
  });
  await page.waitForFunction(() => {
    const v = document.querySelector("video"),
      t = [...v.textTracks].find((t) => t.label === "双语阅读 Next");
    return (
      !v.seeking && v.currentTime >= 1 && t?.activeCues?.[0]?.startTime === 1
    );
  });
  await page.evaluate(() => document.querySelector("video").pause());
  const before = await page.evaluate(() => ({
    time: document.querySelector("video").currentTime,
    text: [...document.querySelector("video").textTracks].find(
      (t) => t.label === "双语阅读 Next",
    ).activeCues[0].text,
  }));
  assert.ok(before.text.includes("101.3 kPa") && before.text.includes("3.5%"));
  await page.locator("#full").click();
  await page.waitForFunction(
    () => document.fullscreenElement === document.querySelector("video"),
  );
  await page.screenshot({
    path: path.join(output, "subtitles-real-timed-replay.png"),
  });
  const after = await page.evaluate(() => {
    const v = document.querySelector("video"),
      t = [...v.textTracks].find((t) => t.label === "双语阅读 Next");
    return {
      time: v.currentTime,
      fullscreen: document.fullscreenElement === v,
      active: [...t.activeCues].map((c) => ({
        start: c.startTime,
        end: c.endTime,
        text: c.text,
      })),
      cueCount: t.cues.length,
    };
  });
  assert.equal(after.active[0].start, 1);
  assert.ok(after.time >= 1 && after.time < 1.9);
  assert.equal(networkCalls, 0);
  original.playerReplayVerification = {
    source:
      "captions from the two recorded real API responses; local playback only",
    ...after,
    additionalApiRequests: 0,
  };
  await fs.writeFile(
    path.join(output, "real-results.json"),
    JSON.stringify(original, null, 2),
  );
  console.log(JSON.stringify(original.playerReplayVerification, null, 2));
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const target = path.resolve(profile);
  if (
    !target.startsWith(output + path.sep) ||
    !path.basename(target).startsWith("owned-replay-profile-")
  )
    throw Error("UNSAFE_PROFILE_PATH");
  await fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
