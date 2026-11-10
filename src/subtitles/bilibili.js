import { fail } from "../shared/core.js";
import { validateCues } from "./cues.js";
export function bilibiliCaptionURL(value) {
  let url;
  try {
    url = new URL(value, "https://www.bilibili.com");
  } catch {
    fail("SUBTITLE_INVALID", "B站字幕地址无效");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/(^|\.)hdslb\.com$/.test(url.hostname) ||
    !/^\/bfs\/(?:subtitle|ai_subtitle)\//.test(url.pathname)
  )
    fail("SUBTITLE_INVALID", "仅允许B站字幕资源地址");
  return url.href;
}
export function bilibiliTrackChoices(metadata, pageURL) {
  const page = new URL(pageURL),
    bvid = page.pathname.match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1];
  if (
    !/(^|\.)bilibili\.com$/.test(page.hostname) ||
    !bvid ||
    metadata.bvid !== bvid ||
    !Number.isSafeInteger(metadata.cid)
  )
    fail("VIDEO_CHANGED", "B站视频或分P已改变，请重新读取字幕");
  const response = metadata.response;
  if (response?.code !== 0)
    fail(
      "SUBTITLE_UNAVAILABLE",
      "B站暂未提供当前视频字幕，请在站内检查后重新读取",
    );
  if (response.data?.need_login_subtitle)
    return {
      tracks: [],
      reason: "LOGIN_REQUIRED",
      notice: "这个视频的CC字幕需要先在B站登录。也可以导入已有SRT/VTT字幕。",
    };
  const rows = response.data?.subtitle?.subtitles;
  if (!Array.isArray(rows))
    fail("SUBTITLE_INVALID", "B站字幕信息结构不完整，请在原播放器检查");
  return {
    tracks: rows
      .slice(0, 100)
      .map((t, index) => ({
        id:
          "bili:" +
          bvid +
          ":" +
          metadata.cid +
          ":" +
          encodeURIComponent(t.id_str || t.lan || String(index)),
        language: t.lan,
        label: t.lan_doc || t.lan || "字幕 " + (index + 1),
        url: bilibiliCaptionURL(t.subtitle_url),
        videoIdentity: "bilibili:" + bvid + ":" + metadata.cid,
      })),
    notice: rows.length
      ? ""
      : "B站没有返回可读取的CC轨道。画面中的烧录字幕无法直接读取，可导入字幕文件，或在工作台主动使用AI录音字幕。",
  };
}
export function parseBilibiliCaptions(input) {
  let value;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    fail("SUBTITLE_INVALID", "B站未返回有效字幕JSON");
  }
  if (!Array.isArray(value?.body) || !value.body.length)
    fail("SUBTITLE_UNAVAILABLE", "B站字幕内容为空");
  return validateCues(
    value.body.map((row, index) => ({
      id: "bili" + index,
      start: row.from,
      end: row.to,
      text: typeof row.content === "string" ? row.content.trim() : "",
      settings: "",
    })),
  );
}
