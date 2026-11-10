// Public-site validation. Imported control cues are deliberately unrelated to
// the videos' speech. This test never configures or calls a paid service.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output = process.env.BT_OUTPUT || path.join(os.tmpdir(), "bt-public-sites"),
  profile = path.join(output, "owned-profile-" + Date.now());
await fs.mkdir(output, { recursive: true });
let context;
const report = {
  date: new Date().toISOString(),
  scope:
    "Logged-out public players; imported control cues, not site transcription; no translation or ASR configuration",
  sites: [],
  blockedPaidRequests: 0,
};
const cues = [
  {
    id: "control-one",
    start: 3,
    end: 4.5,
    text: "Imported control cue one",
    translation: "导入测试字幕一",
  },
  {
    id: "control-two",
    start: 6,
    end: 8,
    text: "Imported control cue two",
    translation: "导入测试字幕二",
  },
];
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    args: [
      `--load-extension=${root}`,
      `--disable-extensions-except=${root}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
    viewport: { width: 1440, height: 1000 },
  });
  await context.route(
    /https:\/\/(?:api\.openai\.com|api\.deepseek\.com|api\.anthropic\.com|translation\.googleapis\.com)\//,
    (route) => {
      report.blockedPaidRequests++;
      return route.abort("blockedbyclient");
    },
  );
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host,
    cdp = await context.browser().newBrowserCDPSession(),
    ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/src/ui/options.html`);
  assert.equal(await ui.locator("#key").inputValue(), "");
  const send = (type, tabId, data = {}) =>
    ui.evaluate(
      (message) => chrome.runtime.sendMessage({ channel: "BT_BG", ...message }),
      { type, tabId, ...data },
    );
  for (const site of [
    {
      name: "youtube",
      url: "https://www.youtube.com/watch?v=eIho2S0ZahI",
      host: "#movie_player",
    },
    {
      name: "bilibili",
      url: "https://www.bilibili.com/video/BV1J94y177Nt/",
      host: ".bpx-player-container",
    },
  ]) {
    if (
      process.env.BT_SITES &&
      !process.env.BT_SITES.split(",").includes(site.name)
    )
      continue;
    const page = await context.newPage(),
      row = {
        name: site.name,
        url: site.url,
        checks: [],
        pageErrors: [],
        captionResponses: [],
      };
    report.sites.push(row);
    page.on("pageerror", (error) => row.pageErrors.push(error.message));
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/api/timedtext") {
        const body = await response.body().catch(() => null);
        row.captionResponses.push({
          path: url.pathname,
          status: response.status(),
          bytes: body?.length ?? null,
        });
      }
    });
    await page.goto(site.url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForFunction(
      (host) => {
        const v = document.querySelector(host + " video"),
          s = document.getElementById("movie_player")?.getPlayerResponse?.()
            ?.playabilityStatus?.status;
        return (
          ["LOGIN_REQUIRED", "UNPLAYABLE", "ERROR"].includes(s) ||
          (v && Number.isFinite(v.duration) && v.duration > 10)
        );
      },
      site.host,
      { timeout: 45000 },
    );
    const playability = await page.evaluate(() => {
      const p = document
        .getElementById("movie_player")
        ?.getPlayerResponse?.()?.playabilityStatus;
      return p ? { status: p.status, reason: p.reason } : null;
    });
    if (playability && playability.status !== "OK") {
      row.blocked = playability;
      await page
        .screenshot({
          path: path.join(output, site.name + "-blocked.png"),
          timeout: 5000,
        })
        .catch(() => {});
      await page.close();
      continue;
    }
    row.title = await page.title();
    assert.ok(row.title.length);
    row.checks.push("public page and finite playable video loaded");
    const targets = await cdp.send("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }, { exclude: true }],
      }),
      target = targets.targetInfos.find((t) => t.url === page.url());
    assert.ok(target);
    await cdp.send("Extensions.triggerAction", {
      id,
      targetId: target.targetId,
    });
    const tabId = await worker.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((t) => t.url === url).id,
      page.url(),
    );
    const listed = await send("VIDEO_LIST", tabId);
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    assert.ok(listed.data[0]);
    if (process.env.BT_QUICK_CHECK === "1") {
      const quickStarted = Date.now(),
        quick = await send("VIDEO_QUICK", tabId);
      row.quickExistingCaption = {
        elapsedMs: Date.now() - quickStarted,
        ok: quick.ok,
        error: quick.error,
      };
      assert.equal(
        quick.ok,
        false,
        "fresh profile has no text service key; no paid job may start",
      );
      assert.ok(
        [
          "SUBTITLE_LOGIN_REQUIRED",
          "SUBTITLE_EMPTY",
          "SUBTITLE_UNAVAILABLE",
          "SUBTITLE_HTTP_ERROR",
          "SUBTITLE_FETCH_FAILED",
          "CONFIG_INVALID",
        ].includes(quick.error.code),
        JSON.stringify(quick.error),
      );
      row.checks.push(
        "one-click existing-caption lookup reports the site boundary without ASR or text API",
      );
    }
    row.video = {
      label: listed.data[0].label,
      tracks: listed.data[0].tracks.map(({ id, language, label }) => ({
        id,
        language,
        label,
      })),
      notice: listed.data[0].notice,
    };
    if (site.name === "youtube") {
      assert.ok(row.video.tracks.some((t) => t.language === "en"));
      assert.ok(row.video.tracks.some((t) => /^zh/.test(t.language)));
      row.checks.push(
        "English and Chinese caption tracks retained beyond old 40-track cutoff",
      );
      const track = listed.data[0].tracks.find((t) => t.language === "en"),
        read = await send("VIDEO_READ", tabId, {
          videoId: listed.data[0].id,
          trackId: track.id,
        });
      row.captionRead = read.ok
        ? { ok: true, cues: read.data.cues.length }
        : { ok: false, error: read.error };
      if (!read.ok)
        assert.ok(
          [
            "SUBTITLE_EMPTY",
            "SUBTITLE_UNAVAILABLE",
            "SUBTITLE_FETCH_FAILED",
            "SUBTITLE_HTTP_ERROR",
          ].includes(read.error.code),
          JSON.stringify(read.error),
        );
    } else {
      row.captionRead = {
        notice: row.video.notice,
        availableTracks: row.video.tracks.length,
      };
      row.activeSource = await page
        .locator("video[data-bt-next-source-id]")
        .first()
        .getAttribute("data-bt-next-source-id");
      assert.match(row.activeSource, /^bilibili:BV1J94y177Nt:\d+$/);
      row.checks.push("active CID read from public player manifest");
    }
    const applied = await send("VIDEO_APPLY", tabId, {
      videoId: listed.data[0].id,
      cues,
    });
    assert.equal(applied.ok, true, JSON.stringify(applied.error));
    await page.evaluate(async (host) => {
      const v = document.querySelector(host + " video");
      v.muted = true;
      await v.play();
      v.currentTime = 6.4;
    }, site.host);
    await page.waitForFunction(
      () =>
        document.querySelector(".bt-next-subtitle-translation")?.textContent ===
        "导入测试字幕二",
    );
    await page.evaluate(
      (host) => document.querySelector(host + " video").pause(),
      site.host,
    );
    const layout = await page.locator(".bt-next-subtitles").evaluate((el) => {
      const r = el.getBoundingClientRect(),
        h = el.parentElement.getBoundingClientRect();
      return {
        text: el.textContent,
        font: parseFloat(getComputedStyle(el).fontSize),
        width: r.width,
        height: r.height,
        within:
          r.left >= h.left &&
          r.right <= h.right &&
          r.top >= h.top &&
          r.bottom <= h.bottom,
      };
    });
    assert.ok(layout.within);
    assert.ok(layout.font >= 14 && layout.font <= 28);
    assert.match(layout.text, /Imported control cue two/);
    row.layout = layout;
    row.checks.push(
      "specific second bilingual cue displayed after seek, inside player bounds",
    );
    await page.locator(site.host).evaluate((el) => el.requestFullscreen());
    await page.waitForFunction(
      (host) => document.fullscreenElement === document.querySelector(host),
      site.host,
    );
    await page.screenshot({
      path: path.join(output, site.name + "-fullscreen.png"),
    });
    assert.equal(
      await page.locator(".bt-next-subtitle-translation").textContent(),
      "导入测试字幕二",
    );
    row.checks.push("container fullscreen retains bilingual layer");
    await page.evaluate(() => document.exitFullscreen());
    await page.evaluate((host) => {
      document.querySelector(host + " video").currentTime = 5.2;
    }, site.host);
    await page.waitForFunction(
      () => document.querySelector(".bt-next-subtitles")?.textContent === "",
    );
    row.checks.push("gap between cues clears both lines");
    const stopped = await send("VIDEO_STOP", tabId);
    assert.equal(stopped.ok, true);
    assert.equal(await page.locator(".bt-next-subtitles").count(), 0);
    assert.equal(await page.locator("[data-bt-next-watch]").count(), 0);
    assert.equal(await page.locator("[data-bt-next-platform]").count(), 0);
    row.checks.push("restore removes owned layer and watcher tokens");
    const reapplied = await send("VIDEO_APPLY", tabId, {
      videoId: listed.data[0].id,
      cues,
    });
    assert.equal(reapplied.ok, true);
    const before = await page.evaluate(() => ({
      clock: performance.timeOrigin,
      url: location.href,
      cid: window.player?.getManifest?.().cid,
    }));
    let next;
    if (site.name === "youtube")
      next = page.locator(".ytp-next-button").first();
    else {
      row.partLinks = await page.locator("a[href]").evaluateAll((links) =>
        links
          .filter(
            (a) =>
              a.href.includes("/video/BV1J94y177Nt") &&
              /[?&]p=2(?:&|$)/.test(a.href),
          )
          .slice(0, 4)
          .map((a) => ({ text: a.textContent.slice(0, 100), href: a.href })),
      );
      next = page
        .locator('a[href*="/video/BV1J94y177Nt"][href*="p=2"]')
        .filter({ visible: true })
        .first();
      if (!(await next.count()))
        next = page
          .getByText(
            /^2023-04-12 4 Ways to Make Hybrid Work Better for Everyone/,
          )
          .filter({ visible: true })
          .first();
    }
    if ((await next.count()) && (await next.isVisible())) {
      await next.click({ timeout: 10000 });
      try {
        await page.waitForFunction(
          (before) =>
            location.href !== before.url ||
            (window.player?.getManifest?.().cid &&
              window.player.getManifest().cid !== before.cid),
          before,
          { timeout: 20000 },
        );
        await page.waitForFunction(
          () => !document.querySelector(".bt-next-subtitles"),
          null,
          { timeout: 5000 },
        );
        const after = await page.evaluate(() => ({
          clock: performance.timeOrigin,
          url: location.href,
          cid: window.player?.getManifest?.().cid,
        }));
        row.navigation = {
          before,
          after,
          sameDocument: before.clock === after.clock,
        };
        row.checks.push(
          "normal next control changes video/part and removes old subtitles",
        );
        if (row.navigation.sameDocument) {
          const stale = await send("VIDEO_APPLY", tabId, {
            videoId: listed.data[0].id,
            cues,
          });
          assert.equal(stale.ok, false);
          assert.equal(stale.error.code, "VIDEO_CHANGED");
          row.checks.push(
            "old selected video ID is rejected after in-page part change",
          );
        }
      } catch (error) {
        row.navigation = { before, blocked: error.message.split("\n")[0] };
      }
    } else
      row.navigation = {
        unverified: "No visible ordinary next/part link in this guest page",
      };
    await page.close();
  }
  assert.equal(report.blockedPaidRequests, 0);
  report.browser = context.browser().version();
  report.success = true;
  report.fullyExercised = report.sites.every(
    (s) =>
      !s.blocked &&
      s.captionRead?.ok &&
      !s.navigation?.unverified &&
      !s.navigation?.blocked,
  );
} catch (error) {
  report.failure = error.message;
  for (const page of context?.pages() || []) {
    if (!/^https?:/.test(page.url())) continue;
    await page
      .screenshot({
        path: path.join(output, "blocked-" + Date.now() + ".png"),
        timeout: 5000,
      })
      .catch(() => {});
    report.diagnostic = await page
      .evaluate(() => {
        const p = document
          .getElementById("movie_player")
          ?.getPlayerResponse?.()?.playabilityStatus;
        return {
          title: document.title,
          body: document.body.innerText.slice(0, 800),
          videos: [...document.querySelectorAll("video")].map((v) => ({
            duration: Number.isFinite(v.duration) ? v.duration : null,
            ready: v.readyState,
            paused: v.paused,
            error: v.error?.message,
          })),
          playability: p ? { status: p.status, reason: p.reason } : null,
        };
      })
      .catch(() => null);
  }
  throw error;
} finally {
  await fs.writeFile(
    path.join(output, "site-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await context?.close();
  const resolved = path.resolve(profile);
  if (
    !resolved.startsWith(path.resolve(output) + path.sep) ||
    !path.basename(resolved).startsWith("owned-profile-")
  )
    throw Error("UNSAFE_PROFILE_PATH");
  await fs.rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
