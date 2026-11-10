import { test } from "node:test";
import assert from "node:assert/strict";
import { Settings } from "../src/background/settings.js";
function setup() {
  let data = {};
  const permissions = new Set();
  let deny = false,
    broken = false;
  const api = {
    storage: {
      local: {
        setAccessLevel: async () => {
          if (broken) throw Error("storage");
        },
        get: async () => structuredClone(data),
        set: async (x) => {
          if (broken) throw Error("storage");
          data = { ...data, ...x };
        },
      },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((x) => permissions.has(x)),
    },
  };
  return {
    api,
    permissions,
    s: new Settings(api),
    deny: () => (deny = true),
    broken: () => (broken = true),
  };
}
const cfg = {
  provider: "openai",
  secret: "private-key",
  model: "my-model",
  target: "zh-CN",
  source: "auto",
  cacheEnabled: false,
};
test("credentials require trusted storage and granted origin; public config hides key", async () => {
  const x = setup();
  await x.s.init();
  await assert.rejects(x.s.save(cfg), { code: "PERMISSION_MISSING" });
  x.permissions.add("https://api.openai.com/*");
  const p = await x.s.save(cfg);
  assert.equal(p.hasKey, true);
  assert.equal(JSON.stringify(p).includes("private-key"), false);
  assert.equal((await x.s.snapshot()).secret, "private-key");
});
test("failed configuration preserves previous connection", async () => {
  const x = setup();
  x.permissions.add("https://api.openai.com/*");
  await x.s.init();
  await x.s.save(cfg);
  await assert.rejects(x.s.save({ ...cfg, provider: "claude" }));
  assert.equal((await x.s.snapshot()).provider, "openai");
  await assert.rejects(x.s.save({ ...cfg, model: "" }));
});
test("storage initialization failure blocks saves", async () => {
  const x = setup();
  x.broken();
  await assert.rejects(x.s.init());
  await assert.rejects(x.s.save(cfg));
});
test("clearing key notifies cancellation and retains nonsecret settings", async () => {
  const x = setup();
  x.permissions.add("https://api.openai.com/*");
  await x.s.init();
  await x.s.save(cfg);
  let cancelled;
  await x.s.clearKey("openai", (p) => (cancelled = p));
  assert.equal(cancelled, "openai");
  assert.equal((await x.s.public()).hasKey, false);
});
