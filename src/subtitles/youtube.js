import { fail } from "../shared/core.js";
import { validateCues } from "./cues.js";
export function youtubeVideoId(value) {
  const url = new URL(value);
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  return url.pathname === "/watch"
    ? url.searchParams.get("v")
    : url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1] || null;
}
export function youtubeTrackChoices(
  metadata,
  pageURL,
  source = "auto",
  target = "zh-CN",
) {
  const videoId = youtubeVideoId(pageURL);
  if (!videoId) return [];
  if (metadata.current?.videoId && metadata.current.videoId !== videoId)
    fail("VIDEO_CHANGED", "YouTube正在切换视频，请稍后重新读取字幕");
  const selected = metadata.current?.videoId
    ? metadata.current
    : metadata.initial;
  if (!selected || selected.videoId !== videoId)
    fail("VIDEO_CHANGED", "YouTube字幕信息尚未对应当前视频，请重新读取");
  return (selected.tracks || [])
    .slice(0, 500)
    .map((track, index) => ({
      id:
        "yt:" +
        videoId +
        ":" +
        encodeURIComponent(
          track.vssId ||
            track.languageCode + ":" + (track.kind || "manual") + ":" + index,
        ),
      language: track.languageCode,
      label:
        (track.name?.simpleText ||
          track.name?.runs?.map((r) => r.text).join("") ||
          track.languageCode) + (track.kind === "asr" ? " · 自动生成" : ""),
      url: captionURL(track.baseUrl, pageURL),
      automatic: track.kind === "asr",
      videoIdentity: "youtube:" + videoId,
    }))
    .sort((a, b) => {
      const rank = (t) =>
        (source !== "auto" && t.language === source
          ? 0
          : t.language === "en"
            ? 1
            : t.language === target
              ? 4
              : 2) + (t.automatic ? 0.1 : 0);
      return rank(a) - rank(b);
    });
}
export function parseYouTubeCaptions(body) {
  if (typeof body === "string" && !body.trim())
    fail(
      "SUBTITLE_EMPTY",
      "YouTube返回了空字幕。请先在播放器开启所需字幕；若网站本身没有显示字幕，扩展也无法读取。",
    );
  let data;
  try {
    data = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    fail("SUBTITLE_INVALID", "YouTube未返回可解析字幕");
  }
  if (!Array.isArray(data?.events))
    fail("SUBTITLE_INVALID", "YouTube字幕结构无效");
  const cues = [];
  for (const event of data.events) {
    const text = event.segs
      ?.map((s) => s.utf8 || "")
      .join("")
      .trim();
    if (!text) continue;
    if (
      !Number.isFinite(event.tStartMs) ||
      !Number.isFinite(event.dDurationMs) ||
      event.dDurationMs <= 0
    )
      fail("SUBTITLE_INVALID", "字幕没有可靠持续时间");
    cues.push({
      id: "yt" + cues.length,
      start: event.tStartMs / 1000,
      end: (event.tStartMs + event.dDurationMs) / 1000,
      text,
      settings: "",
    });
  }
  if (!cues.length)
    fail(
      "SUBTITLE_UNAVAILABLE",
      "未读取到已加载字幕，请开启字幕后重试或导入SRT/VTT",
    );
  return validateCues(cues);
}
export function captionURL(value, pageURL) {
  let url, page;
  try {
    url = new URL(value);
    page = new URL(pageURL);
  } catch {
    fail("SUBTITLE_INVALID", "字幕地址无效");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== page.origin ||
    !/(^|\.)youtube\.com$/.test(url.hostname) ||
    url.pathname !== "/api/timedtext"
  )
    fail("SUBTITLE_INVALID", "仅允许当前YouTube页面的字幕地址");
  if (url.searchParams.get("v") !== youtubeVideoId(pageURL))
    fail("SUBTITLE_INVALID", "字幕地址不属于当前YouTube视频");
  url.searchParams.set("fmt", "json3");
  return url.href;
}
