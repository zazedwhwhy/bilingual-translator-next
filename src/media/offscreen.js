import { transcribeBlob } from "./asr.js";
import { getRecord, updateSession } from "./store.js";
import { captureController } from "./capture-controller.js";
const tasks = new Map();
function trusted(sender) {
  return (
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    (sender.url === chrome.runtime.getURL("src/background.js") ||
      (!sender.url &&
        sender.origin === "chrome-extension://" + chrome.runtime.id))
  );
}
function processSession(id, config) {
  if (tasks.has(id)) return;
  const controller = new AbortController(),
    task = { controller };
  tasks.set(id, task);
  const check = () => {
    if (controller.signal.aborted)
      throw Object.assign(Error("识别已停止"), { code: "CANCELLED" });
  };
  task.promise = (async () => {
    try {
      await updateSession(id, (s) => {
        s.phase = s.recording ? "recording" : "transcribing";
        delete s.error;
      });
      while (true) {
        check();
        const session = await getRecord(id);
        if (!session)
          throw Object.assign(Error("会话已关闭"), { code: "SESSION_GONE" });
        const chunk = session.chunks.find((c) => c.state !== "complete");
        if (!chunk) {
          if (session.recording) {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          await updateSession(id, (s) => {
            s.phase = "complete";
            delete s.error;
          });
          return;
        }
        await updateSession(id, (s) => {
          s.chunks.find((c) => c.id === chunk.id).state = "transcribing";
        });
        const record = await getRecord(chunk.id);
        if (!record?.blob)
          throw Object.assign(Error("音频文件已被删除"), {
            code: "AUDIO_INVALID",
          });
        try {
          const cues = await transcribeBlob(
            record.blob,
            { ...config, name: record.name },
            { signal: controller.signal, duration: record.duration },
          );
          check();
          await updateSession(id, (s) => {
            const target = s.chunks.find((c) => c.id === chunk.id);
            target.cues = cues;
            target.state = "complete";
            delete target.error;
            s.revision++;
          });
        } catch (error) {
          await updateSession(id, (s) => {
            const target = s.chunks.find((c) => c.id === chunk.id);
            target.state = "error";
            target.error = {
              code: error.code || "ASR_ERROR",
              message: error.message,
            };
          });
          throw error;
        }
      }
    } catch (error) {
      if (error.code !== "SESSION_GONE")
        await updateSession(id, (s) => {
          if (error.code === "CANCELLED" && s.error) {
            s.phase = "error";
            return;
          }
          s.phase = error.code === "CANCELLED" ? "cancelled" : "error";
          s.error = { code: error.code || "ASR_ERROR", message: error.message };
        }).catch((storageError) => {
          if (storageError.code !== "SESSION_GONE") throw storageError;
        });
      await captures?.failed(id, error);
    } finally {
      if (tasks.get(id) === task) tasks.delete(id);
    }
  })();
  // Keep the terminal failure observable through MEDIA_STATUS even if persistence fails.
  task.promise.catch((error) => {
    lastError = {
      code: error.code || "MEDIA_STORAGE_ERROR",
      message: error.message,
    };
  });
}
let lastError;
let captures;
captures = captureController({
  processSession,
  stopTask: (id) => tasks.get(id)?.controller.abort(),
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.channel !== "BT_MEDIA" || !trusted(sender)) return;
  const handle = async () => {
    if (message.type === "ASR_RUN") {
      await processSession(message.sessionId, message.config);
      return { accepted: true };
    }
    if (message.type === "ASR_CANCEL") {
      await captures.stop(message.sessionId, {
        discard: true,
        reason: "识别已取消",
      });
      const task = tasks.get(message.sessionId);
      task?.controller.abort();
      await task?.promise;
      return { cancelled: true };
    }
    if (message.type === "ASR_STOP_ALL") {
      const capture = captures.status();
      if (capture?.active || capture?.starting)
        await captures.stop(capture.sessionId, {
          discard: true,
          reason: "语音配置已更改",
        });
      for (const task of tasks.values()) task.controller.abort();
      await Promise.allSettled([...tasks.values()].map((task) => task.promise));
      return {};
    }
    if (message.type === "CAPTURE_START") return captures.start(message);
    if (message.type === "CAPTURE_STOP")
      return captures.stop(message.sessionId, message);
    if (message.type === "MEDIA_STATUS")
      return {
        active: [...tasks.keys()],
        capture: captures?.status(),
        error: lastError,
      };
    throw Error("未知音频操作");
  };
  handle().then(
    (data) => reply({ ok: true, data }),
    (error) =>
      reply({
        ok: false,
        error: { code: error.code || "MEDIA_ERROR", message: error.message },
      }),
  );
  return true;
});
