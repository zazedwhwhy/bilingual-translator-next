import { DocumentRunner } from "../documents/runner.js";
import { validateCues } from "../subtitles/cues.js";
import {
  cueDocument,
  translatedCues,
  priorityCueIds,
} from "../subtitles/model.js";
import { SubtitlePlayer, isOutputTrack } from "../subtitles/player.js";
import { sourceIdentity } from "../subtitles/platform-identity.js";
const videoIds = new WeakMap();
let counter = 0,
  current = null;
let transition = 0;
let capture;
function identity(video) {
  return sourceIdentity(video, location.href);
}
function retainIdentityWatch(video) {
  const token = "watch" + ++counter,
    tokens = new Set(
      (video.getAttribute("data-bt-next-watch") || "")
        .split(" ")
        .filter(Boolean),
    );
  tokens.add(token);
  video.setAttribute("data-bt-next-watch", [...tokens].join(" "));
  return () => {
    const remaining = new Set(
      (video.getAttribute("data-bt-next-watch") || "")
        .split(" ")
        .filter(Boolean),
    );
    remaining.delete(token);
    if (remaining.size)
      video.setAttribute("data-bt-next-watch", [...remaining].join(" "));
    else video.removeAttribute("data-bt-next-watch");
  };
}
function captureSample(id) {
  const row = capture;
  if (
    !row ||
    row.id !== id ||
    !row.video.isConnected ||
    row.video.currentSrc !== row.source ||
    identity(row.video) !== row.mediaIdentity
  )
    throw Object.assign(Error("录音视频已更换"), {
      code: "CAPTURE_TIMELINE_CHANGED",
    });
  const v = row.video;
  return {
    time: v.currentTime,
    clock: performance.timeOrigin + performance.now(),
    paused: v.paused,
    seeking: v.seeking,
    rate: v.playbackRate,
  };
}
function unbindCapture() {
  const row = capture;
  capture = null;
  if (!row) return;
  clearInterval(row.timer);
  row.releaseIdentity?.();
  for (const event of row.events)
    row.video.removeEventListener(event, row.changed);
  row.port.disconnect();
}
function bindCapture(message) {
  if (capture)
    throw Object.assign(Error("当前视频已有录音会话"), {
      code: "CAPTURE_BUSY",
    });
  const video = findVideo(message.videoId);
  const row = {
    id: message.sessionId,
    video,
    source: video.currentSrc,
    mediaIdentity: identity(video),
    events: [
      "pause",
      "seeking",
      "ratechange",
      "emptied",
      "loadstart",
      "ended",
      "error",
    ],
  };
  capture = row;
  const sample = captureSample(row.id);
  if (sample.paused || sample.seeking || sample.rate !== 1) {
    capture = null;
    throw Object.assign(Error("请先以1倍速播放所选视频，再开始录音。"), {
      code: "CAPTURE_TIMELINE_CHANGED",
    });
  }
  row.port = chrome.runtime.connect({ name: "bt-capture-source" });
  row.releaseIdentity = retainIdentityWatch(video);
  row.port.postMessage({ sessionId: row.id });
  row.changed = (event) => {
    if (capture !== row) return;
    unbindCapture();
    void rpc("ASR_CAPTURE_SIGNAL", {
      sessionId: row.id,
      reason: "视频播放状态改变（" + event.type + "），已停止录音。",
    }).catch(() => {});
  };
  for (const event of row.events) video.addEventListener(event, row.changed);
  row.timer = setInterval(() => {
    if (
      !video.isConnected ||
      video.currentSrc !== row.source ||
      identity(video) !== row.mediaIdentity
    )
      row.changed({ type: "sourcechange" });
  }, 400);
  return sample;
}
function videoList() {
  const priority = (video) =>
    (video.closest("#movie_player,.bpx-player-container") ? 10000000 : 0) +
    (video.paused ? 0 : 1000000) +
    video.getBoundingClientRect().width * video.getBoundingClientRect().height;
  return [...document.querySelectorAll("video")]
    .sort((a, b) => priority(b) - priority(a))
    .map((video, index) => {
      let record = videoIds.get(video);
      const sourceId = identity(video),
        source = video.currentSrc;
      if (!record || record.identity !== sourceId || record.source !== source) {
        record = { id: "video" + ++counter, identity: sourceId, source };
        videoIds.set(video, record);
      }
      return { id: record.id, index, video };
    });
}
function findVideo(id) {
  const video = videoList().find((row) => row.id === id)?.video;
  if (!video)
    throw Object.assign(Error("视频已更换或不存在，请重新选择。"), {
      code: "VIDEO_CHANGED",
    });
  return video;
}
function sourceTracks(video) {
  return [...video.textTracks].filter(
    (track) =>
      !isOutputTrack(video, track) &&
      ["subtitles", "captions"].includes(track.kind),
  );
}
function rpc(type, data = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          Object.assign(Error("字幕请求结果未知，请重新开始。"), {
            code: "OUTCOME_UNKNOWN",
          }),
        ),
      30000,
    );
    chrome.runtime.sendMessage({ channel: "BT_BG", type, ...data }).then(
      (reply) => {
        clearTimeout(timer);
        if (!reply?.ok)
          reject(
            Object.assign(
              Error(reply?.error?.message || "字幕操作失败"),
              reply?.error,
              { budget: reply?.budget },
            ),
          );
        else resolve(reply.data);
      },
      () => {
        clearTimeout(timer);
        reject(
          Object.assign(Error("扩展后台已中断。"), { code: "INTERRUPTED" }),
        );
      },
    );
  });
}
async function readTrack(track) {
  if (!track)
    throw Object.assign(Error("请选择可读取的字幕轨道，或导入SRT/VTT。"), {
      code: "SUBTITLE_UNAVAILABLE",
    });
  const previous = track.mode;
  track.mode = "hidden";
  const deadline = Date.now() + 6000;
  while (!track.cues?.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  let cues;
  try {
    cues = [...(track.cues || [])]
      .filter((cue) => cue.text?.trim())
      .map((cue, index) => ({
        id: String(index),
        start: cue.startTime,
        end: cue.endTime,
        text: cue.text.replace(/<[^>]*>/g, ""),
        settings: "",
      }));
  } finally {
    track.mode = previous;
  }
  if (!cues.length)
    throw Object.assign(
      Error("字幕轨道未提供可访问文字，请开启字幕后重试或导入SRT/VTT。"),
      { code: "SUBTITLE_UNAVAILABLE" },
    );
  return validateCues(cues);
}
async function stop(invalidate = true) {
  if (invalidate) transition++;
  const previous = current;
  current = null;
  if (!previous) return;
  clearInterval(previous.timer);
  previous.releaseIdentity?.();
  for (const event of ["emptied", "loadstart"])
    previous.video.removeEventListener(event, previous.sourceChanged);
  previous.video.removeEventListener("seeked", previous.reprioritize);
  previous.player.stop();
  previous.port?.disconnect();
  await previous.runner?.stop();
}
function watch(row) {
  row.mediaIdentity = identity(row.video);
  row.releaseIdentity = retainIdentityWatch(row.video);
  row.sourceChanged = () => {
    if (current === row) void stop();
  };
  for (const event of ["emptied", "loadstart"])
    row.video.addEventListener(event, row.sourceChanged);
  row.timer = setInterval(() => {
    if (
      !row.video.isConnected ||
      row.video.currentSrc !== row.source ||
      identity(row.video) !== row.mediaIdentity
    )
      void stop();
  }, 500);
  row.reprioritize = () => {
    if (row.runner)
      row.runner.prioritize(
        priorityCueIds(row.document.cues, row.video.currentTime),
      );
  };
  row.video.addEventListener("seeked", row.reprioritize);
}
async function apply(message) {
  const token = ++transition;
  await stop(false);
  if (token !== transition)
    throw Object.assign(Error("视频操作已停止"), { code: "CANCELLED" });
  const video = findVideo(message.videoId),
    cues = validateCues(message.cues);
  if (
    message.expectedIdentity !== undefined &&
    message.expectedIdentity !== identity(video)
  )
    throw Object.assign(Error("视频已切换，请重新选择"), {
      code: "VIDEO_CHANGED",
    });
  const row = {
    video,
    videoId: message.videoId,
    source: video.currentSrc,
    cues,
    player: new SubtitlePlayer(video),
  };
  current = row;
  row.player.update(cues);
  watch(row);
  return state();
}
async function initialize(message) {
  const token = ++transition;
  await stop(false);
  if (token !== transition)
    throw Object.assign(Error("视频操作已停止"), { code: "CANCELLED" });
  const video = findVideo(message.videoId),
    track = sourceTracks(video)[Number(message.trackId)];
  if (
    message.expectedIdentity !== undefined &&
    message.expectedIdentity !== identity(video)
  )
    throw Object.assign(Error("视频已切换，请重新读取字幕"), {
      code: "VIDEO_CHANGED",
    });
  const source = video.currentSrc,
    sourceId = identity(video);
  const cues = message.cues
    ? validateCues(message.cues)
    : await readTrack(track);
  if (token !== transition)
    throw Object.assign(Error("字幕读取期间已停止"), { code: "CANCELLED" });
  if (
    source !== video.currentSrc ||
    sourceId !== identity(video) ||
    !video.isConnected
  )
    throw Object.assign(Error("字幕读取期间视频已切换"), {
      code: "VIDEO_CHANGED",
    });
  const document = cueDocument(cues, "视频字幕", {
      priorityTime: video.currentTime,
    }),
    player = new SubtitlePlayer(video, message.job.target);
  const row = {
    video,
    videoId: message.videoId,
    source: video.currentSrc,
    document,
    player,
  };
  row.runner = new DocumentRunner(
    (type, data) =>
      type === "WB_START"
        ? Promise.resolve(message.job)
        : rpc(type.replace(/^WB_/, ""), data),
    () => {
      if (current === row)
        player.update(translatedCues(document, row.runner.translations));
    },
  );
  current = row;
  player.update(cues);
  row.port = chrome.runtime.connect({ name: "bt-next" });
  row.port.postMessage({ jobId: message.job.id });
  row.port.onDisconnect.addListener(() => {
    if (current === row && row.runner.phase !== "cancelled") {
      row.runner.phase = "interrupted";
      row.runner.errors.set("connection", {
        code: "INTERRUPTED",
        message: "后台连接中断，字幕翻译需重新开始。",
      });
    }
  });
  watch(row);
  void row.runner.start(document).catch((error) => {
    row.runner.phase = "error";
    row.runner.errors.set("start", {
      code: error.code,
      message: error.message,
    });
  });
  return state();
}
function state(withCues = false) {
  if (!current) return { phase: "idle" };
  if (!current.runner)
    return {
      phase: "displayed",
      videoId: current.videoId,
      total: current.cues.length,
      translated: current.cues.filter((c) => c.translation).length,
      ...(withCues ? { cues: current.cues } : {}),
    };
  const runner = current.runner;
  return {
    phase: runner.phase,
    videoId: current.videoId,
    total: current.document.cues.length,
    translated: runner.translations.size,
    budget: runner.budget,
    error: [...runner.errors.values()][0],
    ...(withCues
      ? { cues: translatedCues(current.document, runner.translations) }
      : {}),
  };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.channel !== "BT_VIDEO") return;
  const action = async () => {
    if (message.type === "DISCOVER")
      return videoList().map(({ id, index, video }) => ({
        id,
        label:
          "视频 " +
          (index + 1) +
          (video.getAttribute("aria-label")
            ? " · " + video.getAttribute("aria-label")
            : ""),
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        tracks: sourceTracks(video).map((track, index) => ({
          id: String(index),
          label: track.label || track.language || "字幕 " + (index + 1),
          language: track.language,
        })),
      }));
    if (message.type === "INIT") return initialize(message);
    if (message.type === "READ")
      return {
        cues: await readTrack(
          sourceTracks(findVideo(message.videoId))[Number(message.trackId)],
        ),
      };
    if (message.type === "APPLY") return apply(message);
    if (message.type === "CAPTURE_BIND") return bindCapture(message);
    if (message.type === "CAPTURE_SAMPLE")
      return captureSample(message.sessionId);
    if (message.type === "CAPTURE_UNBIND") {
      if (capture?.id === message.sessionId) unbindCapture();
      return {};
    }
    if (message.type === "STOP") {
      await stop();
      return { phase: "cancelled" };
    }
    if (message.type === "STATUS") return state();
    if (message.type === "EXPORT") return state(true);
    if (message.type === "CONTINUE") {
      const row = current;
      void row?.runner?.continue().catch((error) => {
        if (current !== row) return;
        row.runner.errors.set("continue", {
          code: error.code,
          message: error.message,
        });
      });
      return state();
    }
    if (message.type === "RETRY") {
      const row = current;
      void row?.runner?.retry().catch((error) => {
        if (current !== row) return;
        row.runner.errors.set("retry", {
          code: error.code,
          message: error.message,
        });
      });
      return state();
    }
    throw Error("未知视频操作");
  };
  action().then(
    (data) => reply({ ok: true, data }),
    (error) =>
      reply({
        ok: false,
        error: { code: error.code || "VIDEO_ERROR", message: error.message },
      }),
  );
  return true;
});
addEventListener("pagehide", () => void stop());
