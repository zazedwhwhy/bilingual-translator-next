import test from "node:test";
import assert from "node:assert/strict";
const mod = await import("../src/background/interaction-settings.js").catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return {};
  },
);
function setup() {
  assert.equal(
    typeof mod.InteractionSettings,
    "function",
    "independent interaction preferences exist",
  );
  let permission = true,
    stored,
    scripts = [],
    cancels = 0;
  const api = {
    permissions: { contains: async () => permission },
    storage: {
      local: {
        get: async () => ({ quickTranslation: stored }),
        set: async (row) => {
          stored = row.quickTranslation;
        },
      },
    },
    scripting: {
      getRegisteredContentScripts: async () => scripts,
      registerContentScripts: async (rows) => {
        scripts = rows;
      },
      unregisterContentScripts: async () => {
        scripts = [];
      },
      executeScript: async () => [],
    },
    tabs: { query: async () => [], sendMessage: async () => ({ ok: true }) },
  };
  const settings = new mod.InteractionSettings(api, {
    cancel: () => {
      cancels++;
    },
  });
  return {
    settings,
    permission: (value) => (permission = value),
    scripts: () => scripts,
    cancels: () => cancels,
  };
}
test("all quick entry points start off and enabling selection registers independently of page automatic translation", async () => {
  const x = setup();
  await x.settings.init();
  assert.equal(x.settings.state().selection, false);
  assert.equal(x.settings.state().hover, false);
  assert.equal(x.settings.state().input, false);
  await x.settings.set({ selection: true });
  assert.equal(x.scripts().length, 1);
  assert.equal(x.settings.state().hover, false);
  await x.settings.set({ hover: true });
  await x.settings.set({ selection: false });
  assert.equal(x.scripts().length, 1);
  assert.equal(x.settings.state().hover, true);
  await x.settings.set({ hover: false });
  assert.equal(x.scripts().length, 0);
  assert.ok(x.cancels() >= 1);
});
test("denied permission and invalid language cannot create an enabled entry", async () => {
  const x = setup();
  await x.settings.init();
  x.permission(false);
  await assert.rejects(x.settings.set({ input: true }), {
    code: "PERMISSION_MISSING",
  });
  assert.equal(x.settings.state().input, false);
  await assert.rejects(x.settings.set({ inputTarget: "made-up-language" }), {
    code: "CONFIG_INVALID",
  });
  assert.equal(x.scripts().length, 0);
});
