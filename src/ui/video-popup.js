import { parseSubtitles, exportSubtitles } from "../subtitles/cues.js";
import { preferredCaption } from "../subtitles/selection.js";
export function setupVideoPanel({ send }) {
  const $ = (id) => document.getElementById(id);
  $("video-open").disabled = false;
  $("video-quick").disabled = $("start").disabled;
  let videos = [],
    imported = null,
    preferences = { source: "auto", target: "zh-CN" };
  function show(text) {
    $("video-status").textContent = text;
  }
  function tracks() {
    const video = videos.find((v) => v.id === $("video-select").value);
    $("video-track").replaceChildren(
      ...(video?.tracks || []).map(
        (track) => new Option(track.label, track.id),
      ),
    );
    const preferred = preferredCaption(video, preferences);
    if (preferred) $("video-track").value = preferred.id;
    $("video-start").disabled = !imported && !video?.tracks.length;
  }
  async function action(fn) {
    try {
      await fn();
    } catch (error) {
      show((error.code || "ERROR") + "：" + error.message);
    }
  }
  $("video-open").onclick = () =>
    void action(async () => {
      $("video-panel").hidden = false;
      $("video-manual-controls").hidden = false;
      $("video-start").hidden = false;
      $("video-source").textContent =
        "读取现成字幕或导入字幕文件；AI录音在工作台中另行启动。";
      show("正在读取当前页面视频…");
      videos = await send("VIDEO_LIST");
      preferences = await send("CONFIG");
      $("video-select").replaceChildren(
        ...videos.map((video) => new Option(video.label, video.id)),
      );
      tracks();
      show(
        videos[0]?.notice ||
          (videos.length
            ? "选择轨道后翻译，或导入SRT/VTT。"
            : "当前顶层页面没有可访问视频。"),
      );
    });
  $("video-quick").onclick = () =>
    void action(async () => {
      $("video-panel").hidden = false;
      $("video-manual-controls").hidden = true;
      $("video-start").hidden = true;
      $("video-source").textContent = "正在读取现成外语字幕，不启动语音识别。";
      $("video-quick").disabled = true;
      try {
        show("读取字幕后开始文字翻译…");
        const result = await send("VIDEO_QUICK");
        imported = null;
        $("video-source").textContent =
          "现成字幕 · " +
          result.sourceTrack.label +
          (result.sourceTrack.automatic ? "（平台自动生成）" : "");
        show("已读取现成字幕，正在逐批翻译并显示。");
      } finally {
        $("video-quick").disabled = false;
      }
    });
  $("video-select").onchange = () => {
    tracks();
    show(
      videos.find((v) => v.id === $("video-select").value)?.notice ||
        "选择轨道后翻译，或导入SRT/VTT。",
    );
  };
  $("video-file").onchange = () =>
    void action(async () => {
      const file = $("video-file").files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) throw Error("字幕文件过大");
      imported = parseSubtitles(
        await file.text(),
        file.name.endsWith(".vtt") ? "vtt" : "srt",
      );
      tracks();
      show("已导入 " + imported.length + " 条字幕。");
    });
  $("video-start").onclick = () =>
    void action(async () => {
      show("正在翻译字幕…");
      await send("VIDEO_START", {
        videoId: $("video-select").value,
        trackId: $("video-track").value,
        ...(imported ? { cues: imported } : {}),
      });
    });
  $("video-stop").onclick = () =>
    void action(async () => {
      await send("VIDEO_STOP");
      show("已恢复原字幕轨道。");
    });
  $("video-continue").onclick = () => void action(() => send("VIDEO_CONTINUE"));
  $("video-retry").onclick = () => void action(() => send("VIDEO_RETRY"));
  $("video-export").onclick = () =>
    void action(async () => {
      const result = await send("VIDEO_EXPORT");
      if (!result.cues || result.translated !== result.total)
        throw Error("字幕尚未全部翻译");
      const url = URL.createObjectURL(
        new Blob([exportSubtitles(result.cues, "srt")], {
          type: "text/plain;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "video-双语.srt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
  setInterval(() => {
    if ($("video-panel").hidden) return;
    send("VIDEO_STATUS").then(
      (result) => {
        if (result.phase === "idle") return;
        show(
          ({
            starting: "准备字幕",
            translating: "正在翻译",
            complete: "字幕翻译完成",
            paused_budget: "达到本轮上限",
            error: "字幕翻译失败",
            interrupted: "后台中断，需重新开始",
            cancelled: "已停止",
          }[result.phase] || result.phase) +
            " · " +
            result.translated +
            "/" +
            result.total +
            " 条" +
            (result.error ? "\n" + result.error.message : ""),
        );
        $("video-export").disabled = result.translated !== result.total;
        $("video-continue").disabled = result.phase !== "paused_budget";
        $("video-retry").disabled = result.phase !== "error";
      },
      () => show("字幕连接已中断，请重新选择视频。"),
    );
  }, 750);
}
