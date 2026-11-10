import { test } from "node:test";
import assert from "node:assert/strict";
const module = await import("../src/background/page.js").catch(() => null);
test("stopping during page injection prevents a delayed INIT and job creation", async () => {
  assert.ok(module, "page actions required");
  let release,
    entered,
    created = 0;
  const pending = new Promise((r) => (entered = r)),
    sent = [];
  const pages = module.pageActions(
    {
      tabs: {
        get: async () => ({ url: "https://example.org/" }),
        sendMessage: async (id, msg) => {
          sent.push(msg.type);
          return { ok: true, data: {} };
        },
      },
      runtime: { getURL: (p) => p },
      scripting: {
        executeScript: async () => {
          entered();
          await new Promise((r) => (release = r));
          return [{ documentId: "d" }];
        },
        insertCSS: async () => {},
      },
    },
    {
      settings: { snapshot: async () => ({}), public: async () => ({}) },
      jobs: {
        jobs: new Map(),
        create: () => {
          created++;
          return { id: "j" };
        },
        cancel() {},
      },
    },
  );
  const starting = pages.start(1);
  await pending;
  await pages.control("STOP", 1);
  release();
  await assert.rejects(starting, { code: "CANCELLED" });
  assert.equal(created, 0);
  assert.equal(sent.includes("INIT"), false);
});
test("automatic start rejects a different document before any paid job exists", async () => {
  assert.ok(module);
  let created = 0;
  const pages = module.pageActions(
    {
      tabs: {
        get: async () => ({ url: "https://example.org/" }),
        sendMessage: async () => ({ ok: true, data: {} }),
      },
      runtime: { getURL: (p) => p },
      scripting: {
        executeScript: async () => [{ documentId: "new-document" }],
        insertCSS: async () => {},
      },
    },
    {
      settings: { snapshot: async () => ({}), public: async () => ({}) },
      jobs: {
        jobs: new Map(),
        create: () => {
          created++;
          return { id: "j" };
        },
        cancel() {},
      },
    },
  );
  await assert.rejects(
    pages.start(1, {
      documentId: "old-document",
      url: "https://example.org/",
      isCurrent: () => true,
    }),
    { code: "CANCELLED" },
  );
  assert.equal(created, 0);
});
test("automatic bootstrap failure is visible in popup status before the page session exists", async () => {
  const pages = module.pageActions(
    {
      scripting: {
        executeScript: async () => [
          { result: { loaded: false, autoError: "CONFIG_INVALID" } },
        ],
      },
    },
    { jobs: { jobs: new Map() }, settings: {} },
  );
  const result = await pages.control("STATUS", 1);
  assert.equal(result.phase, "error");
  assert.equal(result.error.code, "CONFIG_INVALID");
});
test("an imported content module without INIT does not hide the automatic startup failure", async () => {
  const pages = module.pageActions(
    {
      scripting: {
        executeScript: async () => [
          { result: { loaded: true, autoError: "CONFIG_INVALID" } },
        ],
      },
      tabs: {
        sendMessage: async () => ({ ok: true, data: { phase: "idle" } }),
      },
    },
    { jobs: { jobs: new Map() }, settings: {} },
  );
  const result = await pages.control("STATUS", 1);
  assert.equal(result.phase, "error");
  assert.equal(result.error.code, "CONFIG_INVALID");
});
