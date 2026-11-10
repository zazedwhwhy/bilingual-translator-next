import test from "node:test";
import assert from "node:assert/strict";
import { Cache, Diagnostics } from "../src/background/cache.js";
import { Jobs } from "../src/background/jobs.js";
const config = {
  provider: "openai",
  model: "test",
  source: "auto",
  target: "zh-CN",
  cacheEnabled: true,
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
function store() {
  const rows = new Map();
  const calls = { writes: 0, prunes: 0 };
  return {
    rows,
    calls,
    get: async (key) =>
      rows.has(key) ? structuredClone(rows.get(key)) : undefined,
    put: async (key, value) => {
      calls.writes++;
      rows.set(key, structuredClone(value));
    },
    putMany: async (entries) => {
      calls.writes++;
      for (const [key, value] of entries) rows.set(key, structuredClone(value));
    },
    prune: async () => {
      calls.prunes++;
    },
    clear: async () => rows.clear(),
  };
}
test("one real Jobs result batch persists all eight translations with one write and one maintenance pass", async () => {
  const disk = store(),
    cache = new Cache({ store: disk });
  const jobs = new Jobs({
    cache,
    diagnostics: new Diagnostics(),
    translate: async (items) =>
      items.map((item) => ({ id: item.id, text: "译:" + item.text })),
  });
  const binding = { tabId: 1, documentId: "doc", frameId: 0 },
    sender = { tab: { id: 1 }, documentId: "doc", frameId: 0 };
  const job = jobs.create(binding, config),
    items = Array.from({ length: 8 }, (_, i) => ({
      id: "s" + i,
      text: "Source " + i,
    }));
  const prepared = await jobs.prepareItems(sender, job.id, "screen", items);
  const result = await jobs.run(sender, {
    jobId: job.id,
    ...prepared.batches[0],
  });
  assert.equal(result.translations.length, 8);
  assert.equal(disk.rows.size, 8);
  assert.equal(disk.calls.writes, 1);
  assert.equal(disk.calls.prunes, 1);
});
test("a hot cache hit returns before a blocked optional persistent touch", async () => {
  const disk = store(),
    cache = new Cache({ store: disk });
  await cache.put("Hello", "你好", config);
  let entered, release;
  const writerEntered = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const blocked = async () => {
    entered("writer");
    await gate;
  };
  disk.put = blocked;
  disk.putMany = blocked;
  const hit = cache.get("Hello", config);
  const winner = await Promise.race([hit.then(() => "hit"), writerEntered]);
  release();
  await hit;
  await cache.clear();
  assert.equal(winner, "hit");
});
test("clearing while a persistent lookup waits cannot repopulate memory with the old record", async () => {
  const disk = store(),
    cache = new Cache({ store: disk });
  let entered, release;
  const reading = new Promise((resolve) => (entered = resolve));
  disk.get = async () => {
    entered();
    await new Promise((resolve) => (release = resolve));
    return { text: "old value", at: Date.now(), used: Date.now() };
  };
  const pending = cache.get("Old source", config);
  await reading;
  await cache.clear();
  release();
  assert.equal(await pending, null);
  assert.equal(cache.memory.size, 0);
});
test("repeated hot hits coalesce access-time writes without replacing a newer translation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const disk = store(),
    cache = new Cache({ store: disk });
  await cache.put("Hello", "old", config);
  disk.calls.writes = 0;
  disk.calls.prunes = 0;
  for (let i = 0; i < 8; i++)
    assert.equal(await cache.get("Hello", config), "old");
  assert.equal(disk.calls.writes, 0);
  t.mock.timers.tick(32);
  for (let i = 0; i < 20 && disk.calls.writes === 0; i++) await turn();
  assert.equal(disk.calls.writes, 1);
  await cache.put("Hello", "new", config);
  t.mock.timers.tick(100);
  assert.deepEqual(
    [...disk.rows.values()].map((row) => row.text),
    ["new"],
  );
  await cache.clear();
  assert.equal(disk.rows.size, 0);
});
test("clear waits for an already running cache write and old data cannot return after clear resolves", async () => {
  const disk = store(),
    cache = new Cache({ store: disk });
  let entered, release;
  const writing = new Promise((resolve) => (entered = resolve)),
    original = disk.putMany;
  const blocked = async (entries) => {
    entered();
    await new Promise((resolve) => (release = resolve));
    await original(entries);
  };
  disk.putMany = blocked;
  disk.put = async (key, value) => blocked([[key, value]]);
  const put = cache.put("Old source", "Old translation", config);
  await writing;
  const clear = cache.clear();
  await turn();
  release();
  await Promise.all([put, clear]);
  assert.equal(disk.rows.size, 0);
  assert.equal(cache.memory.size, 0);
});
test("cancelling while a result waits for cache persistence never reports the old job as complete", async () => {
  const disk = store();
  let entered, release;
  const writing = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  disk.put = disk.putMany = async () => {
    entered();
    await gate;
  };
  const jobs = new Jobs({
    cache: new Cache({ store: disk }),
    diagnostics: new Diagnostics(),
    translate: async (items) =>
      items.map((item) => ({ id: item.id, text: "translated" })),
  });
  const sender = { tab: { id: 1 }, documentId: "doc", frameId: 0 };
  const job = jobs.create({ tabId: 1, documentId: "doc", frameId: 0 }, config),
    plan = await jobs.prepare(sender, job.id, "p", "source");
  const pending = jobs.run(sender, { jobId: job.id, ...plan.batches[0] });
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  await writing;
  jobs.cancel(job.id);
  release();
  await rejected;
});
test("invalid persistent records are observable misses and never become fake cached translations", async () => {
  const now = Date.now();
  for (const invalid of [
    { text: 42, at: now, used: now },
    { text: "", at: now, used: now },
    { text: "bad date", at: NaN, used: now },
    { text: "bad access", at: now, used: undefined },
  ]) {
    let warnings = 0;
    const disk = store();
    disk.get = async () => invalid;
    const cache = new Cache({ store: disk, onDegrade: () => warnings++ });
    assert.equal(await cache.get("source", config), null);
    assert.equal(warnings, 1);
    assert.equal(cache.memory.size, 0);
  }
});
