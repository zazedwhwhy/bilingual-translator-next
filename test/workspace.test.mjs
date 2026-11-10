import { test } from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../src/background/jobs.js";
import { Cache, Diagnostics } from "../src/background/cache.js";
import { DocumentRunner } from "../src/documents/runner.js";
test("workspace jobs require exact trusted page in addition to tab/document", () => {
  const jobs = new Jobs({
    cache: new Cache(),
    diagnostics: new Diagnostics(),
    translate: async (x) => x,
  });
  const binding = {
    tabId: 2,
    documentId: "workspace",
    frameId: 0,
    kind: "workspace",
    url: "chrome-extension://id/src/ui/workbench.html",
  };
  const j = jobs.create(binding, {});
  assert.throws(
    () =>
      jobs.get(
        {
          tab: { id: 2 },
          documentId: "workspace",
          frameId: 0,
          url: "https://untrusted.test",
        },
        j.id,
      ),
    { code: "INVALID_MESSAGE" },
  );
  assert.equal(
    jobs.get(
      { tab: { id: 2 }, documentId: "workspace", frameId: 0, url: binding.url },
      j.id,
    ).id,
    j.id,
  );
});
test("document runner pauses on budget and never exports fake translations", async () => {
  let round = 1;
  const runner = new DocumentRunner(async (type, data) => {
    if (type === "WB_START") return { id: "job" };
    if (type === "WB_PREPARE")
      return round === 1
        ? { blocked: true, budget: { round } }
        : {
            cached: [{ id: "x", text: "译文" }],
            ids: ["x"],
            batches: [],
            budget: { round },
          };
    if (type === "WB_CONTINUE") {
      round++;
      return { round };
    }
    return {};
  });
  await runner.start({ segments: [{ id: "a", text: "text" }] });
  assert.equal(runner.phase, "paused_budget");
  assert.equal(runner.translations.size, 0);
  await runner.continue();
  assert.equal(runner.translations.get("a"), "译文");
  assert.equal(runner.phase, "complete");
});
test("stopped runner does not accept late results", async () => {
  let finish;
  const runner = new DocumentRunner(async (type) => {
    if (type === "WB_START") return { id: "j" };
    if (type === "WB_PREPARE")
      return {
        ids: ["x"],
        cached: [],
        batches: [{ batchId: "b", items: [{ id: "x", text: "hello" }] }],
      };
    if (type === "WB_BATCH") return new Promise((r) => (finish = r));
    return {};
  });
  const task = runner.start({ segments: [{ id: "a", text: "hello" }] });
  await new Promise((r) => setTimeout(r, 0));
  await runner.stop();
  finish({ translations: [{ id: "x", text: "late" }] });
  await task;
  assert.equal(runner.translations.size, 0);
  assert.equal(runner.phase, "cancelled");
});
