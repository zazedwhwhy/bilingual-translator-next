import { fail } from "../shared/core.js";
import {
  youtubeTrackChoices,
  parseYouTubeCaptions,
} from "../subtitles/youtube.js";
import {
  bilibiliTrackChoices,
  parseBilibiliCaptions,
} from "../subtitles/bilibili.js";
import { platformIdentity } from "../subtitles/platform-identity.js";

// Serialized into MAIN. The only shared values are public video IDs and owned
// watcher tokens; no player URLs, cookies, or authentication cross the boundary.
export function syncPageIdentity() {
  const page = new URL(location.href);
  if (!/(^|\.)bilibili\.com$/.test(page.hostname)) return null;
  const video =
    document.querySelector(".bpx-player-container video") ||
    document.querySelector("video");
  if (!video) return "bilibili:unavailable";
  const update = () => {
    let identity = "bilibili:unavailable";
    try {
      const currentURL = new URL(location.href),
        bvid = currentURL.pathname.match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1],
        manifest = window.player?.getManifest?.();
      if (
        bvid &&
        manifest?.bvid === bvid &&
        Number.isSafeInteger(manifest.cid) &&
        manifest.cid > 0
      )
        identity = "bilibili:" + bvid + ":" + manifest.cid;
    } catch {
      /* An unreadable manifest invalidates the old source instead of retaining it. */
    }
    if (video.getAttribute("data-bt-next-source-id") !== identity)
      video.setAttribute("data-bt-next-source-id", identity);
    return identity;
  };
  const registry =
    window.__btNextIdentityWatch ||
    (window.__btNextIdentityWatch = new WeakMap());
  if (!registry.has(video)) {
    let timer;
    const refreshWatch = () => {
      const wanted =
        video.isConnected && Boolean(video.getAttribute("data-bt-next-watch"));
      if (wanted && !timer)
        timer = setInterval(() => {
          if (!video.isConnected) {
            clearInterval(timer);
            timer = null;
            return;
          }
          update();
        }, 250);
      if (!wanted && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const observer = new MutationObserver(refreshWatch);
    observer.observe(video, {
      attributes: true,
      attributeFilter: ["data-bt-next-watch"],
    });
    registry.set(video, { observer });
    refreshWatch();
  }
  return update();
}

// This function is serialized into the page's MAIN world. It only reads current
// player metadata and reuses a URL already requested by Bilibili's own player.
async function readPageMetadata() {
  try {
    const page = new URL(location.href);
    if (/(^|\.)youtube\.com$/.test(page.hostname)) {
      const compact = (p) =>
        p
          ? {
              videoId: p.videoDetails?.videoId,
              tracks:
                p.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
                [],
            }
          : null;
      return {
        ok: true,
        platform: "youtube",
        current: compact(
          document.getElementById("movie_player")?.getPlayerResponse?.(),
        ),
        initial: compact(window.ytInitialPlayerResponse),
      };
    }
    if (/(^|\.)bilibili\.com$/.test(page.hostname)) {
      const bvid = page.pathname.match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1],
        manifest = window.player?.getManifest?.(),
        cid = manifest?.cid;
      if (
        !bvid ||
        manifest?.bvid !== bvid ||
        !Number.isSafeInteger(cid) ||
        cid <= 0
      )
        throw Object.assign(Error("B站正在切换视频或分P，请稍后重新读取"), {
          code: "VIDEO_CHANGED",
        });
      const entries = performance
        .getEntriesByType("resource")
        .filter((entry) => {
          try {
            const url = new URL(entry.name);
            return (
              url.origin === "https://api.bilibili.com" &&
              url.pathname === "/x/player/wbi/v2" &&
              url.searchParams.get("cid") === String(cid)
            );
          } catch {
            return false;
          }
        });
      if (!entries.length)
        return {
          ok: true,
          platform: "bilibili",
          bvid,
          cid,
          unavailable: true,
          notice:
            "请刷新B站页面，等视频加载后重新读取字幕。扩展只复用播放器已请求的字幕信息。",
        };
      const response = await fetch(entries.at(-1).name, {
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok)
        throw Object.assign(
          Error(
            "B站没有允许读取字幕信息（HTTP " +
              response.status +
              "），请在站内检查。",
          ),
          { code: "SUBTITLE_HTTP_ERROR" },
        );
      const value = await response.json();
      return {
        ok: true,
        platform: "bilibili",
        bvid,
        cid,
        response: {
          code: value.code,
          data: {
            need_login_subtitle: value.data?.need_login_subtitle,
            subtitle: value.data?.subtitle,
          },
        },
      };
    }
    return { ok: true, platform: null };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code || "SUBTITLE_METADATA_ERROR",
        message: error.code
          ? error.message
          : "站点字幕信息读取失败，请在播放器检查后重新读取。",
      },
    };
  }
}
async function fetchCaptionText(url, platform) {
  let reader;
  try {
    const response = await fetch(url, {
      credentials: platform === "youtube" ? "same-origin" : "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return {
        ok: false,
        error: {
          code: "SUBTITLE_HTTP_ERROR",
          message: "网站未允许读取字幕（HTTP " + response.status + "）。",
        },
      };
    if (!response.body)
      return {
        ok: false,
        error: {
          code: "SUBTITLE_EMPTY",
          message: "网站未返回字幕内容。请先在播放器开启所需字幕。",
        },
      };
    reader = response.body.getReader();
    const pieces = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5 * 1024 * 1024)
        throw Object.assign(Error("字幕文件超过5 MiB"), {
          code: "SUBTITLE_LIMIT",
        });
      pieces.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of pieces) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { ok: true, text: new TextDecoder().decode(bytes) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code || "SUBTITLE_FETCH_FAILED",
        message: error.code
          ? error.message
          : "网站字幕请求失败，请在原播放器检查后重试。",
      },
    };
  } finally {
    if (reader)
      try {
        await reader.cancel();
      } catch {
        /* Preserve the primary read outcome. */
      }
  }
}
export function platformCaptions(api, settings) {
  const cache = new Map();
  async function identity(tabId) {
    const tab = await api.tabs.get(tabId),
      identity = platformIdentity(tab.url);
    if (!identity?.startsWith("bilibili:")) return identity;
    const [result] = await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: syncPageIdentity,
    });
    if (
      typeof result?.result !== "string" ||
      result.result === "bilibili:unavailable"
    )
      fail("VIDEO_CHANGED", "B站当前视频信息尚未就绪，请播放后重新读取");
    return result.result;
  }
  async function metadata(tabId, { fresh = false } = {}) {
    const tab = await api.tabs.get(tabId),
      url = new URL(tab.url);
    if (!/(^|\.)(youtube|bilibili)\.com$/.test(url.hostname))
      return { platform: null, tracks: [] };
    const key = tabId + ":" + tab.url,
      hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 30000) return hit.value;
    const [result] = await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: readPageMetadata,
    });
    const data = result?.result;
    if (!data?.ok)
      fail(
        data?.error?.code || "INTERRUPTED",
        data?.error?.message || "网页字幕信息未响应",
      );
    const config = await settings.public();
    let value;
    if (data.platform === "youtube")
      value = {
        platform: "youtube",
        tracks: youtubeTrackChoices(
          data,
          tab.url,
          config.source,
          config.target,
        ),
      };
    else if (data.unavailable)
      value = { platform: "bilibili", tracks: [], notice: data.notice };
    else
      value = { platform: "bilibili", ...bilibiliTrackChoices(data, tab.url) };
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return value;
  }
  async function read(tabId, trackId, { metadata: known } = {}) {
    const meta = known || (await metadata(tabId, { fresh: true })),
      track = meta.tracks.find((t) => t.id === trackId);
    if (!track)
      fail(
        meta.reason === "LOGIN_REQUIRED"
          ? "SUBTITLE_LOGIN_REQUIRED"
          : "SUBTITLE_UNAVAILABLE",
        meta.notice || "字幕轨道或视频已改变，请重新读取",
      );
    if ((await identity(tabId)) !== track.videoIdentity)
      fail("VIDEO_CHANGED", "字幕轨道不再属于当前视频，请重新读取");
    const [result] = await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: fetchCaptionText,
      args: [track.url, meta.platform],
    });
    const reply = result?.result;
    if (!reply?.ok)
      fail(
        reply?.error?.code || "INTERRUPTED",
        reply?.error?.message || "网页字幕请求未响应",
      );
    if ((await identity(tabId)) !== track.videoIdentity)
      fail("VIDEO_CHANGED", "字幕下载期间视频已切换，请重新读取");
    return {
      cues:
        meta.platform === "youtube"
          ? parseYouTubeCaptions(reply.text)
          : parseBilibiliCaptions(reply.text),
      videoIdentity: track.videoIdentity,
    };
  }
  return { metadata, read, identity };
}
