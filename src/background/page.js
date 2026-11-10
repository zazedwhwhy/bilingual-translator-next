import { fail, publicError } from "../shared/core.js";
export function pageActions(api, { jobs, settings, onError = () => {} }) {
  const controls = new Map();
  let sequence = 0;
  const invalidate = (tabId) => controls.set(tabId, ++sequence);
  async function message(tabId, type, data = {}, documentId) {
    const reply = await api.tabs.sendMessage(
      tabId,
      { channel: "BT_PAGE", type, ...data },
      documentId ? { documentId } : { frameId: 0 },
    );
    if (!reply?.ok)
      throw Object.assign(
        Error(reply?.error?.message || "网页没有响应"),
        reply?.error || { code: "INTERRUPTED" },
      );
    return reply.data;
  }
  async function start(tabId, automatic) {
    const token = ++sequence;
    controls.set(tabId, token);
    const valid = () =>
      controls.get(tabId) === token && (!automatic || automatic.isCurrent());
    const tab = await api.tabs.get(tabId);
    if (!/^https?:/.test(tab.url || ""))
      fail("CONFIG_INVALID", "该页面无法翻译");
    if (automatic && tab.url !== automatic.url) fail("CANCELLED", "页面已跳转");
    const [frame] = await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: async (url) => {
        if (!globalThis.__btNextLoaded) {
          await import(url);
          globalThis.__btNextLoaded = true;
        }
      },
      args: [api.runtime.getURL("src/content/entry.js")],
    });
    if (!valid() || (automatic && frame.documentId !== automatic.documentId))
      fail("CANCELLED", "页面操作已停止或跳转");
    await api.scripting.insertCSS({
      target: { tabId, documentIds: [frame.documentId] },
      files: ["src/content/content.css"],
    });
    if (automatic) {
      const current = await api.tabs.get(tabId);
      if (current.url !== automatic.url) fail("CANCELLED", "页面已跳转");
      if (current.active !== true) fail("AUTO_DEFERRED", "标签页尚未显示");
    }
    const config = await settings.snapshot(),
      publicConfig = await settings.public();
    if (!valid()) fail("CANCELLED", "页面操作已停止");
    if (
      config.configRevision !== publicConfig.configRevision ||
      (automatic &&
        automatic.configRevision !== undefined &&
        config.configRevision !== automatic.configRevision)
    )
      fail("CONFIG_INVALID", "翻译设置已改变，请重新开始");
    const job = jobs.create(
      {
        tabId,
        documentId: frame.documentId,
        frameId: 0,
        ...(automatic ? { automatic: true } : {}),
      },
      config,
    );
    try {
      return await message(
        tabId,
        "INIT",
        { job: { id: job.id, epoch: jobs.epoch, ...publicConfig } },
        frame.documentId,
      );
    } catch (error) {
      jobs.cancel(job.id);
      throw error;
    }
  }
  async function control(type, tabId) {
    let automaticError;
    if (type === "STOP" || type === "RESTORE") invalidate(tabId);
    if (type === "STATUS") {
      const [frame] = await api.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => ({
          loaded: globalThis.__btNextLoaded === true,
          autoError: globalThis.__btNextAutoError,
          autoReason: globalThis.__btNextAutoReason,
        }),
      });
      if (frame?.result?.loaded === false) {
        if (frame.result.autoError)
          return {
            phase: "error",
            error: publicError({ code: frame.result.autoError }),
          };
        return {
          phase:
            frame.result.autoReason === "target_or_unknown"
              ? "skipped_language"
              : "idle",
        };
      }
      if (frame?.result?.loaded !== true)
        fail("INTERRUPTED", "无法读取页面状态");
      automaticError = frame.result.autoError;
    }
    const result = await message(tabId, type);
    if (
      type === "STATUS" &&
      automaticError &&
      ["idle", "cancelled"].includes(result.phase)
    )
      return { phase: "error", error: publicError({ code: automaticError }) };
    return result;
  }
  async function cancelAutomatic() {
    const pending = [];
    for (const job of jobs.jobs.values())
      if (job.binding.automatic && !job.cancelled) {
        invalidate(job.binding.tabId);
        jobs.cancel(job.id);
        pending.push(
          message(job.binding.tabId, "STOP", {}, job.binding.documentId),
        );
      }
    const outcomes = await Promise.allSettled(pending);
    if (outcomes.some((x) => x.status === "rejected"))
      onError("AUTO_PAGE_DISCONNECTED");
  }
  return { start, control, cancelAutomatic };
}
