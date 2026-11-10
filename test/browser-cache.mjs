import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  source = process.env.BT_CACHE_SOURCE || root,
  baseline = process.argv.includes("--baseline");
const output =
  process.env.BT_OUTPUT || path.resolve(root, "../../.tmp/bt-031-native-cache");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<title>Native cache transaction probe</title><p>Local IndexedDB and simulated translation only.</p>",
    );
    return;
  }
  const target = path.resolve(
    source,
    "src",
    "." + new URL(req.url, "http://127.0.0.1").pathname,
  );
  if (!target.startsWith(path.resolve(source, "src") + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.setHeader("Content-Type", "text/javascript");
    res.end(await fs.readFile(target));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(8788, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8788/");
  const result = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("bt-next-cache", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("translations");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("translations", "readwrite");
        tx.objectStore("translations").put(
          { text: "legacy preserved", at: Date.now(), used: 0 },
          "legacy-key",
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    const { Cache, Diagnostics, indexedStore } = await import(
        "/background/cache.js"
      ),
      { Jobs } = await import("/background/jobs.js");
    const disk = indexedStore();
    const legacy = await disk.get("legacy-key");
    const transaction = IDBDatabase.prototype.transaction;
    globalThis.writeTransactions = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === "readwrite") globalThis.writeTransactions++;
      return transaction.apply(this, args);
    };
    const cache = new Cache({ store: disk }),
      jobs = new Jobs({
        cache,
        diagnostics: new Diagnostics(),
        translate: async (items) =>
          items.map((item) => ({ id: item.id, text: "译:" + item.text })),
      });
    const config = {
      provider: "openai",
      model: "native-test",
      source: "auto",
      target: "zh-CN",
      cacheEnabled: true,
    };
    const sender = { tab: { id: 1 }, documentId: "doc", frameId: 0 },
      job = jobs.create({ tabId: 1, documentId: "doc", frameId: 0 }, config);
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: "s" + index,
      text: "Source " + index,
    }));
    const plan = await jobs.prepareItems(sender, job.id, "screen", items);
    globalThis.writeTransactions = 0;
    const start = performance.now(),
      translated = await jobs.run(sender, {
        jobId: job.id,
        ...plan.batches[0],
      });
    const elapsed = performance.now() - start,
      writes = globalThis.writeTransactions;
    const before = globalThis.writeTransactions,
      hot = await cache.get("Source 0", config),
      hotImmediateWrites = globalThis.writeTransactions - before;
    await cache.clear();
    return {
      legacyPreserved: legacy.text === "legacy preserved",
      translated: translated.translations.map((row) => row.text),
      resultWriteTransactions: writes,
      hot,
      hotImmediateWrites,
      jobsToResultMs: Math.round(elapsed * 100) / 100,
    };
  });
  assert.equal(result.legacyPreserved, true);
  assert.equal(result.translated.length, 8);
  assert.equal(result.translated[7], "译:Source 7");
  assert.equal(result.resultWriteTransactions, baseline ? 16 : 2);
  assert.equal(result.hot, "译:Source 0");
  assert.equal(result.hotImmediateWrites, baseline ? 1 : 0);
  const report = {
    mode: baseline ? "0.3.0 baseline" : "optimized",
    method:
      "Real native IndexedDB in isolated Chrome; no provider request; single local run",
    ...result,
    browser: browser.version(),
  };
  await fs.writeFile(
    path.join(output, "cache-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
