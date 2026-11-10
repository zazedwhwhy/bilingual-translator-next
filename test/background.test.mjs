import { test } from "node:test";
import assert from "node:assert/strict";
test("state read failure remains an error; only explicit uninitialized page is idle", async () => {
  let listener,
    initialized = true;
  globalThis.chrome = {
    runtime: {
      id: "test",
      getURL: (p) => "chrome-extension://test/" + p,
      onMessage: { addListener: (fn) => (listener = fn) },
      onConnect: { addListener: () => {} },
    },
    storage: {
      local: { setAccessLevel: async () => {}, get: async () => ({}) },
    },
    permissions: { onRemoved: { addListener: () => {} } },
    tabs: {
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      sendMessage: async () => {
        throw Object.assign(Error("page disconnected"), {
          code: "INTERRUPTED",
        });
      },
    },
    scripting: {
      executeScript: async () => [{ result: { loaded: initialized } }],
      getRegisteredContentScripts: async () => [],
    },
  };
  await import("../src/background.js?status-test");
  const query = () =>
    new Promise((resolve) =>
      listener(
        { channel: "BT_BG", type: "STATUS", tabId: 1 },
        { id: "test", url: "chrome-extension://test/src/ui/popup.html" },
        resolve,
      ),
    );
  let result = await query();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERRUPTED");
  initialized = false;
  result = await query();
  assert.equal(result.ok, true);
  assert.equal(result.data.phase, "idle");
  delete globalThis.chrome;
});
