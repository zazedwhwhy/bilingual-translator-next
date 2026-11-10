import { test } from "node:test";
import assert from "node:assert/strict";
const module = await import("../src/subtitles/bilibili.js").catch(() => null);
test("Bilibili reports the observed login boundary without claiming subtitles are available", () => {
  assert.ok(module, "Bilibili adapter is required");
  const result = module.bilibiliTrackChoices(
    {
      bvid: "BV1J94y177Nt",
      cid: 1359939486,
      response: {
        code: 0,
        data: { need_login_subtitle: true, subtitle: { subtitles: [] } },
      },
    },
    "https://www.bilibili.com/video/BV1J94y177Nt/",
  );
  assert.equal(result.tracks.length, 0);
  assert.equal(result.reason, "LOGIN_REQUIRED");
});
test("Bilibili cue contract preserves returned from/to boundaries and rejects invalid timing", () => {
  assert.ok(module);
  const cues = module.parseBilibiliCaptions({
    body: [{ from: 1.25, to: 2.5, content: "Controlled caption" }],
  });
  assert.equal(cues[0].start, 1.25);
  assert.equal(cues[0].end, 2.5);
  assert.throws(
    () =>
      module.parseBilibiliCaptions({
        body: [{ from: 1, to: 1, content: "No duration" }],
      }),
    { code: "SUBTITLE_INVALID" },
  );
});
test("Bilibili subtitle fetch is limited to caption CDN paths and current video choices", () => {
  assert.ok(module);
  assert.ok(
    module
      .bilibiliCaptionURL("//i0.hdslb.com/bfs/subtitle/test.json")
      .startsWith("https://"),
  );
  for (const url of [
    "https://evil.test/bfs/subtitle/a.json",
    "https://i0.hdslb.com/not-subtitles/a.json",
    "http://i0.hdslb.com/bfs/subtitle/a.json",
  ])
    assert.throws(() => module.bilibiliCaptionURL(url), {
      code: "SUBTITLE_INVALID",
    });
});

test("missing Bilibili subtitle schema is an error rather than a fake empty list", () => {
  assert.throws(
    () =>
      module.bilibiliTrackChoices(
        {
          bvid: "BV1J94y177Nt",
          cid: 1359939486,
          response: { code: 0, data: {} },
        },
        "https://www.bilibili.com/video/BV1J94y177Nt/",
      ),
    { code: "SUBTITLE_INVALID" },
  );
});

import { platformCaptions } from "../src/background/platforms.js";

test("quick caption read reuses fresh Bilibili metadata only while the active CID still matches", async () => {
  let cid = 10,
    metadataRequests = 0,
    captionRequests = 0;
  const api = {
    tabs: {
      get: async () => ({
        url: "https://www.bilibili.com/video/BV1J94y177Nt/",
      }),
    },
    scripting: {
      executeScript: async (spec) => {
        if (spec.func.name === "syncPageIdentity")
          return [{ result: "bilibili:BV1J94y177Nt:" + cid }];
        if (spec.func.name === "fetchCaptionText") {
          captionRequests++;
          return [
            {
              result: {
                ok: true,
                text: JSON.stringify({
                  body: [
                    { from: 1, to: 2, content: "Existing foreign caption" },
                  ],
                }),
              },
            },
          ];
        }
        metadataRequests++;
        return [
          {
            result: {
              ok: true,
              platform: "bilibili",
              bvid: "BV1J94y177Nt",
              cid,
              response: {
                code: 0,
                data: {
                  need_login_subtitle: false,
                  subtitle: {
                    subtitles: [
                      {
                        id_str: "en",
                        lan: "en",
                        lan_doc: "English",
                        subtitle_url:
                          "https://i0.hdslb.com/bfs/subtitle/test.json",
                      },
                    ],
                  },
                },
              },
            },
          },
        ];
      },
    },
  };
  const adapter = platformCaptions(api, {
      public: async () => ({ source: "auto", target: "zh-CN" }),
    }),
    metadata = await adapter.metadata(1, { fresh: true });
  const read = await adapter.read(1, metadata.tracks[0].id, { metadata });
  assert.equal(read.cues[0].start, 1);
  assert.equal(metadataRequests, 1);
  assert.equal(captionRequests, 1);
  cid = 11;
  await assert.rejects(adapter.read(1, metadata.tracks[0].id, { metadata }), {
    code: "VIDEO_CHANGED",
  });
  assert.equal(captionRequests, 1);
});
import * as platformModule from "../src/background/platforms.js";
import * as identityModule from "../src/subtitles/platform-identity.js";

test("active Bilibili identity follows the public manifest even when the URL and video source stay fixed", () => {
  assert.equal(typeof platformModule.syncPageIdentity, "function");
  const saved = Object.fromEntries(
    [
      "window",
      "location",
      "document",
      "MutationObserver",
      "setInterval",
      "clearInterval",
    ].map((k) => [k, globalThis[k]]),
  );
  const attrs = new Map(),
    observers = [];
  let tick,
    cleared = 0,
    cid = 10;
  const video = {
    isConnected: true,
    getAttribute: (k) => attrs.get(k) || null,
    setAttribute: (k, v) => attrs.set(k, v),
  };
  try {
    globalThis.location = {
      href: "https://www.bilibili.com/video/BV1J94y177Nt/",
    };
    globalThis.window = {
      player: { getManifest: () => ({ bvid: "BV1J94y177Nt", cid }) },
    };
    globalThis.document = { querySelector: () => video };
    globalThis.MutationObserver = class {
      constructor(fn) {
        observers.push(fn);
      }
      observe() {}
    };
    globalThis.setInterval = (fn) => {
      tick = fn;
      return 1;
    };
    globalThis.clearInterval = () => {
      cleared++;
    };
    assert.equal(platformModule.syncPageIdentity(), "bilibili:BV1J94y177Nt:10");
    attrs.set("data-bt-next-watch", "display capture");
    observers[0]();
    cid = 11;
    tick();
    assert.equal(
      attrs.get("data-bt-next-source-id"),
      "bilibili:BV1J94y177Nt:11",
    );
    assert.equal(
      identityModule.sourceIdentity(video, location.href),
      "bilibili:BV1J94y177Nt:11",
    );
    attrs.delete("data-bt-next-watch");
    observers[0]();
    assert.equal(cleared, 1);
    cid = 12;
    assert.equal(platformModule.syncPageIdentity(), "bilibili:BV1J94y177Nt:12");
    assert.equal(observers.length, 1);
    window.player.getManifest = () => ({ bvid: "BVother", cid: 12 });
    assert.equal(platformModule.syncPageIdentity(), "bilibili:unavailable");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
});
test("same-URL Bilibili CID changes invalidate the previously selected subtitle track", async () => {
  let cid = 10;
  const api = {
    tabs: {
      get: async () => ({
        url: "https://www.bilibili.com/video/BV1J94y177Nt/",
      }),
    },
    scripting: {
      executeScript: async (spec) =>
        spec.args
          ? [
              {
                result: {
                  ok: true,
                  text: JSON.stringify({
                    body: [{ from: 0, to: 1, content: "Caption" }],
                  }),
                },
              },
            ]
          : [
              {
                result: {
                  ok: true,
                  platform: "bilibili",
                  bvid: "BV1J94y177Nt",
                  cid,
                  response: {
                    code: 0,
                    data: {
                      need_login_subtitle: false,
                      subtitle: {
                        subtitles: [
                          {
                            id_str: "en",
                            lan: "en",
                            lan_doc: "English",
                            subtitle_url:
                              "https://i0.hdslb.com/bfs/subtitle/test.json",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            ],
    },
  };
  const adapter = platformCaptions(api, {
    public: async () => ({ source: "auto", target: "zh-CN" }),
  });
  const before = await adapter.metadata(1);
  cid = 11;
  await assert.rejects(adapter.read(1, before.tracks[0].id), {
    code: "SUBTITLE_UNAVAILABLE",
  });
});
