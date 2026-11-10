import { test } from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../src/background/jobs.js";
import { Cache, Diagnostics } from "../src/background/cache.js";
const binding = { tabId: 1, documentId: "doc", frameId: 0 },
  sender = { tab: { id: 1 }, documentId: "doc", frameId: 0 };
const config = {
  provider: "openai",
  model: "m",
  secret: "secret",
  source: "auto",
  target: "zh-CN",
  cacheEnabled: false,
};

test("next budget round invalidates blocked preparation before returning", async () => {
  const jobs = make(async (xs) => xs),
    j = jobs.create(binding, config);
  j.budget.reserve("spent", ["a".repeat(60000)]);
  j.budget.dispatch("spent");
  const p = await jobs.prepare(sender, j.id, "new", "hello");
  assert.equal(p.blocked, true);
  await jobs.nextRound(sender, j.id);
  assert.equal(
    (await jobs.prepare(sender, j.id, "new", "hello")).blocked,
    undefined,
  );
});

test("cannot reset budget before a blocked paragraph", async () => {
  const jobs = make(async (xs) => xs),
    j = jobs.create(binding, config);
  await assert.rejects(async () => jobs.nextRound(sender, j.id), {
    code: "INVALID_STATE",
  });
});
const make = (translate) =>
  new Jobs({ translate, cache: new Cache(), diagnostics: new Diagnostics() });
test("a first video subtitle request passes queued page work without increasing the two active slots", async () => {
  const order = [],
    release = new Map();
  let active = 0,
    maximum = 0;
  const jobs = make(
    (items, c, signal) =>
      new Promise((resolve, reject) => {
        const id = items[0].id.split(":")[0];
        order.push(id);
        maximum = Math.max(maximum, ++active);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          active--;
          resolve(items.map((x) => ({ id: x.id, text: "translated" })));
        };
        release.set(id, finish);
        signal.addEventListener(
          "abort",
          () => {
            if (done) return;
            done = true;
            active--;
            reject(Object.assign(Error(), { code: "CANCELLED" }));
          },
          { once: true },
        );
      }),
  );
  const requests = [];
  for (const [i, id] of ["held1", "held2", "page", "video"].entries()) {
    const b = {
        tabId: i + 1,
        documentId: "doc" + i,
        frameId: 0,
        ...(id === "video" ? { kind: "video" } : {}),
      },
      s = { tab: { id: b.tabId }, documentId: b.documentId, frameId: 0 },
      j = jobs.create(b, config),
      plan = await jobs.prepare(s, j.id, id, "Source " + id);
    const running = jobs.run(s, { jobId: j.id, ...plan.batches[0] });
    void running.catch(() => {});
    requests.push(running);
  }
  const videoJob = [...jobs.jobs.values()].find(
      (j) => j.binding.kind === "video",
    ),
    videoSender = {
      tab: { id: videoJob.binding.tabId },
      documentId: videoJob.binding.documentId,
      frameId: 0,
    },
    tail = await jobs.prepare(
      videoSender,
      videoJob.id,
      "video-tail",
      "Source video followup",
    );
  const tailRunning = jobs.run(videoSender, {
    jobId: videoJob.id,
    ...tail.batches[0],
  });
  void tailRunning.catch(() => {});
  requests.push(tailRunning);
  for (let i = 0; i < 100 && order.length < 2; i++)
    await new Promise((r) => setTimeout(r, 2));
  release.get("held1")();
  for (let i = 0; i < 100 && order.length < 3; i++)
    await new Promise((r) => setTimeout(r, 2));
  const third = order[2];
  release.get("held2")();
  for (let i = 0; i < 100 && order.length < 4; i++)
    await new Promise((r) => setTimeout(r, 2));
  const fourth = order[3];
  for (const j of jobs.jobs.values()) jobs.cancel(j.id);
  await Promise.allSettled(requests);
  assert.equal(maximum, 2);
  assert.equal(
    third,
    "video",
    "subtitle first result must not wait behind unrelated queued page fragments",
  );
  assert.equal(fourth, "page", "later subtitle batches retain FIFO fairness");
});
test("bound document required and arbitrary batches cannot be submitted", async () => {
  const jobs = make(async (xs) => xs);
  const j = jobs.create(binding, config);
  await assert.rejects(
    jobs.prepare({ ...sender, documentId: "other" }, j.id, "p", "hello"),
    { code: "INVALID_MESSAGE" },
  );
  await assert.rejects(
    jobs.run(sender, {
      jobId: j.id,
      batchId: "invented",
      items: [{ id: "x", text: "hi" }],
    }),
    { code: "INVALID_MESSAGE" },
  );
});
test("repeat batch reuses known promise and cancellation aborts actual signal", async () => {
  let calls = 0,
    signal;
  const jobs = make(async (xs, c, s) => {
    calls++;
    signal = s;
    await new Promise((r, j) =>
      s.addEventListener("abort", () =>
        j(Object.assign(Error(), { code: "CANCELLED" })),
      ),
    );
  });
  const j = jobs.create(binding, config);
  const p = await jobs.prepare(sender, j.id, "p", "hello");
  const req = { jobId: j.id, ...p.batches[0] };
  const a = jobs.run(sender, req),
    b = jobs.run(sender, req);
  await new Promise((r) => setTimeout(r, 5));
  jobs.cancel(j.id);
  await Promise.allSettled([a, b]);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});
test("all tabs share two in-flight slots", async () => {
  let active = 0,
    max = 0;
  const jobs = make(async (xs) => {
    max = Math.max(max, ++active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return xs.map((x) => ({ ...x, text: "translated" }));
  });
  const j = jobs.create(binding, config);
  const ps = await Promise.all(
    [1, 2, 3].map((n) => jobs.prepare(sender, j.id, "p" + n, "text " + n)),
  );
  await Promise.all(
    ps.flatMap((p) =>
      p.batches.map((b) => jobs.run(sender, { jobId: j.id, ...b })),
    ),
  );
  assert.equal(max, 2);
});
test("fatal authentication cancels job; unknown epoch never replays", async () => {
  const jobs = make(async () => {
    throw Object.assign(Error(), { code: "AUTH_FAILED" });
  });
  const j = jobs.create(binding, config);
  const p = await jobs.prepare(sender, j.id, "p", "hello");
  await assert.rejects(jobs.run(sender, { jobId: j.id, ...p.batches[0] }), {
    code: "AUTH_FAILED",
  });
  await assert.rejects(jobs.prepare(sender, j.id, "p2", "hello"), {
    code: "CANCELLED",
  });
  await assert.rejects(make().prepare(sender, j.id, "p", "hi"), {
    code: "INTERRUPTED",
  });
});
test("cache hit avoids reservation and network; cache failure is observable", async () => {
  let calls = 0;
  const cache = new Cache();
  const jobs = new Jobs({
    cache,
    diagnostics: new Diagnostics(),
    translate: async (xs) => {
      calls++;
      return xs.map((x) => ({ id: x.id, text: "hello translation" }));
    },
  });
  const j = jobs.create(binding, config);
  const p = await jobs.prepare(sender, j.id, "p", "hello");
  await jobs.run(sender, { jobId: j.id, ...p.batches[0] });
  const hit = await jobs.prepare(sender, j.id, "p2", "hello");
  assert.equal(hit.cached.length, 1);
  assert.equal(hit.batches.length, 0);
  assert.equal(calls, 1);
  assert.equal(j.budget.total, 1);
});
test("persistent cache partitions protocol, expires, and diagnostics use whitelist", async () => {
  let now = 1;
  const store = new Map();
  const cache = new Cache({
    clock: () => now,
    store: {
      get: async (k) => store.get(k),
      putMany: async (rows) => {
        for (const [key, value] of rows) store.set(key, structuredClone(value));
      },
      prune: async () => {},
      clear: async () => store.clear(),
    },
  });
  await cache.put("hello", "你好", { ...config, cacheEnabled: true });
  assert.equal(
    await cache.get("hello", { ...config, model: "other", cacheEnabled: true }),
    null,
  );
  now += 31 * 86400000;
  assert.equal(
    await cache.get("hello", { ...config, cacheEnabled: true }),
    null,
  );
  const d = new Diagnostics();
  for (let i = 0; i < 101; i++)
    d.record({
      code: "E",
      secret: "secret",
      url: "https://x/?key=secret",
      text: "private",
    });
  assert.equal(d.export().length, 100);
  assert.equal(JSON.stringify(d.export()).includes("secret"), false);
});
