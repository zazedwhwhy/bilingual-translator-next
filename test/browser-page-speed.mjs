import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";
import { exportSubtitles } from "../src/subtitles/cues.js";
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  source = process.env.BT_SPEED_SOURCE || root,
  output = process.env.BT_OUTPUT || path.join(os.tmpdir(), "bt-page-speed"),
  baseline = process.argv.includes("--baseline"),
  bundle = path.join(output, "extension");
await fs.mkdir(output, { recursive: true });
await fs.cp(path.join(source, "src"), path.join(bundle, "src"), {
  recursive: true,
});
const manifest = JSON.parse(
  await fs.readFile(path.join(source, "manifest.json")),
);
manifest.host_permissions = ["http://*/*", "https://*/*"];
await fs.writeFile(
  path.join(bundle, "manifest.json"),
  JSON.stringify(manifest),
);
const registry = path.join(bundle, "src/providers/registry.js");
await fs.writeFile(
  registry,
  (await fs.readFile(registry, "utf8"))
    .replace(
      "https://api.openai.com/v1/chat/completions",
      "http://127.0.0.1:8787/api/openai",
    )
    .replaceAll("https://api.openai.com/*", "http://127.0.0.1/*"),
);
const popupPath = path.join(bundle, "src/ui/popup.js");
await fs.writeFile(
  popupPath,
  (await fs.readFile(popupPath, "utf8")).replace(
    /tabId\s*=\s*tab\?\.id/,
    "tabId=(await chrome.tabs.query({url:'http://127.0.0.1:8787/*'})).sort((a,b)=>Number(b.url.includes('/platform-layout.html'))-Number(a.url.includes('/platform-layout.html'))||Number(b.url.includes('/latency.html'))-Number(a.url.includes('/latency.html')))[0]?.id",
  ),
);
const mock = await startMock(),
  report = {
    mode: baseline ? "0.2.1 baseline" : "optimized",
    sourceVersion: manifest.version,
    method:
      "Playwright; controlled local 120ms service; not Computer Use or real provider",
    errors: [],
    checks: [],
  },
  apiTimings = [],
  timingTasks = new Set();
let context, worker;
try {
  context = await chromium.launchPersistentContext(
    path.join(output, "owned-profile-" + Date.now()),
    {
      headless: true,
      channel: "chromium",
      args: [
        `--load-extension=${bundle}`,
        `--disable-extensions-except=${bundle}`,
      ],
      viewport: { width: 1280, height: 1200 },
    },
  );
  context.on("page", (p) =>
    p.on("pageerror", (e) => report.errors.push(e.message)),
  );
  context.on("response", (response) => {
    if (!response.url().startsWith("http://127.0.0.1:8787/api/")) return;
    const task = (async () => {
      await response.finished();
      const t = response.request().timing();
      apiTimings.push({
        roundTripMs:
          t.responseEnd >= 0 && t.requestStart >= 0
            ? Number((t.responseEnd - t.requestStart).toFixed(2))
            : null,
        endEpochMs: t.responseEnd >= 0 ? t.startTime + t.responseEnd : null,
      });
    })();
    timingTasks.add(task);
    void task.finally(() => timingTasks.delete(task));
  });
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host,
    options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/ui/options.html`);
  await options.locator("#provider").selectOption("openai");
  await options.locator("#model").fill("mock-latency");
  await options.locator("#key").fill("test-key");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:8787/latency.html");
  const original = await page.locator("main").innerText();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  async function measure(name) {
    const before = mock.requests.length,
      timingBefore = apiTimings.length;
    await page.evaluate(() => {
      globalThis.__latency = {};
      const observer = new MutationObserver(() => {
        const nodes = document.querySelectorAll("main [data-bt-next]");
        if (nodes.length && !__latency.first) __latency.first = Date.now();
        if (nodes.length === 6) {
          __latency.all = Date.now();
          observer.disconnect();
        }
      });
      observer.observe(document.querySelector("main"), {
        childList: true,
        subtree: true,
      });
    });
    await popup.evaluate(() =>
      document
        .querySelector("#start")
        .addEventListener("click", () => (globalThis.__clicked = Date.now()), {
          once: true,
        }),
    );
    await popup.locator("#start").click();
    await page.waitForFunction(
      () => document.querySelectorAll("main [data-bt-next]").length === 6,
    );
    await Promise.all([...timingTasks]);
    const at = await popup.evaluate(() => __clicked),
      times = await page.evaluate(() => __latency),
      network = apiTimings.slice(timingBefore);
    const result = {
      firstVisibleMs: times.first - at,
      firstScreenMs: times.all - at,
      requests: mock.requests.length - before,
      serviceDelayPerRequestMs: 120,
      apiRoundTripsMs: network.map((t) => t.roundTripMs),
      firstResponseToDOMMs: network[0]?.endEpochMs
        ? Number(
            (
              times.first -
              Math.min(
                ...network
                  .filter((t) => t.endEpochMs !== null)
                  .map((t) => t.endEpochMs),
              )
            ).toFixed(2),
          )
        : null,
    };
    report[name] = result;
    assert.equal(
      await page.locator("nav [data-bt-next],textarea [data-bt-next]").count(),
      0,
    );
    return result;
  }
  const cold = await measure("cold");
  await page.screenshot({ path: path.join(output, "translated.png") });
  await popup.locator("#restore").click();
  await page.waitForFunction(() => !document.querySelector("[data-bt-next]"));
  assert.equal(await page.locator("main").innerText(), original);
  const warm = await measure("memoryCache");
  assert.equal(warm.requests, 0);
  report.checks.push(
    "six complete paragraphs, excluded text, restore original and cache zero calls",
  );
  if (!baseline) {
    assert.ok(
      cold.requests <= 2,
      "short first-screen paragraphs should share requests",
    );
    assert.ok(
      cold.firstScreenMs - cold.firstVisibleMs < 200,
      "visible paragraphs should not wait six service waves",
    );
    await page.close();
    await options.bringToFront();
    await options.locator("#clear-cache").click();
    await options.locator("#auto-translate").check();
    await options.waitForFunction(() =>
      document.querySelector("#auto-status").textContent.includes("已开启"),
    );
    assert.equal(
      (
        await worker.evaluate(() =>
          chrome.scripting.getRegisteredContentScripts(),
        )
      ).length,
      1,
    );
    await options.screenshot({
      path: path.join(output, "automatic-settings.png"),
    });
    const automaticPage = await context.newPage();
    await automaticPage.addInitScript(() => {
      globalThis.__autoPerf = {};
      new MutationObserver(() => {
        const count = document.querySelectorAll("main [data-bt-next]").length;
        if (count && !__autoPerf.first) __autoPerf.first = Date.now();
        if (count === 6 && !__autoPerf.all) __autoPerf.all = Date.now();
      }).observe(document, { childList: true, subtree: true });
    });
    const autoStart = Date.now(),
      autoBefore = mock.requests.length;
    await automaticPage.goto("http://127.0.0.1:8787/latency.html?automatic=1");
    await automaticPage.waitForFunction(
      () => document.querySelectorAll("main [data-bt-next]").length === 6,
    );
    const autoTiming = await automaticPage.evaluate(() => __autoPerf);
    report.autoCold = {
      navigationToFirstMs: autoTiming.first - autoStart,
      navigationToScreenMs: autoTiming.all - autoStart,
      requests: mock.requests.length - autoBefore,
    };
    assert.equal(report.autoCold.requests, 1);
    report.checks.push(
      "enable switch → registered bootstrap → foreign navigation translates without clicking Start",
    );
    await automaticPage.screenshot({
      path: path.join(output, "automatic-translated.png"),
    });
    await popup.reload();
    await popup.locator("#restore").click();
    await automaticPage.waitForFunction(
      () => !document.querySelector("[data-bt-next]"),
    );
    const restoredRequests = mock.requests.length;
    await automaticPage.evaluate(() => {
      const p = document.createElement("p");
      p.textContent =
        "This additional foreign paragraph must remain unchanged after the reader restores the original page.";
      document.querySelector("main").append(p);
    });
    await automaticPage.waitForTimeout(650);
    assert.equal(await automaticPage.locator("[data-bt-next]").count(), 0);
    assert.equal(mock.requests.length, restoredRequests);
    report.checks.push(
      "manual restore keeps this route stopped despite later DOM updates",
    );
    await automaticPage.bringToFront();
    await automaticPage.evaluate(() =>
      history.pushState({}, "", "?automatic=new-route"),
    );
    await automaticPage.waitForFunction(
      () => document.querySelectorAll("main [data-bt-next]").length === 7,
    );
    report.checks.push(
      "new SPA route automatically resumes with stable source and revision guards",
    );
    const chinese = await context.newPage();
    await chinese.goto("http://127.0.0.1:8787/latency-zh.html");
    const beforeChinese = mock.requests.length;
    await chinese.waitForTimeout(700);
    assert.equal(await chinese.locator("[data-bt-next]").count(), 0);
    assert.equal(mock.requests.length, beforeChinese);
    report.checks.push(
      "Chinese body skips automatic translation even with incorrect English HTML language",
    );
    await options.locator("#clear-cache").click();
    const hiddenCreated = context.waitForEvent("page"),
      beforeHidden = mock.requests.length,
      hiddenTab = await worker.evaluate(() =>
        chrome.tabs.create({
          url: "http://127.0.0.1:8787/latency.html?hidden=1",
          active: false,
        }),
      ),
      hidden = await hiddenCreated;
    await hidden.waitForLoadState("domcontentloaded");
    assert.equal(
      await worker.evaluate(
        (id) => chrome.tabs.get(id).then((t) => t.active),
        hiddenTab.id,
      ),
      false,
    );
    await hidden.waitForTimeout(500);
    assert.equal(await hidden.locator("[data-bt-next]").count(), 0);
    assert.equal(mock.requests.length, beforeHidden);
    await worker.evaluate(
      (id) => chrome.tabs.update(id, { active: true }),
      hiddenTab.id,
    );
    await hidden.waitForFunction(
      () => document.querySelectorAll("main [data-bt-next]").length === 6,
    );
    assert.equal(mock.requests.length, beforeHidden + 1);
    await hidden.close();
    report.checks.push(
      "inactive Chrome tab defers all requests until a real tabs.onActivated event",
    );
    await options.bringToFront();
    await options.locator("#auto-translate").uncheck();
    await options.waitForFunction(() =>
      document.querySelector("#auto-status").textContent.includes("已关闭"),
    );
    assert.equal(
      (
        await worker.evaluate(() =>
          chrome.scripting.getRegisteredContentScripts(),
        )
      ).length,
      0,
    );
    const disabledRequests = mock.requests.length;
    await automaticPage.bringToFront();
    await automaticPage.goto("http://127.0.0.1:8787/latency.html?disabled=1");
    await automaticPage.waitForTimeout(700);
    assert.equal(await automaticPage.locator("[data-bt-next]").count(), 0);
    assert.equal(mock.requests.length, disabledRequests);
    report.checks.push(
      "disable switch unregisters bootstrap and prevents new page requests",
    );
    await options.bringToFront();
    await options.locator("#clear-key").click();
    await options.locator("#auto-translate").check();
    await options.waitForFunction(() =>
      document.querySelector("#auto-status").textContent.includes("尚未配置"),
    );
    const missingKeyRequests = mock.requests.length;
    await automaticPage.bringToFront();
    await automaticPage.goto(
      "http://127.0.0.1:8787/latency.html?missing-key=1",
    );
    await automaticPage.waitForTimeout(400);
    await popup.reload();
    await popup.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("CONFIG_INVALID"),
    );
    assert.equal(mock.requests.length, missingKeyRequests);
    report.checks.push(
      "missing key shows a visible popup error without a provider request",
    );
    await options.locator("#key").fill("test-key");
    await options.locator("#save").click();
    await options.getByText("配置已保存", { exact: false }).waitFor();
    await automaticPage.bringToFront();
    await automaticPage.waitForFunction(
      () => document.querySelectorAll("main [data-bt-next]").length === 6,
    );
    report.checks.push(
      "explicit connection save rechecks the unstarted page without refresh or Start click",
    );
    await options.locator("#auto-translate").uncheck();
    await options.waitForFunction(() =>
      document.querySelector("#auto-status").textContent.includes("已关闭"),
    );
    const subtitleFile = path.join(output, "controlled-24-cues.srt");
    await fs.writeFile(
      subtitleFile,
      exportSubtitles(
        Array.from({ length: 24 }, (_, i) => ({
          id: "cue" + i,
          start: i * 2,
          end: i * 2 + 1.8,
          text:
            "Controlled imported subtitle number " +
            i +
            " for first-result latency measurement.",
        })),
        "srt",
      ),
    );
    const video = await context.newPage();
    await video.goto("http://127.0.0.1:8787/platform-layout.html");
    await video.evaluate(async () => {
      const v = document.querySelector("video");
      v.muted = true;
      await v.play();
    });
    await video.waitForFunction(
      () => document.querySelector("video").currentTime > 0.1,
    );
    await video.evaluate(() => document.querySelector("video").pause());
    await video.evaluate(() => {
      globalThis.__subtitlePerf = {};
      new MutationObserver(() => {
        const row = document.querySelector(".bt-next-subtitle-translation"),
          track = [...document.querySelector("video").textTracks].find(
            (t) => t.label === "双语阅读 Next",
          );
        if (row?.textContent.includes("MOCK") && !__subtitlePerf.first)
          __subtitlePerf.first = Date.now();
        if (
          track?.cues?.length === 24 &&
          [...track.cues].every((c) => c.text.includes("MOCK")) &&
          !__subtitlePerf.all
        )
          __subtitlePerf.all = Date.now();
      }).observe(document.body, { childList: true, subtree: true });
    });
    await popup.reload();
    await popup.locator("#video-open").click();
    await popup.locator("#video-file").setInputFiles(subtitleFile);
    await popup.evaluate(() =>
      document
        .querySelector("#video-start")
        .addEventListener(
          "click",
          () => (globalThis.__subtitleClick = Date.now()),
          { once: true },
        ),
    );
    const subtitleRequests = mock.requests.length;
    await popup.locator("#video-start").click();
    await video.waitForFunction(() => __subtitlePerf.all);
    const subtitleAt = await popup.evaluate(() => __subtitleClick),
      subtitleTimes = await video.evaluate(() => __subtitlePerf);
    report.subtitles = {
      firstVisibleMs: subtitleTimes.first - subtitleAt,
      all24Ms: subtitleTimes.all - subtitleAt,
      requests: mock.requests.length - subtitleRequests,
      scope: "controlled imported captions; local 120ms API; simulated player",
    };
    assert.ok(report.subtitles.firstVisibleMs < report.subtitles.all24Ms);
    assert.equal(report.subtitles.requests, 3);
    report.checks.push(
      "first bilingual subtitle appears before all 24 cues complete",
    );
  }
  report.browser = context.browser().version();
  assert.equal(report.errors.length, 0);
  report.success = true;
} catch (error) {
  report.failure = error.message;
  report.failurePages = [];
  for (const p of context?.pages() || []) {
    if (!p.url().startsWith("http://127.0.0.1:8787/latency")) continue;
    report.failurePages.push(
      await p.evaluate(() => ({
        url: location.href,
        visible: document.visibilityState,
        translations: document.querySelectorAll("[data-bt-next]").length,
      })),
    );
  }
  if (worker)
    report.isolatedState = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({
        url: "http://127.0.0.1:8787/latency*",
      });
      const result = [];
      for (const tab of tabs) {
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            url: location.href,
            autoLoaded: globalThis.__btNextAutoLoaded,
            autoError: globalThis.__btNextAutoError,
            suppressed: globalThis.__btNextAutoSuppressed,
          }),
        });
        result.push(frame.result);
      }
      return result;
    });
  throw error;
} finally {
  await fs.writeFile(
    path.join(output, "page-speed-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await context?.close();
  mock.server.closeAllConnections();
  await new Promise((r) => mock.server.close(r));
}
