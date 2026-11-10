import { fail } from "../shared/core.js";
import { validateCues } from "../subtitles/cues.js";
import { platformCaptions } from "./platforms.js";
import { preferredCaption } from "../subtitles/selection.js";
export function videoActions(api, { jobs, settings }) {
  const platforms = platformCaptions(api, settings),
    styled = new Map();
  const controls = new Map();
  let transition = 0;
  async function inject(tabId) {
    const tab = await api.tabs.get(tabId);
    if (!/^https?:/.test(tab.url || ""))
      fail("VIDEO_UNAVAILABLE", "请打开有视频的普通网页");
    const [frame] = await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: async (url) => {
        if (!globalThis.__btVideoLoaded) {
          await import(url);
          globalThis.__btVideoLoaded = true;
        }
      },
      args: [api.runtime.getURL("src/content/video.js")],
    });
    if (styled.get(tabId) !== frame.documentId) {
      await api.scripting.insertCSS({
        target: { tabId, frameIds: [0] },
        files: ["src/content/video.css"],
      });
      styled.set(tabId, frame.documentId);
    }
    return { tab, frame };
  }
  async function message(tabId, type, data = {}, documentId) {
    const reply = await api.tabs.sendMessage(
      tabId,
      { channel: "BT_VIDEO", type, ...data },
      documentId ? { documentId } : { frameId: 0 },
    );
    if (!reply?.ok)
      throw Object.assign(
        Error(reply?.error?.message || "视频页面无响应"),
        reply?.error || { code: "INTERRUPTED" },
      );
    return reply.data;
  }
  async function launch(m, frame, token, cues, expectedIdentity, revision) {
    const config = await settings.snapshot(),
      publicSettings = await settings.public();
    if (
      config.configRevision !== publicSettings.configRevision ||
      (revision !== undefined && revision !== config.configRevision)
    )
      fail("CONFIG_INVALID", "字幕读取期间翻译设置已改变，请重试");
    if (expectedIdentity !== (await platforms.identity(m.tabId)))
      fail("VIDEO_CHANGED", "字幕读取期间视频已切换，请重新读取");
    if (controls.get(m.tabId) !== token) fail("CANCELLED", "视频操作已停止");
    const job = jobs.create(
      {
        tabId: m.tabId,
        documentId: frame.documentId,
        frameId: 0,
        kind: "video",
      },
      config,
    );
    try {
      return await message(
        m.tabId,
        "INIT",
        {
          videoId: m.videoId,
          trackId: m.trackId,
          cues,
          expectedIdentity,
          job: { id: job.id, epoch: jobs.epoch, ...publicSettings },
        },
        frame.documentId,
      );
    } catch (error) {
      jobs.cancel(job.id);
      throw error;
    }
  }
  return async (m) => {
    if (m.type === "VIDEO_QUICK") {
      const token = ++transition;
      controls.set(m.tabId, token);
      const { frame } = await inject(m.tabId);
      let expectedIdentity = await platforms.identity(m.tabId);
      if (controls.get(m.tabId) !== token) fail("CANCELLED", "视频操作已停止");
      await message(m.tabId, "STOP", {}, frame.documentId);
      const videos = await message(m.tabId, "DISCOVER", {}, frame.documentId),
        video = videos[0],
        preferences = await settings.public();
      if (!video) fail("VIDEO_UNAVAILABLE", "页面没有可访问的主视频");
      let track = preferredCaption(video, preferences),
        meta;
      if (!track) {
        meta = await platforms.metadata(m.tabId, { fresh: true });
        track = preferredCaption(
          { ...video, tracks: meta.tracks },
          preferences,
        );
      }
      if (!track)
        fail(
          meta?.reason === "LOGIN_REQUIRED"
            ? "SUBTITLE_LOGIN_REQUIRED"
            : "SUBTITLE_UNAVAILABLE",
          meta?.notice ||
            "没有可读取的现成外语字幕，请手动选轨道或导入字幕。不会自动调用语音识别。",
        );
      if (controls.get(m.tabId) !== token)
        fail("CANCELLED", "字幕读取期间已停止");
      let read;
      if (meta) {
        read = await platforms.read(m.tabId, track.id, { metadata: meta });
        expectedIdentity = read.videoIdentity;
      } else
        read = await message(
          m.tabId,
          "READ",
          { videoId: video.id, trackId: track.id },
          frame.documentId,
        );
      validateCues(read.cues);
      if (!read.cues.length) fail("SUBTITLE_EMPTY", "现成字幕内容为空");
      if (controls.get(m.tabId) !== token)
        fail("CANCELLED", "字幕读取期间已停止");
      const state = await launch(
        { tabId: m.tabId, videoId: video.id, trackId: track.id },
        frame,
        token,
        read.cues,
        expectedIdentity,
        preferences.configRevision,
      );
      return {
        ...state,
        sourceTrack: {
          label: track.label || track.language,
          language: track.language,
          automatic: track.automatic === true,
        },
        sourceMode: "existing-captions",
      };
    }
    if (m.type === "VIDEO_APPLY") {
      const token = ++transition;
      controls.set(m.tabId, token);
      await inject(m.tabId);
      const expectedIdentity = await platforms.identity(m.tabId);
      if (controls.get(m.tabId) !== token) fail("CANCELLED", "视频操作已停止");
      if (
        !Array.isArray(m.cues) ||
        !m.cues.length ||
        m.cues.length > 10000 ||
        JSON.stringify(m.cues).length > 5 * 1024 * 1024
      )
        fail("SUBTITLE_INVALID", "字幕为空或过大");
      validateCues(m.cues);
      return message(m.tabId, "APPLY", {
        videoId: m.videoId,
        cues: m.cues,
        expectedIdentity,
      });
    }
    if (m.type === "VIDEO_LIST") {
      await inject(m.tabId);
      await platforms.identity(m.tabId);
      const videos = await message(m.tabId, "DISCOVER"),
        meta = await platforms.metadata(m.tabId, { fresh: true });
      if (videos[0]) {
        videos[0].tracks.push(
          ...meta.tracks.map(({ url, videoIdentity, ...track }) => track),
        );
        videos[0].notice = meta.notice;
        if (meta.platform)
          videos[0].label =
            (meta.platform === "youtube" ? "YouTube" : "B站") + " · 主视频";
      }
      return videos;
    }
    if (m.type === "VIDEO_READ") {
      await inject(m.tabId);
      return String(m.trackId).startsWith("yt:") ||
        String(m.trackId).startsWith("bili:")
        ? platforms.read(m.tabId, m.trackId)
        : message(m.tabId, "READ", { videoId: m.videoId, trackId: m.trackId });
    }
    if (m.type === "VIDEO_START") {
      const token = ++transition;
      controls.set(m.tabId, token);
      const { frame } = await inject(m.tabId);
      let expectedIdentity = await platforms.identity(m.tabId);
      if (controls.get(m.tabId) !== token) fail("CANCELLED", "视频操作已停止");
      await message(m.tabId, "STOP");
      let cues = m.cues;
      if (cues) {
        if (
          cues.length > 10000 ||
          JSON.stringify(cues).length > 5 * 1024 * 1024
        )
          fail("SUBTITLE_INVALID", "字幕过大");
        validateCues(cues);
      }
      if (
        !cues &&
        (String(m.trackId).startsWith("yt:") ||
          String(m.trackId).startsWith("bili:"))
      ) {
        const read = await platforms.read(m.tabId, m.trackId);
        cues = read.cues;
        expectedIdentity = read.videoIdentity;
      }
      if (controls.get(m.tabId) !== token)
        fail("CANCELLED", "字幕读取期间已停止");
      return launch(m, frame, token, cues, expectedIdentity);
    }
    if (
      [
        "VIDEO_STATUS",
        "VIDEO_STOP",
        "VIDEO_CONTINUE",
        "VIDEO_RETRY",
        "VIDEO_EXPORT",
      ].includes(m.type)
    ) {
      if (m.type === "VIDEO_STOP") controls.set(m.tabId, ++transition);
      return message(m.tabId, m.type.slice(6));
    }
    fail("INVALID_MESSAGE", "未知视频操作");
  };
}
