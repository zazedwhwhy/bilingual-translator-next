import { test } from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../src/background/jobs.js";
import { Cache, Diagnostics } from "../src/background/cache.js";
import { DocumentRunner } from "../src/documents/runner.js";
import { videoActions } from "../src/background/video.js";
test("applying existing bilingual cues does not configure or call a translation service", async () => {
  let sent;
  const handle = videoActions(
    {
      tabs: {
        get: async () => ({ url: "https://example.com/video" }),
        sendMessage: async (tabId, message) => {
          sent = message;
          return { ok: true, data: { phase: "displayed" } };
        },
      },
      scripting: {
        executeScript: async () => [{ documentId: "doc" }],
        insertCSS: async () => {},
      },
      runtime: { getURL: (p) => "chrome-extension://test/" + p },
    },
    {
      jobs: { create: () => assert.fail("must not create a translation job") },
      settings: {
        snapshot: () => assert.fail("must not read translation credentials"),
      },
    },
  );
  const state = await handle({
    type: "VIDEO_APPLY",
    tabId: 1,
    videoId: "video1",
    cues: [{ id: "c", start: 0, end: 1, text: "Hello", translation: "你好" }],
  });
  assert.equal(state.phase, "displayed");
  assert.equal(sent.type, "APPLY");
  assert.equal(sent.cues[0].translation, "你好");
});
const binding = { tabId: 1, documentId: "doc", frameId: 0, kind: "video" },
  sender = { tab: { id: 1 }, documentId: "doc", frameId: 0 };
test("live subtitles append in the same job and preserve existing translations and budget", async () => {
  let starts = 0,
    batches = 0;
  const r = new DocumentRunner(async (type, data) => {
    if (type === "WB_START") {
      starts++;
      return { id: "live" };
    }
    if (type === "WB_PREPARE_ITEMS")
      return {
        cached: [],
        ids: data.items.map((x) => x.id),
        batches: [{ batchId: "b" + batches++, items: data.items }],
        budget: { round: 1 },
      };
    if (type === "WB_BATCH")
      return {
        translations: data.items.map((x) => ({
          id: x.id,
          text: "译" + x.text,
        })),
        budget: { round: 1 },
      };
    return {};
  });
  const a = { id: "a", text: "First" },
    b = { id: "b", text: "Second" };
  await r.start({ batchItems: true, segments: [a] });
  assert.equal(
    typeof r.extend,
    "function",
    "runner must support live cue append",
  );
  await r.extend({ batchItems: true, segments: [a, b] });
  assert.equal(starts, 1);
  assert.equal(batches, 2);
  assert.equal(r.translations.get("a"), "译First");
  assert.equal(r.translations.get("b"), "译Second");
  assert.equal(r.phase, "complete");
});
test("video and page jobs coexist; starting new video cancels only old video", () => {
  const jobs = new Jobs({ cache: new Cache(), diagnostics: new Diagnostics() });
  const page = jobs.create({ ...binding, kind: undefined }, {}),
    video = jobs.create(binding, {});
  assert.equal(page.cancelled, false);
  jobs.create(binding, {});
  assert.equal(video.cancelled, true);
  assert.equal(page.cancelled, false);
});
test("subtitle item batch preserves IDs and reuses cache without spending budget", async () => {
  const jobs = new Jobs({
    cache: new Cache(),
    diagnostics: new Diagnostics(),
    translate: async (xs) =>
      xs.map((x) => ({ id: x.id, text: "译 " + x.text })),
  });
  const j = jobs.create(binding, {
      provider: "openai",
      model: "m",
      source: "auto",
      target: "zh-CN",
    }),
    items = [
      { id: "cue0", text: "First" },
      { id: "cue1", text: "Second" },
    ];
  const p = await jobs.prepareItems(sender, j.id, "group0", items);
  assert.deepEqual(p.ids, ["cue0", "cue1"]);
  assert.equal(p.batches.length, 1);
  await jobs.run(sender, { jobId: j.id, ...p.batches[0] });
  const hit = await jobs.prepareItems(sender, j.id, "group1", items);
  assert.equal(hit.cached.length, 2);
  assert.equal(j.budget.total, 2);
  await assert.rejects(
    jobs.prepareItems(
      sender,
      j.id,
      "bad",
      Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: "x" })),
    ),
  );
});
test("subtitle runner translates multiple cues in one batch and maps by IDs", async () => {
  let requested = 0;
  const r = new DocumentRunner(async (type, data) => {
    if (type === "WB_START") return { id: "j" };
    if (type === "WB_PREPARE_ITEMS") {
      requested++;
      return {
        cached: [],
        ids: data.items.map((x) => x.id),
        batches: [{ batchId: "b", items: data.items }],
      };
    }
    if (type === "WB_BATCH")
      return {
        translations: [...data.items]
          .reverse()
          .map((x) => ({ id: x.id, text: "译文" + x.text })),
      };
    return {};
  });
  await r.start({
    batchItems: true,
    segments: [
      { id: "c0", text: "one" },
      { id: "c1", text: "two" },
    ],
  });
  assert.equal(requested, 1);
  assert.equal(r.translations.get("c0"), "译文one");
  assert.equal(r.translations.get("c1"), "译文two");
});

import * as cueModel from "../src/subtitles/model.js";
test("video translation prioritizes the playback position without changing cue IDs or export order", async () => {
  assert.equal(typeof cueModel.priorityCueIds, "function");
  const cues = Array.from({ length: 24 }, (_, i) => ({
    id: "original" + i,
    start: i,
    end: i + 0.9,
    text: "Line " + i,
  }));
  const doc = cueModel.cueDocument(cues, "video", { priorityTime: 17.2 });
  assert.equal(doc.segments[0].id, "cue17");
  assert.equal(doc.cues[0].id, "original0");
  let resume, started;
  const entered = new Promise((r) => (started = r)),
    batches = [],
    r = new DocumentRunner(async (type, data) => {
      if (type === "WB_START") return { id: "j" };
      if (type === "WB_PREPARE_ITEMS")
        return {
          cached: [],
          ids: data.items.map((x) => x.id),
          batches: [{ batchId: "b" + batches.length, items: data.items }],
        };
      if (type === "WB_BATCH") {
        batches.push(data.items.map((x) => x.id));
        if (batches.length === 1) {
          started();
          await new Promise((done) => (resume = done));
        }
        return {
          translations: data.items.map((x) => ({
            id: x.id,
            text: "译 " + x.text,
          })),
        };
      }
      return {};
    });
  const running = r.start(cueModel.cueDocument(cues));
  await entered;
  assert.equal(typeof r.prioritize, "function");
  r.prioritize(cueModel.priorityCueIds(cues, 17.2));
  resume();
  await running;
  assert.equal(batches[1][0], "cue17");
  assert.equal(new Set(batches.flat()).size, 24);
  assert.equal(batches.flat().length, 24);
  assert.equal(r.phase, "complete");
});

test("stopping while video initialization is pending cannot start a later paid job", async () => {
  let release,
    entered,
    created = 0;
  const pending = new Promise((r) => (entered = r));
  const handle = videoActions(
    {
      tabs: {
        get: async () => ({ url: "https://example.com/video" }),
        sendMessage: async () => ({ ok: true, data: { phase: "idle" } }),
      },
      scripting: {
        executeScript: async () => {
          entered();
          await new Promise((r) => (release = r));
          return [{ documentId: "d" }];
        },
        insertCSS: async () => {},
      },
      runtime: { getURL: (p) => "chrome-extension://test/" + p },
    },
    {
      jobs: {
        create: () => {
          created++;
          return { id: "j" };
        },
        cancel: () => {},
      },
      settings: { snapshot: async () => ({}), public: async () => ({}) },
    },
  );
  const start = handle({
    type: "VIDEO_START",
    tabId: 1,
    videoId: "video1",
    cues: [{ id: "a", start: 0, end: 1, text: "Hello" }],
  });
  await pending;
  await handle({ type: "VIDEO_STOP", tabId: 1 });
  release();
  await assert.rejects(start, { code: "CANCELLED" });
  assert.equal(created, 0);
});

test("stop during public settings lookup cannot dispatch a late video INIT", async () => {
  let release, entered;
  const pending = new Promise((r) => (entered = r)),
    sent = [];
  const handle = videoActions(
    {
      tabs: {
        get: async () => ({ url: "https://example.com/video" }),
        sendMessage: async (tab, msg) => {
          sent.push(msg.type);
          return { ok: true, data: { phase: "idle" } };
        },
      },
      scripting: {
        executeScript: async () => [{ documentId: "d" }],
        insertCSS: async () => {},
      },
      runtime: { getURL: (p) => "chrome-extension://test/" + p },
    },
    {
      jobs: { create: () => ({ id: "j" }), cancel: () => {} },
      settings: {
        snapshot: async () => ({}),
        public: async () => {
          entered();
          await new Promise((r) => (release = r));
          return {};
        },
      },
    },
  );
  const starting = handle({
    type: "VIDEO_START",
    tabId: 1,
    videoId: "video1",
    cues: [{ id: "a", start: 0, end: 1, text: "Hello" }],
  });
  await pending;
  await handle({ type: "VIDEO_STOP", tabId: 1 });
  release();
  await assert.rejects(starting, { code: "CANCELLED" });
  assert.equal(sent.includes("INIT"), false);
});
