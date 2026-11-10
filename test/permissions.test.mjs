import { test } from "node:test";
import assert from "node:assert/strict";
import { saveWithPermission } from "../src/ui/permission-save.js";
test("failed save releases only newly granted unused origin", async () => {
  let removed = [];
  await assert.rejects(
    saveWithPermission({
      granted: Promise.resolve(true),
      origin: "https://api.openai.com/*",
      alreadyGranted: false,
      save: async () => {
        throw Error("storage write");
      },
      isUsed: async () => false,
      remove: async (o) => {
        removed.push(o);
        return true;
      },
    }),
  );
  assert.deepEqual(removed, ["https://api.openai.com/*"]);
});
test("existing or concurrently used permission is never revoked", async () => {
  for (const [alreadyGranted, used] of [
    [true, false],
    [false, true],
  ]) {
    let removed = false;
    await assert.rejects(
      saveWithPermission({
        granted: Promise.resolve(true),
        origin: "https://api.openai.com/*",
        alreadyGranted,
        save: async () => {
          throw Error("write");
        },
        isUsed: async () => used,
        remove: async () => (removed = true),
      }),
    );
    assert.equal(removed, false);
  }
});
test("permission denial never attempts to save configuration", async () => {
  let saved = false;
  await assert.rejects(
    saveWithPermission({
      granted: Promise.resolve(false),
      save: async () => (saved = true),
    }),
    { code: "PERMISSION_MISSING" },
  );
  assert.equal(saved, false);
});
