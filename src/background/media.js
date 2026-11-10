import { validateAsrConfig, publicAsrConfig } from "../media/asr.js";
import {
  getRecord,
  putRecord,
  removeSession,
  updateSession,
} from "../media/store.js";
import { mergeTranscripts } from "../subtitles/cues.js";
import { fail } from "../shared/core.js";
export function mediaActions(api, { videoMessage, onError = () => {} } = {}) {
  let creating,
    configVersion = 0,
    changingConfig = false;
  async function ensureOffscreen() {
    const url = api.runtime.getURL("src/media/offscreen.html");
    const contexts = await api.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length) return;
    if (!creating)
      creating = api.offscreen
        .createDocument({
          url: "src/media/offscreen.html",
          reasons: ["BLOBS", "USER_MEDIA"],
          justification:
            "Process user-selected audio and explicitly requested tab recordings locally before transcription",
        })
        .finally(() => (creating = null));
    await creating;
  }
  async function offscreen(type, data = {}, version) {
    if (version !== undefined && (changingConfig || version !== configVersion))
      fail("ASR_CONFIG_CHANGED", "语音配置已改变，请重新开始");
    await ensureOffscreen();
    if (version !== undefined && (changingConfig || version !== configVersion))
      fail("ASR_CONFIG_CHANGED", "语音配置已改变，请重新开始");
    const reply = await api.runtime.sendMessage({
      channel: "BT_MEDIA",
      type,
      ...data,
    });
    if (!reply?.ok)
      throw Object.assign(
        Error(reply?.error?.message || "音频处理页没有响应"),
        reply?.error || { code: "INTERRUPTED" },
      );
    return reply.data;
  }
  async function config() {
    if (changingConfig)
      fail("ASR_CONFIG_CHANGED", "语音配置正在保存，请稍后重试");
    const { asrConnection } = await api.storage.local.get("asrConnection");
    if (changingConfig)
      fail("ASR_CONFIG_CHANGED", "语音配置正在保存，请稍后重试");
    if (!asrConnection?.secret)
      fail("ASR_CONFIG_INVALID", "请先配置语音识别API");
    const value = validateAsrConfig(asrConnection);
    if (!(await api.permissions.contains({ origins: [value.origin] })))
      fail("PERMISSION_MISSING", "请授权访问语音服务");
    return value;
  }
  async function changeConfig(write) {
    if (changingConfig)
      fail("ASR_CONFIG_CHANGED", "语音配置正在保存，请稍后重试");
    changingConfig = true;
    configVersion++;
    try {
      const contexts = await api.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [api.runtime.getURL("src/media/offscreen.html")],
      });
      if (contexts.length) await offscreen("ASR_STOP_ALL");
      await write();
    } finally {
      changingConfig = false;
    }
  }
  async function owner(sender, id) {
    const session = await getRecord(id);
    if (
      !session ||
      session.kind !== "session" ||
      session.ownerDocumentId !== sender.documentId ||
      session.ownerURL !== sender.url
    )
      fail("INVALID_MESSAGE", "音频会话不属于当前页面");
    return session;
  }
  async function handle(message, sender) {
    const offscreenURL = api.runtime.getURL("src/media/offscreen.html");
    if (
      message.type === "ASR_CAPTURE_SAMPLE" ||
      message.type === "ASR_CAPTURE_UNBIND"
    ) {
      if (sender.url !== offscreenURL || sender.id !== api.runtime.id)
        fail("INVALID_MESSAGE", "录音来源无效");
      const session = await getRecord(message.sessionId);
      if (!session?.capture) fail("SESSION_GONE", "录音会话已关闭");
      return videoMessage(
        session.capture.tabId,
        message.type === "ASR_CAPTURE_SAMPLE"
          ? "CAPTURE_SAMPLE"
          : "CAPTURE_UNBIND",
        { sessionId: session.id },
      );
    }
    if (message.type === "ASR_CAPTURE_SIGNAL") {
      const session = await getRecord(message.sessionId);
      if (
        !session?.capture ||
        sender.tab?.id !== session.capture.tabId ||
        sender.documentId !== session.capture.documentId ||
        sender.frameId !== 0
      )
        fail("INVALID_MESSAGE", "录音页面来源无效");
      return offscreen("CAPTURE_STOP", {
        sessionId: session.id,
        discard: true,
        reason: message.reason || "视频时钟已改变",
      });
    }
    const optionsURL = api.runtime.getURL("src/ui/options.html"),
      workspaceURL = api.runtime.getURL("src/ui/workbench.html");
    if (
      ![optionsURL, workspaceURL].includes(sender.url) ||
      sender.frameId !== 0
    )
      fail("INVALID_MESSAGE", "仅允许可信扩展页面操作音频");
    if (message.type === "ASR_CONFIG") {
      const { asrConnection } = await api.storage.local.get("asrConnection");
      return publicAsrConfig(asrConnection);
    }
    if (message.type === "ASR_SAVE") {
      if (sender.url !== optionsURL)
        fail("INVALID_MESSAGE", "只允许设置页保存密钥");
      const { asrConnection: old } =
        await api.storage.local.get("asrConnection");
      const input = {
          ...message.config,
          secret:
            message.config.secret ||
            (message.config.endpoint === old?.endpoint ? old.secret : ""),
        },
        value = validateAsrConfig(input);
      if (!(await api.permissions.contains({ origins: [value.origin] })))
        fail("PERMISSION_MISSING", "语音服务权限未授予");
      await changeConfig(() => api.storage.local.set({ asrConnection: value }));
      return publicAsrConfig(value);
    }
    if (message.type === "ASR_CLEAR_KEY") {
      if (sender.url !== optionsURL)
        fail("INVALID_MESSAGE", "只允许设置页清除密钥");
      await changeConfig(async () => {
        const { asrConnection: old } =
          await api.storage.local.get("asrConnection");
        if (old)
          await api.storage.local.set({
            asrConnection: { ...old, secret: "" },
          });
      });
      return { hasKey: false };
    }
    if (sender.url !== workspaceURL || !sender.documentId)
      fail("INVALID_MESSAGE", "只允许工作台处理音频");
    if (message.type === "ASR_CREATE") {
      const id = crypto.randomUUID();
      await putRecord({
        id,
        kind: "session",
        ownerDocumentId: sender.documentId,
        ownerURL: sender.url,
        created: Date.now(),
        phase: "ready",
        revision: 0,
        chunks: [],
      });
      return { id };
    }
    if (message.type === "ASR_MEDIA_STATUS") {
      const contexts = await api.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenURL],
      });
      return contexts.length
        ? offscreen("MEDIA_STATUS")
        : { active: [], capture: null };
    }
    let session = await owner(sender, message.sessionId);
    if (message.type === "ASR_CAPTURE_START") {
      const version = configVersion,
        value = await config();
      if (session.chunks.length || session.recording)
        fail("CAPTURE_BUSY", "请先清除旧音频，再创建录音会话");
      // The action invocation grants activeTab; Chrome refuses this request otherwise.
      const streamId = await api.tabCapture.getMediaStreamId({
        targetTabId: message.tabId,
      });
      try {
        const [frame] = await api.scripting.executeScript({
          target: { tabId: message.tabId, frameIds: [0] },
          func: () => true,
        });
        await updateSession(session.id, (s) => {
          s.capture = {
            tabId: message.tabId,
            videoId: message.videoId,
            documentId: frame.documentId,
          };
        });
        await videoMessage(message.tabId, "CAPTURE_BIND", {
          sessionId: session.id,
          videoId: message.videoId,
        });
        return await offscreen(
          "CAPTURE_START",
          {
            sessionId: session.id,
            streamId,
            config: value,
          },
          version,
        );
      } catch (error) {
        await videoMessage(message.tabId, "CAPTURE_UNBIND", {
          sessionId: session.id,
        }).catch(() => {});
        throw error;
      }
    }
    if (message.type === "ASR_CAPTURE_STOP")
      return offscreen("CAPTURE_STOP", { sessionId: session.id });
    if (message.type === "ASR_RUN") {
      if (["transcribing", "recording"].includes(session.phase)) {
        const contexts = await api.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [offscreenURL],
        });
        const live = contexts.length
          ? await offscreen("MEDIA_STATUS")
          : { active: [] };
        if (live.active.includes(session.id)) return { accepted: true };
        await updateSession(session.id, (s) => {
          s.recording = false;
          s.phase = "interrupted";
          s.error = {
            code: "INTERRUPTED",
            message: "语音任务已中断，请显式重试，远端可能已处理。",
          };
        });
        fail("INTERRUPTED", "语音任务已中断，请显式重试，远端可能已处理。");
      }
      const version = configVersion,
        value = await config();
      return offscreen(
        "ASR_RUN",
        { sessionId: session.id, config: value },
        version,
      );
    }
    if (message.type === "ASR_STATUS") {
      if (["transcribing", "recording"].includes(session.phase)) {
        const contexts = await api.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [offscreenURL],
        });
        const live = contexts.length
          ? await offscreen("MEDIA_STATUS")
          : { active: [] };
        if (!live.active.includes(session.id))
          session = await updateSession(session.id, (s) => {
            s.recording = false;
            s.phase = "interrupted";
            s.error = {
              code: "INTERRUPTED",
              message: "音频处理已中断，请重新开始；远端可能已经处理。",
            };
          });
      }
      const complete = session.chunks.filter(
        (chunk) => chunk.state === "complete",
      );
      return {
        id: session.id,
        phase: session.phase,
        error: session.error,
        revision: session.revision,
        chunks: session.chunks.map(({ cues, ...meta }) => meta),
        cues: mergeTranscripts(
          complete.map((chunk) => ({
            id: chunk.id,
            offset: chunk.offset,
            cues: chunk.cues,
          })),
        ),
        completed: complete.length,
        recording: !!session.recording,
        capture: session.capture,
      };
    }
    if (message.type === "ASR_CANCEL") {
      await offscreen("ASR_CANCEL", { sessionId: session.id });
      return {};
    }
    if (message.type === "ASR_DELETE") {
      try {
        const contexts = await api.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [offscreenURL],
        });
        if (contexts.length)
          await offscreen("ASR_CANCEL", { sessionId: session.id });
      } finally {
        await removeSession(session.id);
      }
      return {};
    }
    fail("INVALID_MESSAGE", "未知语音操作");
  }
  api.runtime.onConnect.addListener((port) => {
    if (port.name !== "bt-media-session") return;
    let id,
      disconnected = false;
    port.onMessage.addListener((message) => {
      void owner(port.sender, message.sessionId).then(
        () => {
          id = message.sessionId;
          if (disconnected)
            void handle(
              { type: "ASR_DELETE", sessionId: id },
              port.sender,
            ).catch(() => onError("MEDIA_CLEANUP_FAILED"));
        },
        () => port.disconnect(),
      );
    });
    port.onDisconnect.addListener(() => {
      disconnected = true;
      if (id)
        void handle({ type: "ASR_DELETE", sessionId: id }, port.sender).catch(
          () => onError("MEDIA_CLEANUP_FAILED"),
        );
    });
  });
  api.runtime.onConnect.addListener((port) => {
    if (port.name !== "bt-capture-source") return;
    let id,
      closed = false;
    const stop = async () => {
      const s = await getRecord(id);
      if (
        s?.capture?.tabId === port.sender.tab?.id &&
        s.capture.documentId === port.sender.documentId
      )
        await offscreen("CAPTURE_STOP", {
          sessionId: id,
          discard: true,
          reason: "原视频页面已离开",
        });
    };
    port.onMessage.addListener((message) => {
      id = message.sessionId;
      if (closed) void stop().catch(() => {});
    });
    port.onDisconnect.addListener(() => {
      closed = true;
      if (id) void stop().catch(() => {});
    });
  });
  return { handle, offscreen };
}
