import { validateCues } from "./cues.js";
const tracks = new WeakMap();
const escapeText = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function isOutputTrack(video, track) {
  return tracks.get(video) === track;
}
export class SubtitlePlayer {
  constructor(video, language = "zh-CN") {
    this.video = video;
    this.previous = new Map(
      [...video.textTracks]
        .filter((track) => !isOutputTrack(video, track))
        .map((track) => [track, track.mode]),
    );
    this.track =
      tracks.get(video) ||
      video.addTextTrack("subtitles", "双语阅读 Next", language);
    tracks.set(video, this.track);
    this.rendered = new Map();
    this.values = new Map();
    for (const [track] of this.previous) track.mode = "disabled";
    this.host = video.closest("#movie_player,.bpx-player-container");
    if (this.host) {
      this.platform = this.host.id === "movie_player" ? "youtube" : "bilibili";
      this.previousHostFlag = this.host.getAttribute("data-bt-next-platform");
      this.host.setAttribute("data-bt-next-platform", this.platform);
      this.layer = document.createElement("div");
      this.layer.className = "bt-next-subtitles";
      this.layer.dataset.btNext = "subtitles-overlay";
      this.layer.setAttribute("aria-live", "off");
      this.host.append(this.layer);
      this.renderLayer = () => {
        const nativeFullscreen = document.fullscreenElement === video;
        this.track.mode = nativeFullscreen ? "showing" : "hidden";
        this.layer.hidden = nativeFullscreen;
        const active = [...(this.track.activeCues || [])]
          .map((c) => this.values.get(c.id))
          .filter(Boolean);
        this.layer.replaceChildren();
        if (!active.length) return;
        for (const key of ["text", "translation"]) {
          const value = active
            .map((c) => c[key])
            .filter(Boolean)
            .join("\n");
          if (!value) continue;
          const row = document.createElement("div");
          row.className = "bt-next-subtitle-" + key;
          row.textContent = value;
          this.layer.append(row);
        }
      };
      this.resize = new ResizeObserver(() => {
        this.layer.style.fontSize =
          Math.max(
            14,
            Math.min(28, this.host.getBoundingClientRect().width / 40),
          ) + "px";
      });
      this.resize.observe(this.host);
      this.track.addEventListener("cuechange", this.renderLayer);
      for (const event of ["timeupdate", "seeked", "loadedmetadata"])
        video.addEventListener(event, this.renderLayer);
      document.addEventListener("fullscreenchange", this.renderLayer);
    }
    this.track.mode = this.host ? "hidden" : "showing";
  }
  update(cues, offset = 0) {
    validateCues(cues);
    const needed = new Set();
    this.values = new Map(cues.map((c) => ["bt-next:" + c.id, c]));
    for (const cue of cues) {
      const start = cue.start + offset,
        end = cue.end + offset;
      if (end <= 0) continue;
      needed.add(cue.id);
      const text =
        escapeText(cue.text) +
        (cue.translation ? "\n" + escapeText(cue.translation) : "");
      let output = this.rendered.get(cue.id);
      if (
        output &&
        (output.startTime !== Math.max(0, start) || output.endTime !== end)
      ) {
        this.track.removeCue(output);
        this.rendered.delete(cue.id);
        output = null;
      }
      if (!output) {
        output = new VTTCue(Math.max(0, start), end, text);
        output.id = "bt-next:" + cue.id;
        output.line = -2;
        output.size = 90;
        this.track.addCue(output);
        this.rendered.set(cue.id, output);
      } else output.text = text;
    }
    for (const [id, cue] of this.rendered)
      if (!needed.has(id)) {
        this.track.removeCue(cue);
        this.rendered.delete(id);
      }
    this.track.mode =
      this.host && document.fullscreenElement !== this.video
        ? "hidden"
        : "showing";
    this.renderLayer?.();
  }
  stop() {
    if (this.layer) {
      this.track.removeEventListener("cuechange", this.renderLayer);
      for (const event of ["timeupdate", "seeked", "loadedmetadata"])
        this.video.removeEventListener(event, this.renderLayer);
      document.removeEventListener("fullscreenchange", this.renderLayer);
      this.resize.disconnect();
      this.layer.remove();
      if (this.host.getAttribute("data-bt-next-platform") === this.platform) {
        if (this.previousHostFlag === null)
          this.host.removeAttribute("data-bt-next-platform");
        else
          this.host.setAttribute(
            "data-bt-next-platform",
            this.previousHostFlag,
          );
      }
    }
    for (const cue of [...(this.track.cues || [])]) this.track.removeCue(cue);
    this.track.mode = "disabled";
    for (const [track, mode] of this.previous) track.mode = mode;
    this.rendered.clear();
    this.values.clear();
  }
}
