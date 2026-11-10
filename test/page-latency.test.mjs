import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/content/scheduler.js";
import { Jobs } from "../src/background/jobs.js";
import { Cache, Diagnostics } from "../src/background/cache.js";

// Real scheduler, splitting, authorization, budgets and memory cache. Only the
// external service is controlled: every released wave represents 100 ms.
async function screen(count) {
  const pending = [],
    shown = [],
    requests = [];
  let wave = 0;
  const jobs = new Jobs({
    cache: new Cache(),
    diagnostics: new Diagnostics(),
    translate: (items) =>
      new Promise((resolve) => {
        requests.push(items.map((x) => x.id));
        pending.push(() =>
          resolve(items.map((x) => ({ id: x.id, text: "译文 " + x.text }))),
        );
      }),
  });
  const binding = { tabId: 1, documentId: "latency", frameId: 0 },
    sender = { tab: { id: 1 }, documentId: "latency", frameId: 0 };
  const config = {
    provider: "openai",
    model: "controlled-latency",
    source: "auto",
    target: "zh-CN",
    cacheEnabled: false,
  };
  const records = Array.from({ length: count }, (_, i) => ({
    id: "paragraph" + i,
    revision: 0,
    text:
      "Visible English paragraph " +
      i +
      " explains a distinct scientific observation.",
    element: { isConnected: true },
  }));
  async function run() {
    const job = jobs.create(binding, config),
      session = new Session({
        job: { id: job.id, target: "zh-CN" },
        extractor: {
          scan: () => records,
          current: (r) =>
            records.some((x) => x.id === r.id && x.revision === r.revision),
        },
        renderer: {
          show: (r, text, language, error) => {
            if (!error) shown.push({ id: r.id, wave, text });
          },
          remove() {},
          restore() {},
        },
        send: async (type, data) => {
          if (type === "PREPARE")
            return jobs.prepare(sender, job.id, data.paragraphId, data.text);
          if (type === "PREPARE_ITEMS")
            return jobs.prepareItems(
              sender,
              job.id,
              data.paragraphId,
              data.items,
            );
          if (type === "BATCH")
            return jobs.run(sender, { jobId: job.id, ...data });
          if (type === "RELEASE")
            return jobs.release(sender, job.id, data.paragraphId);
          throw Error("Unexpected " + type);
        },
      });
    session.scan();
    for (const record of records) session.visible.add(record.id);
    let done = false;
    const running = session.pump().then(() => (done = true));
    for (let turn = 0; !done && turn < 500; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (pending.length) {
        wave++;
        for (const release of pending.splice(0)) release();
      }
    }
    assert.ok(done, "controlled scheduler loop must finish");
    await running;
    assert.equal(session.state().counts.translated, count);
    return job.budget.snapshot();
  }
  const coldBudget = await run(),
    coldCalls = requests.length,
    cold = shown.slice();
  wave = 0;
  shown.length = 0;
  const warmBudget = await run();
  return {
    coldFirstMs: cold[0].wave * 100,
    coldScreenMs: Math.max(...cold.map((x) => x.wave)) * 100,
    coldCalls,
    cacheCalls: requests.length - coldCalls,
    cacheWaves: wave,
    coldBudget,
    warmBudget,
  };
}
for (const count of [6, 3])
  test(
    count +
      " visible short paragraphs do not serialize first-screen service latency",
    async () => {
      const result = await screen(count);
      console.log(
        "CONTROLLED_PAGE_LATENCY",
        JSON.stringify({ paragraphs: count, ...result }),
      );
      assert.equal(result.cacheCalls, 0);
      assert.equal(result.cacheWaves, 0);
      assert.equal(result.coldBudget.segmentsUsed, count);
      assert.equal(result.warmBudget.segmentsUsed, 0);
      assert.ok(
        result.coldScreenMs <= 200,
        "first screen took " +
          result.coldScreenMs +
          " ms at 100 ms per controlled service wave",
      );
      assert.ok(
        result.coldCalls <= 2,
        "short visible paragraphs should share bounded requests",
      );
    },
  );

for (const slowText of [
  "English sentence. ".repeat(75),
  "A newly updated short English paragraph.",
])
  test(
    "a cached visible paragraph appears while a " +
      (slowText.length > 1200 ? "long" : "grouped short") +
      " paragraph still waits for the service",
    async () => {
      const cache = new Cache(),
        config = {
          provider: "openai",
          model: "controlled-latency",
          source: "auto",
          target: "zh-CN",
          cacheEnabled: false,
        };
      await cache.put(
        "A previously translated short paragraph.",
        "已有译文",
        config,
      );
      let release, entered;
      const started = new Promise((resolve) => (entered = resolve)),
        shown = [];
      const jobs = new Jobs({
          cache,
          diagnostics: new Diagnostics(),
          translate: (items) => {
            entered();
            return new Promise(
              (resolve) =>
                (release = () =>
                  resolve(
                    items.map((x) => ({ id: x.id, text: "长段落译文" })),
                  )),
            );
          },
        }),
        sender = {
          tab: { id: 1 },
          documentId: "cached-first-screen",
          frameId: 0,
        },
        job = jobs.create(
          { tabId: 1, documentId: sender.documentId, frameId: 0 },
          config,
        );
      const records = [
        {
          id: "slow",
          text: slowText,
          revision: 0,
          element: { isConnected: true },
        },
        {
          id: "cached",
          text: "A previously translated short paragraph.",
          revision: 0,
          element: { isConnected: true },
        },
      ];
      const s = new Session({
        job: { id: job.id, target: "zh-CN" },
        extractor: { scan: () => records, current: () => true },
        renderer: {
          show: (record, text, lang, error) => {
            if (!error) shown.push({ id: record.id, text });
          },
          remove() {},
          restore() {},
        },
        send: async (type, data) => {
          if (type === "PREPARE")
            return jobs.prepare(sender, job.id, data.paragraphId, data.text);
          if (type === "PREPARE_ITEMS")
            return jobs.prepareItems(
              sender,
              job.id,
              data.paragraphId,
              data.items,
            );
          if (type === "BATCH")
            return jobs.run(sender, { jobId: job.id, ...data });
          if (type === "RELEASE")
            return jobs.release(sender, job.id, data.paragraphId);
        },
      });
      s.scan();
      for (const r of records) s.visible.add(r.id);
      const running = s.pump();
      await started;
      for (let i = 0; i < 20 && !shown.some((r) => r.id === "cached"); i++)
        await new Promise((r) => setTimeout(r, 5));
      const cachedBeforeNetwork = shown.some((r) => r.id === "cached");
      release();
      await running;
      assert.equal(
        cachedBeforeNetwork,
        true,
        "cached first-screen content must not wait for an unrelated network request",
      );
      assert.equal(shown.find((r) => r.id === "cached").text, "已有译文");
    },
  );
