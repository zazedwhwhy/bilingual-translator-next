import { test } from "node:test";
import assert from "node:assert/strict";
const policy = await import("../src/shared/auto.js").catch(() => null),
  module = await import("../src/background/auto.js").catch(() => null);
const sample =
    "This public article explains a scientific observation in clear English. ".repeat(
      4,
    ),
  message = { url: "https://example.org/article", declared: "en", sample },
  sender = {
    id: "extension",
    tab: { id: 1 },
    frameId: 0,
    documentId: "document-one",
    url: message.url,
  };
function setup({
  allowed = true,
  saved = false,
  saveFails = false,
  detector,
  configured = true,
} = {}) {
  const scripts = new Map();
  let stored = { autoTranslation: { enabled: saved } },
    hasKey = configured;
  const api = {
    runtime: { id: "extension" },
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async (value) => {
          if (saveFails) throw Error("STORAGE_FAILED");
          stored = { ...stored, ...value };
        },
      },
    },
    permissions: { contains: async () => allowed },
    scripting: {
      getRegisteredContentScripts: async () => [...scripts.values()],
      registerContentScripts: async (rows) => {
        for (const row of rows) scripts.set(row.id, row);
      },
      unregisterContentScripts: async ({ ids }) => {
        for (const id of ids) scripts.delete(id);
      },
    },
    i18n: {
      detectLanguage:
        detector ||
        (async () => ({
          isReliable: true,
          languages: [{ language: "en", percentage: 100 }],
        })),
    },
  };
  api.tabs = { sendMessage: async () => ({ ok: true }) };
  const controller = new module.AutoTranslation(api, {
    settings: { public: async () => ({ hasKey, target: "zh-CN" }) },
    start: async (tabId, context) => ({
      jobId: "automatic",
      documentId: context.documentId,
    }),
    cancel: async () => {},
  });
  return { controller, scripts, configure: () => (hasKey = true) };
}
test("automatic language policy skips target content and uncertainty without a paid detector", () => {
  assert.ok(policy, "local language policy required");
  assert.equal(
    policy.foreignLanguage({
      declared: "en",
      sample,
      target: "zh-CN",
      detected: {
        isReliable: true,
        languages: [{ language: "en", percentage: 100 }],
      },
    }),
    "en",
  );
  assert.equal(
    policy.foreignLanguage({
      declared: "en",
      sample,
      target: "zh-CN",
      detected: {
        isReliable: true,
        languages: [{ language: "zh", percentage: 99 }],
      },
    }),
    null,
  );
  assert.equal(
    policy.foreignLanguage({
      declared: "zh-TW",
      sample,
      target: "zh-CN",
      detected: {
        isReliable: true,
        languages: [{ language: "zh-TW", percentage: 100 }],
      },
    }),
    null,
  );
  assert.equal(
    policy.foreignLanguage({
      declared: "",
      sample,
      target: "zh-CN",
      detected: {
        isReliable: false,
        languages: [{ language: "und", percentage: 100 }],
      },
    }),
    null,
  );
});
test("auto translation requires explicit enable and website permission", async () => {
  assert.ok(module, "automatic controller required");
  const x = setup({ allowed: false });
  await x.controller.init();
  assert.equal(
    (await x.controller.handleReady(message, sender)).reason,
    "disabled",
  );
  await assert.rejects(x.controller.set(true), { code: "PERMISSION_MISSING" });
  assert.equal(x.controller.state().enabled, false);
  assert.equal(x.scripts.size, 0);
});
test("enabled foreign page starts once; target language and child frames never auto-start", async () => {
  assert.ok(module);
  const x = setup();
  await x.controller.init();
  await x.controller.set(true);
  assert.equal(x.controller.state().ready, true);
  assert.equal((await x.controller.handleReady(message, sender)).started, true);
  assert.equal(
    (await x.controller.handleReady(message, sender)).started,
    false,
  );
  await assert.rejects(
    x.controller.handleReady(message, { ...sender, frameId: 1 }),
    { code: "INVALID_MESSAGE" },
  );
  const zh = setup({
    detector: async () => ({
      isReliable: true,
      languages: [{ language: "zh", percentage: 100 }],
    }),
  });
  await zh.controller.init();
  await zh.controller.set(true);
  assert.equal(
    (await zh.controller.handleReady(message, sender)).reason,
    "target_or_unknown",
  );
});
test("disabling while local detection waits prevents a late automatic start", async () => {
  assert.ok(module);
  let release, entered;
  const pending = new Promise((r) => (entered = r)),
    x = setup({
      detector: async () => {
        entered();
        return new Promise(
          (r) =>
            (release = () =>
              r({
                isReliable: true,
                languages: [{ language: "en", percentage: 100 }],
              })),
        );
      },
    });
  await x.controller.init();
  await x.controller.set(true);
  const ready = x.controller.handleReady(message, sender);
  await pending;
  await x.controller.set(false);
  release();
  assert.equal((await ready).started, false);
  assert.equal(x.controller.state().enabled, false);
  assert.equal(x.scripts.size, 0);
});
test("manual restore suppresses a pending automatic start only for that document and route", async () => {
  assert.ok(module);
  let release, entered;
  const pending = new Promise((r) => (entered = r)),
    x = setup({
      detector: async () => {
        entered();
        return new Promise(
          (r) =>
            (release = () =>
              r({
                isReliable: true,
                languages: [{ language: "en", percentage: 100 }],
              })),
        );
      },
    });
  await x.controller.init();
  await x.controller.set(true);
  const ready = x.controller.handleReady(message, sender);
  await pending;
  x.controller.suppress(1);
  release();
  assert.equal((await ready).started, false);
  const again = x.controller.handleReady(message, {
    ...sender,
    documentId: "new-document",
  });
  await new Promise((r) => setImmediate(r));
  release();
  assert.equal((await again).started, true);
});
test("failed enable save rolls back registration rather than reporting an enabled feature", async () => {
  assert.ok(module);
  const x = setup({ saveFails: true });
  await x.controller.init();
  await assert.rejects(x.controller.set(true));
  assert.equal(x.controller.state().enabled, false);
  assert.equal(x.scripts.size, 0);
});
test("startup after website permission revocation does not register or auto-start", async () => {
  assert.ok(module);
  const x = setup({ saved: true, allowed: false });
  await x.controller.init();
  assert.equal(x.controller.state().ready, false);
  assert.equal(x.scripts.size, 0);
  assert.equal(
    (await x.controller.handleReady(message, sender)).started,
    false,
  );
});
test("same-document SPA URL updates retain the trusted origin while a different origin is rejected", async () => {
  assert.ok(module);
  const x = setup();
  await x.controller.init();
  await x.controller.set(true);
  assert.equal(
    (
      await x.controller.handleReady(
        { ...message, url: "https://example.org/article?next=1" },
        sender,
      )
    ).started,
    true,
  );
  await assert.rejects(
    x.controller.handleReady(
      { ...message, url: "https://unrelated.example/article" },
      sender,
    ),
    { code: "INVALID_MESSAGE" },
  );
});
test("explicitly saving a missing connection permits the skipped document to be checked again", async () => {
  const x = setup({ configured: false });
  await x.controller.init();
  await x.controller.set(true);
  assert.equal(
    (await x.controller.handleReady(message, sender)).reason,
    "configuration",
  );
  x.configure();
  assert.equal(typeof x.controller.configurationChanged, "function");
  await x.controller.configurationChanged();
  assert.equal((await x.controller.handleReady(message, sender)).started, true);
});
test("a page deferred before job creation may start when its tab is activated", async () => {
  const x = setup();
  await x.controller.init();
  await x.controller.set(true);
  let attempts = 0;
  x.controller.start = async () => {
    if (++attempts === 1)
      throw Object.assign(Error(), { code: "AUTO_DEFERRED" });
    return {};
  };
  assert.equal(
    (await x.controller.handleReady(message, sender)).reason,
    "background",
  );
  assert.equal((await x.controller.handleReady(message, sender)).started, true);
});
