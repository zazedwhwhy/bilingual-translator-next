import { parseSubtitles, exportSubtitles } from "../subtitles/cues.js";
import {
  cueDocument,
  translatedCues,
  activeSubtitle,
} from "../subtitles/model.js";
import { SubtitlePlayer } from "../subtitles/player.js";
import { DocumentRunner } from "../documents/runner.js";
export function mountSubtitles({ rpc, download }) {
  const $ = (id) => document.getElementById(id);
  let model,
    player,
    mediaURL,
    sourceTabId,
    sourceVideos = [];
  const runner = new DocumentRunner(
    (type, data = {}) =>
      rpc(type, type === "WB_START" ? { ...data, purpose: "subtitles" } : data),
    update,
  );
  function status(text, phase) {
    $("subtitle-status").textContent = text;
    $("subtitle-status").dataset.phase = phase;
  }
  function cues() {
    return model ? translatedCues(model, runner.translations) : [];
  }
  function update() {
    if (!model) return;
    const labels = {
      starting: "准备翻译",
      translating: "正在翻译字幕",
      complete: "字幕翻译完成",
      paused_budget: "达到本轮上限，请点击继续",
      error: "字幕翻译失败",
      interrupted: "结果未知，需重新开始",
      cancelled: "已停止",
    };
    status(
      (labels[runner.phase] || runner.phase) +
        " · " +
        runner.translations.size +
        "/" +
        model.cues.length +
        " 条" +
        ([...runner.errors.values()][0]
          ? "\n" + [...runner.errors.values()][0].message
          : ""),
      runner.phase,
    );
    const translated = cues();
    player?.update(translated, Number($("subtitle-offset").value) || 0);
    $("subtitle-active").textContent = activeSubtitle(
      translated,
      $("subtitle-player").currentTime,
      Number($("subtitle-offset").value) || 0,
    );
    $("subtitle-list").replaceChildren(
      ...translated.slice(0, 200).map((cue) => {
        const row = document.createElement("p");
        row.textContent =
          cue.start.toFixed(3) +
          "–" +
          cue.end.toFixed(3) +
          "  " +
          cue.text +
          (cue.translation ? "\n" + cue.translation : "");
        return row;
      }),
    );
    $("subtitle-translate").disabled = runner.running;
    $("subtitle-continue").disabled = runner.phase !== "paused_budget";
    $("subtitle-retry").disabled = runner.phase !== "error";
    for (const id of ["subtitle-srt", "subtitle-vtt"])
      $(id).disabled = runner.translations.size !== model.cues.length;
  }
  async function action(fn) {
    try {
      await fn();
    } catch (error) {
      status((error.code || "ERROR") + "：" + error.message, "error");
    }
  }
  $("subtitle-file").onchange = () =>
    void action(async () => {
      const file = $("subtitle-file").files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) throw Error("字幕文件超过5 MiB");
      await runner.stop(false);
      player?.stop();
      model = cueDocument(
        parseSubtitles(
          await file.text(),
          file.name.toLowerCase().endsWith(".vtt") ? "vtt" : "srt",
        ),
        file.name,
      );
      runner.translations.clear();
      runner.errors.clear();
      player = new SubtitlePlayer($("subtitle-player"));
      player.update(model.cues, Number($("subtitle-offset").value) || 0);
      update();
      status(
        "已读取 " + model.cues.length + " 条字幕，时间轴保持原样。",
        "ready",
      );
    });
  $("subtitle-media-file").onchange = () => {
    const file = $("subtitle-media-file").files[0];
    if (!file) return;
    if (mediaURL) URL.revokeObjectURL(mediaURL);
    mediaURL = URL.createObjectURL(file);
    $("subtitle-player").src = mediaURL;
    $("subtitle-player").load();
  };
  $("subtitle-player").ontimeupdate = () => {
    $("subtitle-active").textContent = activeSubtitle(
      cues(),
      $("subtitle-player").currentTime,
      Number($("subtitle-offset").value) || 0,
    );
  };
  $("subtitle-offset").oninput = () => {
    if (model) {
      player?.update(cues(), Number($("subtitle-offset").value) || 0);
      $("subtitle-player").ontimeupdate();
    }
  };
  $("subtitle-translate").onclick = () =>
    void action(() => runner.start(model));
  $("subtitle-stop").onclick = () => void action(() => runner.stop());
  $("subtitle-continue").onclick = () => void action(() => runner.continue());
  $("subtitle-retry").onclick = () => void action(() => runner.retry());
  for (const format of ["srt", "vtt"])
    $("subtitle-" + format).onclick = () =>
      void action(() => {
        if (!model || runner.translations.size !== model.cues.length)
          throw Error("仍有未完成字幕");
        download(
          exportSubtitles(cues(), format),
          model.name.replace(/\.[^.]+$/, "") + "-双语." + format,
          "text/plain;charset=utf-8",
        );
      });
  async function source() {
    const chosen = $("subtitle-target").value;
    const result = await rpc("WB_SOURCE");
    sourceTabId = result.tabId;
    if (!sourceTabId) {
      $("subtitle-apply").disabled = true;
      return;
    }
    sourceVideos = await rpc("VIDEO_LIST", { tabId: sourceTabId });
    $("subtitle-target").replaceChildren(
      ...sourceVideos.map((video) => new Option(video.label, video.id)),
    );
    if (sourceVideos.some((v) => v.id === chosen))
      $("subtitle-target").value = chosen;
    $("subtitle-apply").disabled = !sourceVideos.length;
  }
  $("subtitle-target-refresh").onclick = () => void action(source);
  $("subtitle-apply").onclick = () =>
    void action(async () => {
      if (!model || !sourceTabId)
        throw Error("请先从视频页面打开工作台并导入字幕");
      await rpc("VIDEO_APPLY", {
        tabId: sourceTabId,
        videoId: $("subtitle-target").value,
        cues: cues(),
      });
      status("字幕已应用到原网页视频。", "applied");
    });
  $("subtitle-translate").disabled = true;
  void source().catch(() => {});
  addEventListener("pagehide", () => {
    void runner.stop(false);
    player?.stop();
    if (mediaURL) URL.revokeObjectURL(mediaURL);
  });
  return {
    async clear() {
      await runner.stop(false);
      model = null;
      player?.stop();
      runner.translations.clear();
      runner.errors.clear();
      $("subtitle-list").replaceChildren();
      $("subtitle-active").textContent = "";
      for (const id of [
        "subtitle-translate",
        "subtitle-continue",
        "subtitle-retry",
        "subtitle-srt",
        "subtitle-vtt",
      ])
        $(id).disabled = true;
      status("等待新的字幕或语音识别结果。", "idle");
    },
    setMedia(file) {
      if (mediaURL) URL.revokeObjectURL(mediaURL);
      mediaURL = URL.createObjectURL(file);
      $("subtitle-player").src = mediaURL;
      $("subtitle-player").load();
    },
    loadCues(cueList, name) {
      model = cueDocument(cueList, name);
      runner.translations.clear();
      runner.errors.clear();
      player?.stop();
      player = new SubtitlePlayer($("subtitle-player"));
      update();
      status("已生成 " + cueList.length + " 条带时间轴字幕。", "ready");
    },
    runner,
    cues,
    async appendCues(cueList, name) {
      const next = cueDocument(cueList, name);
      if (!model) {
        model = next;
        player = new SubtitlePlayer($("subtitle-player"));
        await runner.start(next);
      } else {
        model = next;
        await runner.extend(next);
      }
      update();
    },
    source: () => ({ tabId: sourceTabId, videoId: $("subtitle-target").value }),
    refreshSource: source,
    getModel: () => model,
  };
}
