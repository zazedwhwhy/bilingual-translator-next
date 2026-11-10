import { fail } from "../shared/core.js";
export function timestamp(value) {
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) fail("SUBTITLE_INVALID", "字幕时间格式无效");
  const hours = Number(match[1] || 0),
    minutes = Number(match[2]),
    seconds = Number(match[3]);
  if (minutes >= 60 || seconds >= 60)
    fail("SUBTITLE_INVALID", "字幕时间超出范围");
  return hours * 3600 + minutes * 60 + seconds + Number(match[4]) / 1000;
}
function plainText(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (s, k) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[k],
    );
}
export function validateCues(cues) {
  const ids = new Set();
  for (const cue of cues) {
    if (
      !cue ||
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.start < 0 ||
      cue.end <= cue.start ||
      typeof cue.text !== "string" ||
      (cue.translation !== undefined && typeof cue.translation !== "string") ||
      !cue.text.trim() ||
      typeof cue.id !== "string" ||
      !cue.id ||
      /[\r\n]/.test(cue.id) ||
      cue.id.includes("-->") ||
      cue.id.length > 200 ||
      ids.has(cue.id)
    )
      fail("SUBTITLE_INVALID", "字幕缺少有效时间、文字或唯一编号");
    ids.add(cue.id);
  }
  return cues;
}
export function parseSubtitles(source, format) {
  if (typeof source !== "string" || source.length > 5 * 1024 * 1024)
    fail("SUBTITLE_INVALID", "字幕文件无效或过大");
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const vtt = format === "vtt" || text.startsWith("WEBVTT");
  if (vtt && !/^WEBVTT(?:[^\n]*)\n/.test(text))
    fail("SUBTITLE_INVALID", "缺少WebVTT头");
  const blocks = (vtt ? text.replace(/^WEBVTT[^\n]*(?:\n|$)/, "") : text)
      .trim()
      .split(/\n[\t ]*\n/),
    cues = [];
  for (const block of blocks) {
    if (
      !block.trim() ||
      (vtt && /^(NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block))
    )
      continue;
    const lines = block.split("\n");
    let timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0 || timing > 1) fail("SUBTITLE_INVALID", "字幕块缺少时间");
    const match = lines[timing].match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/);
    if (!match) fail("SUBTITLE_INVALID", "字幕时间行无效");
    cues.push({
      id: timing === 1 ? lines[0].trim() : String(cues.length + 1),
      start: timestamp(match[1]),
      end: timestamp(match[2]),
      settings: vtt ? match[3] || "" : "",
      text: plainText(lines.slice(timing + 1).join("\n")).trim(),
    });
  }
  if (!cues.length) fail("SUBTITLE_INVALID", "没有可用的字幕");
  return validateCues(cues);
}
function timecode(value, format) {
  const ms = Math.round(value * 1000),
    hours = Math.floor(ms / 3600000),
    minutes = Math.floor(ms / 60000) % 60,
    seconds = Math.floor(ms / 1000) % 60;
  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    (format === "srt" ? "," : ".") +
    String(ms % 1000).padStart(3, "0")
  );
}
export function exportSubtitles(
  cues,
  format = "srt",
  { bilingual = true, translatedOnly = false } = {},
) {
  validateCues(cues);
  if (!["srt", "vtt"].includes(format))
    fail("SUBTITLE_INVALID", "不支持的字幕格式");
  return (
    (format === "vtt" ? "WEBVTT\n\n" : "") +
    cues
      .map((cue, i) => {
        const identifier =
          format === "srt"
            ? /^\d+$/.test(cue.id)
              ? cue.id
              : String(i + 1)
            : cue.id;
        const text = translatedOnly
          ? cue.translation || cue.text
          : cue.text +
            (bilingual && cue.translation ? "\n" + cue.translation : "");
        return (
          identifier +
          "\n" +
          timecode(cue.start, format) +
          " --> " +
          timecode(cue.end, format) +
          (format === "vtt" && cue.settings ? " " + cue.settings : "") +
          "\n" +
          text.replace(/-->/g, "→") +
          "\n"
        );
      })
      .join("\n")
  );
}
export function validateTimedSegments(response) {
  if (!Array.isArray(response?.segments) || !response.segments.length)
    fail("ASR_NO_TIMESTAMPS", "语音服务没有返回分段时间，不能生成可靠字幕");
  return validateCues(
    response.segments.map((s, i) => ({
      id: String(i),
      start: s.start,
      end: s.end,
      text: typeof s.text === "string" ? s.text.trim() : "",
      settings: "",
    })),
  );
}
export function mergeTranscripts(chunks) {
  const cues = [];
  for (const chunk of chunks) {
    if (
      typeof chunk.id !== "string" ||
      !Number.isFinite(chunk.offset) ||
      chunk.offset < 0
    )
      fail("SUBTITLE_INVALID", "录音片段起点无效");
    validateCues(chunk.cues);
    for (const cue of chunk.cues)
      cues.push({
        ...cue,
        id: chunk.id + ":" + cue.id,
        start: Math.round((cue.start + chunk.offset) * 1000) / 1000,
        end: Math.round((cue.end + chunk.offset) * 1000) / 1000,
      });
  }
  return validateCues(cues.sort((a, b) => a.start - b.start || a.end - b.end));
}
