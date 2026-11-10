import { test } from "node:test";
import assert from "node:assert/strict";
import { videoActions } from "../src/background/video.js";
const cue = {
  id: "native",
  start: 1,
  end: 2,
  text: "Existing English subtitle",
};
function setup(tracks, { read = async () => ({ cues: [cue] }) } = {}) {
  let created = 0;
  const sent = [];
  const handle = videoActions(
    {
      runtime: { getURL: (p) => p },
      tabs: {
        get: async () => ({ url: "https://example.org/video" }),
        sendMessage: async (tab, msg) => {
          sent.push(msg);
          if (msg.type === "DISCOVER")
            return { ok: true, data: [{ id: "video1", tracks }] };
          if (msg.type === "READ") return { ok: true, data: await read() };
          return { ok: true, data: { phase: "translating" } };
        },
      },
      scripting: {
        executeScript: async () => [{ documentId: "d" }],
        insertCSS: async () => {},
      },
    },
    {
      settings: {
        public: async () => ({ source: "auto", target: "zh-CN" }),
        snapshot: async () => ({ source: "auto", target: "zh-CN" }),
      },
      jobs: {
        create: () => {
          created++;
          return { id: "j" };
        },
        cancel() {},
      },
    },
  );
  return { handle, sent, created: () => created };
}
test("one-click video path reads existing foreign cues before creating a text translation job", async () => {
  const x = setup([
    { id: "0", language: "zh-CN" },
    { id: "1", language: "en" },
  ]);
  const result = await x.handle({ type: "VIDEO_QUICK", tabId: 1 });
  assert.equal(result.phase, "translating");
  assert.equal(x.sent.find((m) => m.type === "READ").trackId, "1");
  assert.deepEqual(x.sent.find((m) => m.type === "INIT").cues, [cue]);
  assert.equal(x.created(), 1);
  assert.ok(x.sent.every((m) => !m.type.startsWith("ASR_")));
});
test("missing foreign captions fail explicitly without creating any translation or ASR job", async () => {
  const x = setup([{ id: "0", language: "zh-CN" }]);
  await assert.rejects(x.handle({ type: "VIDEO_QUICK", tabId: 1 }), {
    code: "SUBTITLE_UNAVAILABLE",
  });
  assert.equal(x.created(), 0);
  assert.equal(
    x.sent.some((m) => m.type === "INIT"),
    false,
  );
});
test("stop while existing caption text is being read prevents any late text job", async () => {
  let release, entered;
  const pending = new Promise((r) => (entered = r)),
    x = setup([{ id: "0", language: "en" }], {
      read: async () => {
        entered();
        return new Promise((r) => (release = () => r({ cues: [cue] })));
      },
    });
  const starting = x.handle({ type: "VIDEO_QUICK", tabId: 1 });
  await pending;
  await x.handle({ type: "VIDEO_STOP", tabId: 1 });
  release();
  await assert.rejects(starting, { code: "CANCELLED" });
  assert.equal(x.created(), 0);
  assert.equal(
    x.sent.some((m) => m.type === "INIT"),
    false,
  );
});
test("empty existing captions are not replaced with a fabricated or ASR result", async () => {
  const x = setup([{ id: "0", language: "en" }], {
    read: async () => ({ cues: [] }),
  });
  await assert.rejects(x.handle({ type: "VIDEO_QUICK", tabId: 1 }), {
    code: "SUBTITLE_EMPTY",
  });
  assert.equal(x.created(), 0);
});
