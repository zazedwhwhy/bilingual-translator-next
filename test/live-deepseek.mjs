import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { LiveBudget } from "./support/live-budget.mjs";
delete process.env.DEBUG;
delete process.env.PWDEBUG;
delete process.env.NODE_DEBUG;
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  process.env.BT_OUTPUT || path.join(root, "../../.tmp/deepseek-live"),
);
const live = process.argv.includes("--live"),
  budget = new LiveBudget();
let suppliedSecret = live ? null : "test-key",
  context,
  server;
const report = {
  mode: live ? "DeepSeek real API" : "dry run; no external API",
  model: "deepseek-flash",
  checks: [],
  requests: [],
  errors: [],
  priceSources: [
    "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    "https://api-docs.deepseek.com/quick_start/pricing/",
    "https://api-docs.deepseek.com/api/create-chat-completion/",
  ],
};
const profile = path.join(output, "owned-profile-" + Date.now()),
  bundle = path.join(output, "extension");
const articleText =
  "The laboratory did not confirm that the new battery was safe. At 20 °C, its mass fell by 3.5%, while the pressure remained below 101.3 kPa. Dr. Chen asked the team to record every result, including observations that contradicted their prediction.";
const captionTexts = [
  "The trial did not prove that the battery was safe.\nFurther tests are required before use.",
  "At 20 °C, the sample lost 3.5% of its mass.\nKeep the pressure below 101.3 kPa.",
  "Dr. Chen said: “Record the result, even if it contradicts our prediction.”",
];
const tickets = new Map(),
  pendingResponses = new Set();
const clean = (text) =>
  suppliedSecret
    ? String(text).split(suppliedSecret).join("<REDACTED>")
    : String(text);
async function providedSecret() {
  const handoff = process.env.BT_AUTH_HANDOFF;
  if (!handoff) throw Error("CREDENTIAL_HANDOFF_MISSING");
  // Read only this task's explicitly provided handoff. No search for other credentials.
  const rows = (await fs.readFile(handoff, "utf8")).split("\n");
  for (let i = rows.length - 1; i >= 0; i--) {
    if (
      !rows[i].includes("codex_delegation") ||
      !rows[i].includes("01a1bbb6-01b8-722a-a3a9-fc5ad2cdf0e6")
    )
      continue;
    let row;
    try {
      row = JSON.parse(rows[i]);
    } catch {
      continue;
    }
    const strings = [];
    const visit = (value) => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object")
        for (const child of Object.values(value)) visit(child);
    };
    visit(row);
    for (const value of strings) {
      if (!value.includes("<codex_delegation>") || !value.includes("凭据："))
        continue;
      const match = value.match(/凭据[：:]\s*(sk-[A-Za-z0-9_-]{16,})/);
      if (match) return match[1];
    }
  }
  throw Error("CREDENTIAL_HANDOFF_NOT_FOUND");
}
async function waitUsage() {
  await Promise.all([...pendingResponses]);
}
async function statusDone(page, selector, phase = "complete") {
  await page.waitForFunction(
    ({ selector, phase }) => {
      const e = document.querySelector(selector);
      return (
        e.dataset.phase === phase ||
        e.dataset.phase === "error" ||
        e.dataset.phase === "interrupted"
      );
    },
    { selector, phase },
    { timeout: 45000 },
  );
  assert.equal(
    await page.locator(selector).getAttribute("data-phase"),
    phase,
    clean(await page.locator(selector).textContent()),
  );
}
try {
  await fs.mkdir(output, { recursive: true });
  if (live) suppliedSecret = await providedSecret();
  await fs.cp(path.join(root, "src"), path.join(bundle, "src"), {
    recursive: true,
  });
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "manifest.json")),
  );
  manifest.host_permissions = [
    "https://api.deepseek.com/*",
    "http://127.0.0.1/*",
  ];
  await fs.writeFile(
    path.join(bundle, "manifest.json"),
    JSON.stringify(manifest),
  );
  server = http.createServer(async (req, res) => {
    if (req.url === "/fixture.webm") {
      res.setHeader("Content-Type", "video/webm");
      res.end(await fs.readFile(path.join(root, "test/fixtures/fixture.webm")));
      return;
    }
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Controlled public science fixture</title><style>body{max-width:900px;margin:32px auto;font:18px/1.6 system-ui}video{width:800px;max-width:95vw}#source{white-space:pre-line}button{padding:12px}</style><header><h1>Public synthetic science article</h1></header><main><p id="source">' +
        articleText +
        '</p></main><video id="video" controls src="/fixture.webm"></video><button id="fullscreen">Fullscreen</button><script>document.querySelector("#fullscreen").onclick=()=>document.querySelector("video").requestFullscreen()</script></html>',
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const articleURL = "http://127.0.0.1:" + server.address().port + "/";
  const popupScript = path.join(bundle, "src/ui/popup.js");
  await fs.writeFile(
    popupScript,
    (await fs.readFile(popupScript, "utf8")).replace(
      /tabId\s*=\s*tab\?\.id/,
      "tabId=(await chrome.tabs.query({url:" +
        JSON.stringify(articleURL) +
        "}))[0]?.id",
    ),
  );
  const args = [
    `--disable-extensions-except=${bundle}`,
    `--load-extension=${bundle}`,
    "--autoplay-policy=no-user-gesture-required",
  ];
  if (!live) args.push("--host-resolver-rules=MAP api.deepseek.com 127.0.0.1");
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    args,
    viewport: { width: 1280, height: 1000 },
  });
  context.on("page", (p) =>
    p.on("pageerror", (e) => report.errors.push(clean(e.message))),
  );
  await context.route("https://api.deepseek.com/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    try {
      if (
        request.method() !== "POST" ||
        url.pathname !== "/chat/completions" ||
        url.search
      )
        throw Error("LIVE_ENDPOINT_REJECTED");
      const body = request.postDataJSON(),
        bytes = Buffer.byteLength(request.postData() || "", "utf8"),
        ticket = budget.admit(body, bytes);
      tickets.set(request, {
        ticket,
        start: Date.now(),
        bodyBytes: bytes,
        ordinal: budget.calls,
      });
      if (live) await route.continue();
      else {
        const items = JSON.parse(body.messages[1].content).items;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            model: "deepseek-flash",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    translations: items.map((x) => ({
                      id: x.id,
                      text: "模拟译文 " + x.text,
                    })),
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 300,
              completion_tokens: 200,
              total_tokens: 500,
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 300,
            },
          }),
        });
      }
    } catch (error) {
      report.errors.push(clean(error.message));
      await route.abort("blockedbyclient");
    }
  });
  context.on("response", (response) => {
    if (!response.url().startsWith("https://api.deepseek.com/chat/completions"))
      return;
    const task = (async () => {
      const state = tickets.get(response.request());
      if (!state) throw Error("LIVE_UNGUARDED_RESPONSE");
      await response.finished();
      let data;
      try {
        data = await response.json();
      } catch {}
      const valid = budget.settle(state.ticket, data?.usage);
      const usage = {};
      for (const key of [
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "prompt_cache_hit_tokens",
        "prompt_cache_miss_tokens",
      ])
        if (Number.isSafeInteger(data?.usage?.[key]) && data.usage[key] >= 0)
          usage[key] = data.usage[key];
      if (
        Number.isSafeInteger(data?.usage?.prompt_tokens_details?.cached_tokens)
      )
        usage.prompt_tokens_details = {
          cached_tokens: data.usage.prompt_tokens_details.cached_tokens,
        };
      report.requests.push({
        ordinal: state.ordinal,
        apiMs: Date.now() - state.start,
        status: response.status(),
        inputBytes: state.bodyBytes,
        requestModel: "deepseek-flash",
        responseModel: data?.model,
        finishReason: data?.choices?.[0]?.finish_reason,
        usage,
        usageValidated: valid,
      });
    })();
    pendingResponses.add(task);
    task
      .finally(() => pendingResponses.delete(task))
      .catch((error) => report.errors.push(clean(error.message)));
  });
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/ui/options.html`);
  await options.locator("#provider").selectOption("deepseek");
  await options.locator("#model").fill("deepseek-flash");
  await options.locator("#cache").check();
  // The credential stays in local process/browser memory; it is never a source literal.
  await options.evaluate((value) => {
    const field = document.getElementById("key");
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, suppliedSecret);
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  const article = await context.newPage();
  await article.goto(articleURL);
  await article.bringToFront();
  await article.evaluate(() => {
    window.__display = {};
    new MutationObserver(() => {
      const result = document.querySelector(
        "#source .bt-next-result:not(.bt-next-error)",
      );
      if (result && !window.__display.first)
        window.__display.first = Date.now();
      if (result) window.__display.all = Date.now();
    }).observe(document.querySelector("#source"), {
      childList: true,
      subtree: true,
    });
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
  await popup.evaluate(() =>
    document
      .getElementById("start")
      .addEventListener("click", () => (window.__clicked = Date.now())),
  );
  await popup.locator("#start").click();
  await article
    .locator("#source .bt-next-result:not(.bt-next-error)")
    .waitFor({ timeout: 45000 });
  await waitUsage();
  assert.equal(budget.calls, 1);
  assert.equal(report.requests.length, 1);
  const clicked = await popup.evaluate(() => window.__clicked),
    display = await article.evaluate(() => window.__display),
    articleTranslation = await article
      .locator("#source .bt-next-result")
      .textContent();
  report.webCold = {
    firstDisplayMs: display.first - clicked,
    allDisplayMs: display.all - clicked,
    original: articleText,
    translation: articleTranslation,
  };
  report.checks.push(
    "cold webpage click → real service response → bilingual DOM",
  );
  await article.screenshot({ path: path.join(output, "web-real.png") });
  await popup.locator("#restore").click();
  await article.waitForFunction(
    () => !document.querySelector("#source [data-bt-next]"),
  );
  const warmStart = Date.now();
  await popup.locator("#start").click();
  await article
    .locator("#source .bt-next-result:not(.bt-next-error)")
    .waitFor();
  assert.equal(budget.calls, 1);
  report.webWarm = { displayMs: Date.now() - warmStart, additionalRequests: 0 };
  report.checks.push(
    "repeated webpage translation uses cached real result with zero extra requests",
  );
  const work = await context.newPage();
  await work.goto(`chrome-extension://${extensionId}/src/ui/workbench.html`);
  const srt = captionTexts
    .map(
      (text, i) =>
        i +
        1 +
        "\n00:00:0" +
        i +
        ",000 --> 00:00:0" +
        i +
        ",900\n" +
        text +
        "\n",
    )
    .join("\n");
  await work
    .locator("#subtitle-file")
    .setInputFiles({
      name: "controlled-science.srt",
      mimeType: "text/plain",
      buffer: Buffer.from(srt),
    });
  await statusDone(work, "#subtitle-status", "ready");
  await work.evaluate(() => {
    window.__subDisplay = {};
    new MutationObserver(() => {
      const text = document.getElementById("subtitle-list").textContent;
      if (/[\u4e00-\u9fff]/.test(text) && !window.__subDisplay.first)
        window.__subDisplay.first = Date.now();
      if (
        document.getElementById("subtitle-status").dataset.phase === "complete"
      )
        window.__subDisplay.all = Date.now();
    }).observe(document.getElementById("subtitle-section"), {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    document
      .getElementById("subtitle-translate")
      .addEventListener(
        "click",
        () => (window.__subDisplay.click = Date.now()),
      );
  });
  await work.locator("#subtitle-translate").click();
  await statusDone(work, "#subtitle-status");
  await waitUsage();
  assert.equal(budget.calls, 2);
  assert.equal(report.requests.length, 2);
  const subTimes = await work.evaluate(() => window.__subDisplay);
  report.subtitlesCold = {
    firstDisplayMs: subTimes.first - subTimes.click,
    allDisplayMs: subTimes.all - subTimes.click,
  };
  const dl = work.waitForEvent("download");
  await work.locator("#subtitle-srt").click();
  const subtitleDownload = await dl;
  await subtitleDownload.saveAs(
    path.join(output, "deepseek-real-bilingual.srt"),
  );
  const exported = await fs.readFile(
    path.join(output, "deepseek-real-bilingual.srt"),
    "utf8",
  );
  report.subtitleExport = exported;
  assert.ok(exported.includes("00:00:01,000 --> 00:00:01,900"));
  const { parseSubtitles } = await import("../src/subtitles/cues.js");
  const exportedCues = parseSubtitles(exported, "srt");
  report.checks.push(
    "three subtitle items share one real request and preserve SRT timestamps",
  );
  const targetTabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    articleURL,
  );
  const videoState = await popup.evaluate(
    async ({ tabId, cues }) => {
      const send = async (type, data = {}) => {
        const r = await chrome.runtime.sendMessage({
          channel: "BT_BG",
          type,
          tabId,
          ...data,
        });
        if (!r.ok) throw Error(r.error.message);
        return r.data;
      };
      const videos = await send("VIDEO_LIST");
      return send("VIDEO_APPLY", { videoId: videos[0].id, cues });
    },
    { tabId: targetTabId, cues: exportedCues },
  );
  report.step = "native subtitle seek";
  await article.bringToFront();
  await article.evaluate(async () => {
    const v = document.querySelector("video");
    await v.play();
    v.currentTime = 1.3;
  });
  await article.waitForFunction(
    () =>
      [...document.querySelector("video").textTracks].find(
        (t) => t.label === "双语阅读 Next",
      )?.activeCues?.[0]?.startTime === 1 &&
      document.querySelector("video").currentTime >= 1,
  );
  await article.evaluate(() => document.querySelector("video").pause());
  report.step = "native subtitle fullscreen";
  await article.locator("#fullscreen").click();
  await article.waitForFunction(
    () => document.fullscreenElement === document.querySelector("video"),
  );
  await article.screenshot({
    path: path.join(output, "subtitles-real-fullscreen.png"),
  });
  report.player = await article.evaluate(() => {
    const v = document.querySelector("video"),
      t = [...v.textTracks].find((t) => t.label === "双语阅读 Next");
    return {
      time: v.currentTime,
      active: [...(t.activeCues || [])].map((c) => ({
        start: c.startTime,
        end: c.endTime,
        text: c.text,
      })),
      cueCount: t.cues.length,
      fullscreen: document.fullscreenElement === v,
    };
  });
  await article.evaluate(() => document.exitFullscreen());
  assert.equal(budget.calls, 2);
  report.checks.push(
    "real translated subtitles remain timed and visible in fullscreen without extra requests",
  );
  const warmSubtitleStart = Date.now();
  await work.locator("#subtitle-translate").click();
  await statusDone(work, "#subtitle-status");
  assert.equal(budget.calls, 2);
  report.subtitlesWarm = {
    displayMs: Date.now() - warmSubtitleStart,
    additionalRequests: 0,
  };
  report.checks.push(
    "repeat subtitle translation uses cached real results with zero extra requests",
  );
  report.step = "complete";
  report.browser = context.browser().version();
  assert.equal(report.errors.length, 0);
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure = clean(error.message);
  report.failureStep = report.step;
  if (context) {
    const pages = context.pages();
    const active = pages.find((p) => p.url().startsWith("http://127.0.0.1"));
    if (active)
      report.videoDiagnostic = await active
        .evaluate(() => {
          const v = document.querySelector("video");
          return v
            ? {
                time: v.currentTime,
                paused: v.paused,
                source: v.currentSrc,
                tracks: [...v.textTracks].map((t) => ({
                  label: t.label,
                  mode: t.mode,
                  cues: t.cues?.length,
                  active: t.activeCues?.length,
                })),
              }
            : null;
        })
        .catch(() => null);
  }
} finally {
  await Promise.allSettled([...pendingResponses]);
  report.budget = budget.snapshot();
  report.totalUsage = {};
  for (const key of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
  ]) {
    const values = report.requests.map((r) => r.usage[key]);
    if (values.length && values.every(Number.isSafeInteger))
      report.totalUsage[key] = values.reduce((a, b) => a + b, 0);
  }
  if (report.requests.every((r) => r.usageValidated))
    report.estimatedRmbAtOfficialPeak = report.requests.reduce(
      (sum, r) =>
        sum +
        ((r.usage.prompt_cache_hit_tokens || 0) * 0.04 +
          (r.usage.prompt_cache_miss_tokens ?? r.usage.prompt_tokens) * 2 +
          r.usage.completion_tokens * 8) /
          1000000,
      0,
    );
  if (context) {
    try {
      for (const p of context.pages())
        if (p.url().startsWith("chrome-extension://")) {
          await p.evaluate(() => chrome.storage.local.clear());
          break;
        }
    } catch {
      report.cleanupStorage = "browser profile deletion required";
    }
    await context.close();
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const resolved = path.resolve(profile);
  if (
    !resolved.startsWith(output + path.sep) ||
    !path.basename(resolved).startsWith("owned-profile-")
  )
    throw Error("UNSAFE_PROFILE_PATH");
  await fs.rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  report.temporaryCredentialCleanup =
    "owned browser storage cleared; owned profile removed";
  await fs.writeFile(
    path.join(output, live ? "real-results.json" : "dry-results.json"),
    clean(JSON.stringify(report, null, 2)),
  );
  suppliedSecret = null;
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        success: report.success,
        checks: report.checks,
        budget: report.budget,
        totalUsage: report.totalUsage,
        estimatedRmbAtOfficialPeak: report.estimatedRmbAtOfficialPeak,
        failure: report.failure,
        failureStep: report.failureStep,
        credentialCleanup: report.temporaryCredentialCleanup,
      },
      null,
      2,
    ),
  );
  if (!report.success) process.exitCode = 1;
}
