export function mountCapture({ rpc, subtitles, uploads }) {
  const $ = (id) => document.getElementById(id);
  let sessionId,
    lease,
    generation = 0,
    working = false;
  function status(text, phase) {
    $("capture-status").textContent = text;
    $("capture-status").dataset.phase = phase;
  }
  function buttons() {
    $("capture-start").disabled = working;
    $("capture-retry").disabled = working || !sessionId;
    $("capture-stop").disabled = !working;
    for (const id of [
      "asr-file",
      "asr-start",
      "subtitle-file",
      "subtitle-media-file",
      "subtitle-target",
      "subtitle-target-refresh",
    ])
      $(id).disabled = working;
  }
  async function action(fn) {
    try {
      await fn();
    } catch (error) {
      status((error.code || "CAPTURE_ERROR") + "：" + error.message, "error");
      working = false;
      buttons();
    }
  }
  async function clear() {
    generation++;
    if (sessionId) await rpc("ASR_DELETE", { sessionId });
    lease?.disconnect();
    lease = null;
    sessionId = null;
    working = false;
    buttons();
  }
  async function poll(version, source) {
    let revision = 0;
    while (version === generation) {
      const state = await rpc("ASR_STATUS", { sessionId });
      if (version !== generation) return;
      const media = await rpc("ASR_MEDIA_STATUS");
      const capture = media.capture;
      if (state.revision !== revision && state.cues.length) {
        await subtitles.appendCues(state.cues, "标签页AI字幕");
        if (version !== generation) return;
        revision = state.revision;
      }
      if (subtitles.runner.phase === "complete" && state.cues.length)
        await rpc("VIDEO_APPLY", { ...source, cues: subtitles.cues() });
      const phase = state.phase;
      status(
        (state.recording
          ? "正在录音 · " + Math.floor(capture?.seconds || 0) + " 秒"
          : "录音已停止") +
          " · 已识别 " +
          state.completed +
          "/" +
          state.chunks.length +
          " 段" +
          (state.error
            ? "\n" + state.error.code + "：" + state.error.message
            : "") +
          (subtitles.runner.phase === "paused_budget"
            ? "\n字幕翻译达到本轮上限，请在字幕区继续。"
            : ""),
        phase,
      );
      if (["complete", "error", "cancelled", "interrupted"].includes(phase)) {
        if (phase === "complete" && subtitles.runner.phase === "complete")
          status("标签页AI字幕已完成，可在原视频播放并导出。", "complete");
        working = false;
        buttons();
        return;
      }
      if (
        ["paused_budget", "error", "interrupted"].includes(
          subtitles.runner.phase,
        ) &&
        state.recording
      )
        await rpc("ASR_CAPTURE_STOP", { sessionId });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  $("capture-start").onclick = () =>
    void action(async () => {
      await clear();
      await uploads.destroy();
      await subtitles.clear();
      await subtitles.refreshSource();
      const source = subtitles.source();
      if (!source.tabId || !source.videoId)
        throw Error("请从正在播放视频的标签页点击扩展，再打开工作台。");
      working = true;
      buttons();
      const version = ++generation;
      status("正在请求所选标签页音频，请保持1倍速播放…", "starting");
      sessionId = (await rpc("ASR_CREATE")).id;
      lease = chrome.runtime.connect({ name: "bt-media-session" });
      lease.postMessage({ sessionId });
      await rpc("ASR_CAPTURE_START", { sessionId, ...source });
      await poll(version, source);
    });
  $("capture-stop").onclick = () =>
    void action(async () => {
      if (sessionId) {
        $("capture-stop").disabled = true;
        await rpc("ASR_CAPTURE_STOP", { sessionId });
        status("录音已停止，正在完成已录片段的识别与翻译。", "transcribing");
      }
    });
  $("capture-retry").onclick = () =>
    void action(async () => {
      if (!sessionId) return;
      const version = ++generation;
      working = true;
      buttons();
      status("正在重试已保存的失败片段，可能重复计费…", "transcribing");
      await rpc("ASR_RUN", { sessionId });
      await poll(version, subtitles.source());
    });
  $("capture-clear").onclick = () =>
    void action(async () => {
      await clear();
      await subtitles.clear();
      status("本次录音和识别结果已清除。", "idle");
    });
  addEventListener("pagehide", () => {
    generation++;
    lease?.disconnect();
  });
  buttons();
}
