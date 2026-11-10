import { TabRecorder } from "./capture.js";
import { addAudio, updateSession, getRecord } from "./store.js";
export function captureController({ processSession, stopTask }) {
  let current;
  async function background(type, data) {
    const reply = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type,
      ...data,
    });
    if (!reply?.ok)
      throw Object.assign(
        Error(reply?.error?.message || "录音时钟连接中断"),
        reply?.error,
      );
    return reply.data;
  }
  async function start({ sessionId, streamId, config }) {
    if (current?.recorder.active || current?.starting)
      throw Object.assign(Error("已有标签页正在录音，请先停止。"), {
        code: "CAPTURE_BUSY",
      });
    const row = { sessionId, starting: true };
    current = row;
    row.recorder = new TabRecorder({
      sample: () => background("ASR_CAPTURE_SAMPLE", { sessionId }),
      save: async (blob, metadata) => {
        const session = await getRecord(sessionId);
        if (!session?.recording) return;
        // Bound accumulated private audio and billed requests. No silent discarding.
        if (session.chunks.length >= 120)
          throw Object.assign(
            Error("已达到30分钟录音上限，请停止后新建会话。"),
            { code: "CAPTURE_LIMIT" },
          );
        await addAudio(sessionId, blob, {
          ...metadata,
          name: "tab-audio-" + session.chunks.length + ".webm",
        });
      },
      onStop: async (error) => {
        await updateSession(sessionId, (s) => {
          s.recording = false;
          if (error) {
            s.phase = "error";
            s.error ??= {
              code: error.code || "CAPTURE_ERROR",
              message: error.message,
            };
          }
        }).catch((e) => {
          if (e.code !== "SESSION_GONE") throw e;
        });
        await background("ASR_CAPTURE_UNBIND", { sessionId }).catch(() => {});
        if (error) await stopTask(sessionId);
      },
    });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });
      if (row.recorder.stopping) {
        stream.getTracks().forEach((t) => t.stop());
        throw Object.assign(Error("录音已取消"), { code: "CANCELLED" });
      }
      await updateSession(sessionId, (s) => {
        s.recording = true;
        s.phase = "recording";
        delete s.error;
      });
      await row.recorder.start(stream);
      processSession(sessionId, config);
      return row.recorder.status();
    } catch (error) {
      await row.recorder.stop(error.message, true);
      throw error;
    } finally {
      row.starting = false;
    }
  }
  async function stop(id, { discard = false, reason = "用户停止录音" } = {}) {
    if (current?.sessionId !== id) return {};
    return current.recorder.stop(reason, discard);
  }
  return {
    start,
    stop,
    status: () =>
      current
        ? {
            sessionId: current.sessionId,
            starting: current.starting,
            ...current.recorder.status(),
          }
        : null,
    failed: async (id, error) => {
      if (current?.sessionId === id && current.recorder.active)
        await current.recorder.stop(error.message, true);
    },
  };
}
