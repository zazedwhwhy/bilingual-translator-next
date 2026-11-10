import test from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../src/background/jobs.js";
import { Cache, Diagnostics } from "../src/background/cache.js";
import { Budget } from "../src/shared/core.js";
const module = await import("../src/background/interactions.js").catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return {};
  },
);
const sender = {
  id: "extension",
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  url: "https://example.org/read",
};
function setup({ translate, snapshot, session = new Map() } = {}) {
  assert.equal(
    typeof module.InteractionActions,
    "function",
    "interaction translation entry is implemented",
  );
  const requests = [],
    preferences = {
      selection: true,
      hover: true,
      input: true,
      inputTarget: "en",
    };
  const config = {
    provider: "openai",
    model: "test",
    source: "auto",
    target: "zh-CN",
    secret: "test-key",
    configRevision: "r1",
  };
  const api = {
    runtime: { id: "extension" },
    permissions: { contains: async () => true },
    tabs: { get: async () => ({ url: sender.url, active: true }) },
    scripting: {
      executeScript: async () => [
        { documentId: sender.documentId, result: sender.url },
      ],
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: session.get(key) }),
        set: async (rows) => {
          for (const [key, value] of Object.entries(rows))
            session.set(key, structuredClone(value));
        },
        remove: async (key) => session.delete(key),
      },
    },
  };
  const jobs = new Jobs({
    cache: new Cache(),
    diagnostics: new Diagnostics(),
    translate: async (items, c, signal) => {
      requests.push({ items, target: c.target });
      return translate
        ? translate(items, c, signal)
        : items.map((x) => ({ id: x.id, text: "译:" + x.text }));
    },
  });
  const actions = new module.InteractionActions(api, {
    jobs,
    settings: { snapshot: snapshot || (async () => config) },
    preferences: { state: () => preferences },
  });
  return { actions, jobs, requests, preferences, session };
}
const request = (id, text = "A useful phrase", mode = "selection") => ({
  type: "INTERACTION_TRANSLATE",
  requestId: id,
  text,
  mode,
  url: sender.url,
});
test("interactive translation uses real shared Jobs and warm cache adds no request or budget", async () => {
  const x = setup();
  const first = await x.actions.handle(request("first"), sender);
  assert.equal(first.translation, "译:A useful phrase");
  assert.equal(first.budget.codePointsUsed, 15);
  const warm = await x.actions.handle(request("warm"), sender);
  assert.equal(warm.translation, first.translation);
  assert.equal(warm.cached, true);
  assert.equal(x.requests.length, 1);
  assert.equal(warm.budget.codePointsUsed, 15);
});
test("input target is separate from reading target and disabled modes cannot dispatch", async () => {
  const x = setup();
  await x.actions.handle(request("input", "你好", "input"), sender);
  assert.equal(x.requests[0].target, "en");
  x.preferences.hover = false;
  await assert.rejects(
    x.actions.handle(request("hover", "Hello", "hover"), sender),
    { code: "INTERACTION_DISABLED" },
  );
  assert.equal(x.requests.length, 1);
});
test("subframes and mismatched page identity are rejected before dispatch", async () => {
  const x = setup();
  await assert.rejects(
    x.actions.handle(request("bad-frame"), { ...sender, frameId: 1 }),
    { code: "INVALID_MESSAGE" },
  );
  await assert.rejects(
    x.actions.handle(
      { ...request("bad-page"), url: "https://other.example/" },
      sender,
    ),
    { code: "INVALID_MESSAGE" },
  );
  assert.equal(x.requests.length, 0);
});
test("cancel during configuration lookup cannot create a late paid request", async () => {
  let release, entered;
  const ready = new Promise((resolve) => (entered = resolve));
  const x = setup({
    snapshot: async () => {
      entered();
      return new Promise(
        (resolve) => (release = () => resolve({ configRevision: "r1" })),
      );
    },
  });
  const pending = x.actions.handle(request("cancel-lookup"), sender);
  await ready;
  await x.actions.handle(
    { type: "INTERACTION_CANCEL", requestId: "cancel-lookup" },
    sender,
  );
  release();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(x.requests.length, 0);
});
test("new selection cancels old result and an old cancel cannot stop the new selection", async () => {
  let release, entered;
  const ready = new Promise((resolve) => (entered = resolve));
  const x = setup({
    translate: async (items) => {
      if (items[0].text === "slow") {
        entered();
        await new Promise((resolve) => (release = resolve));
      }
      return items.map((item) => ({ id: item.id, text: "译:" + item.text }));
    },
  });
  const old = x.actions.handle(request("old", "slow"), sender);
  const oldResult = assert.rejects(old, { code: "CANCELLED" });
  await ready;
  const fresh = x.actions.handle(request("new", "fresh"), sender);
  await x.actions.handle(
    { type: "INTERACTION_CANCEL", requestId: "old" },
    sender,
  );
  assert.equal((await fresh).translation, "译:fresh");
  release();
  await oldResult;
  assert.ok(x.jobs.active <= 2);
});
test("document budget persists across background recreation and cache misses stop at the limit", async () => {
  const x = setup();
  for (let i = 0; i < 10; i++)
    await x.actions.handle(
      request("round-" + i, String.fromCharCode(65 + i).repeat(6000)),
      sender,
    );
  assert.equal(x.requests.length, 30);
  const next = setup({ session: x.session });
  await assert.rejects(
    next.actions.handle(request("blocked", "new expense"), sender),
    { code: "BUDGET_EXCEEDED" },
  );
  assert.equal(next.requests.length, 0);
  await next.actions.handle({ type: "INTERACTION_CONTINUE" }, sender);
  assert.equal(
    (await next.actions.handle(request("continued", "new expense"), sender))
      .budget.round,
    2,
  );
  assert.equal(next.requests.length, 1);
});
test("ledger write failure blocks the provider instead of pretending the budget was saved", async () => {
  const x = setup();
  x.actions.api.storage.session.set = async () => {
    throw new Error("session unavailable");
  };
  await assert.rejects(
    x.actions.handle(request("storage"), sender),
    /session unavailable/,
  );
  assert.equal(x.requests.length, 0);
});
test("late cleanup of an old interaction cannot clear the next interaction shared budget reservation", async () => {
  const jobs = new Jobs({
    cache: new Cache(),
    diagnostics: new Diagnostics(),
    translate: async (items) =>
      items.map((item) => ({ id: item.id, text: "translated" })),
  });
  const config = {
      provider: "openai",
      model: "test",
      source: "auto",
      target: "zh-CN",
    },
    budget = new Budget();
  const binding = {
    tabId: 7,
    documentId: sender.documentId,
    frameId: 0,
    kind: "interaction",
  };
  const old = jobs.create(binding, config, budget);
  await jobs.prepare(sender, old.id, "old-paragraph", "old");
  const current = jobs.create(binding, config, budget);
  const prepared = await jobs.prepare(
    sender,
    current.id,
    "new-paragraph",
    "fresh",
  );
  jobs.cancel(old.id); // An aborted network handler reaches its finally later.
  const batch = prepared.batches[0];
  const result = await jobs.run(sender, {
    jobId: current.id,
    batchId: batch.batchId,
    items: batch.items,
  });
  assert.equal(result.translations[0].text, "translated");
});
test("cancelling while the permission check waits prevents late dispatch", async () => {
  let release, entered;
  const ready = new Promise((resolve) => (entered = resolve)),
    x = setup();
  x.actions.api.permissions.contains = async () => {
    entered();
    return new Promise((resolve) => (release = () => resolve(true)));
  };
  const pending = x.actions.handle(request("permission-wait"), sender);
  await ready;
  await x.actions.handle(
    { type: "INTERACTION_CANCEL", requestId: "permission-wait" },
    sender,
  );
  release();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(x.requests.length, 0);
});
test("applying an input preview rechecks the current configuration without calling the provider", async () => {
  const x = setup();
  await assert.rejects(
    x.actions.handle(
      {
        type: "INTERACTION_VALIDATE",
        configRevision: "old",
        target: "en",
        url: sender.url,
      },
      sender,
    ),
    { code: "CONFIG_INVALID" },
  );
  await x.actions.handle(
    {
      type: "INTERACTION_VALIDATE",
      configRevision: "r1",
      target: "en",
      url: sender.url,
    },
    sender,
  );
  assert.equal(x.requests.length, 0);
});
