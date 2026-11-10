import { addAudio } from "../media/store.js";
export function mountAsrWorkbench({ rpc, subtitles }) {
  const $ = (id) => document.getElementById(id);
  let sessionId,
    lease,
    generation = 0,
    working = false;
  function status(text, phase) {
    $("asr-status").textContent = text;
    $("asr-status").dataset.phase = phase;
  }
  function buttons() {
    $("asr-start").disabled = working || !$("asr-file").files[0];
    $("asr-stop").disabled = !working;
  }
  async function action(fn) {
    try {
      await fn();
    } catch (error) {
      status((error.code || "ASR_ERROR") + "：" + error.message, "error");
      working = false;
      buttons();
    }
  }
  async function destroy() {
    generation++;
    if (sessionId) await rpc("ASR_DELETE", { sessionId });
    sessionId = null;
    lease?.disconnect();
    lease = null;
    working = false;
    buttons();
  }
  async function finish(cues, name, version) {
    if (version !== generation) return;
    subtitles.loadCues(cues, name);
    status("语音识别完成，正在翻译 " + cues.length + " 条字幕…", "translating");
    await subtitles.runner.start(subtitles.getModel());
    if (version !== generation) return;
    status(
      subtitles.runner.phase === "complete"
        ? "AI双语字幕已完成，可预览或导出。"
        : "识别已完成，字幕翻译状态：" + subtitles.runner.phase,
      subtitles.runner.phase === "complete" ? "complete" : "transcribed",
    );
  }
  async function poll(version, name) {
    while (version === generation) {
      const current = await rpc("ASR_STATUS", { sessionId });
      if (version !== generation) return;
      status(
        "语音识别 " +
          current.completed +
          "/" +
          current.chunks.length +
          " 个片段" +
          (current.error
            ? "\n" + current.error.code + "：" + current.error.message
            : ""),
        current.phase,
      );
      if (current.phase === "complete") {
        await finish(current.cues, name, version);
        return;
      }
      if (["error", "cancelled", "interrupted"].includes(current.phase)) {
        $("asr-retry").disabled = current.phase !== "error";
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  $("asr-file").onchange = () =>
    void action(async () => {
      await destroy();
      $("asr-retry").disabled = true;
      await subtitles.clear();
      status("音视频仅保留在本机。点击后将发送到你配置的语音接口。", "ready");
      buttons();
    });
  $("asr-start").onclick = () =>
    void action(async () => {
      const file = $("asr-file").files[0];
      if (!file) return;
      if (file.size >= 25 * 1024 * 1024)
        throw Error(
          "单个上传片段必须小于25 MiB，请先分段或压缩；页面录音将自动分段。",
        );
      await destroy();
      const version = ++generation;
      await subtitles.clear();
      subtitles.setMedia(file);
      working = true;
      buttons();
      status("准备发送 " + file.name + "，可能计费…", "starting");
      sessionId = (await rpc("ASR_CREATE")).id;
      lease = chrome.runtime.connect({ name: "bt-media-session" });
      lease.postMessage({ sessionId });
      await addAudio(sessionId, file, { name: file.name });
      await rpc("ASR_RUN", { sessionId });
      await poll(version, file.name);
      working = false;
      buttons();
    });
  $("asr-stop").onclick = () =>
    void action(async () => {
      generation++;
      if (sessionId) await rpc("ASR_CANCEL", { sessionId });
      await subtitles.runner.stop();
      working = false;
      buttons();
      status("已停止。远端可能已经处理或计费。", "cancelled");
    });
  $("asr-retry").onclick = () =>
    void action(async () => {
      if (!sessionId) return;
      const version = ++generation;
      working = true;
      buttons();
      $("asr-retry").disabled = true;
      await rpc("ASR_RUN", { sessionId });
      await poll(version, $("asr-file").files[0]?.name || "AI字幕");
      working = false;
      buttons();
    });
  $("asr-clear").onclick = () =>
    void action(async () => {
      await destroy();
      status("本次音频与识别结果已从本地存储清除。", "idle");
      await subtitles.clear();
    });
  addEventListener("pagehide", () => {
    generation++;
    lease?.disconnect();
  });
  buttons();
  return { destroy };
}
