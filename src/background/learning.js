import { LearningStore } from "../learning/store.js";
import { learningRequest, learningResponse } from "../learning/ai.js";
import { requestJson } from "./transport.js";
const origins = ["http://*/*", "https://*/*"];
export class Learning {
  constructor(api, { settings, jobs }) {
    Object.assign(this, { api, settings, jobs });
    this.store = new LearningStore(api.storage.local);
    this.pending = new Map();
    this.epoch = 0;
  }
  async sync() {
    const { preferences: p } = await this.store.read();
    const [registered] = await this.api.scripting.getRegisteredContentScripts({
      ids: ["bt-learning"],
    });
    const enabled =
      p.enabled && (await this.api.permissions.contains({ origins }));
    if (enabled && !registered)
      await this.api.scripting.registerContentScripts([
        {
          id: "bt-learning",
          matches: origins,
          excludeMatches: [
            "https://chromewebstore.google.com/*",
            "https://chrome.google.com/webstore/*",
          ],
          js: ["src/content/learning-bootstrap.js"],
          runAt: "document_idle",
        },
      ]);
    if (!enabled && registered)
      await this.api.scripting.unregisterContentScripts({
        ids: ["bt-learning"],
      });
  }
  cancel() {
    this.epoch++;
    for (const c of this.pending.values()) c.abort();
    this.pending.clear();
  }
  ui(sender) {
    return (
      sender.id === this.api.runtime.id &&
      ["src/ui/learning.html", "src/ui/options.html", "src/ui/popup.html"].some(
        (p) => sender.url === this.api.runtime.getURL(p),
      )
    );
  }
  page(sender) {
    if (
      sender.id !== this.api.runtime.id ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      !Number.isInteger(sender.tab?.id) ||
      !/^https?:\/\//.test(sender.url ?? "")
    )
      throw Error("学习消息来源无效");
  }
  async current(sender, url) {
    this.page(sender);
    const tab = await this.api.tabs.get(sender.tab.id);
    if (
      !tab.active ||
      tab.url !== url ||
      new URL(sender.url).origin !== new URL(url).origin
    )
      throw Error("页面已切换");
    const [frame] = await this.api.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      func: () => location.href,
    });
    if (frame?.result !== url) throw Error("页面已跳转");
  }
  async handle(m, sender) {
    const ui = this.ui(sender);
    if (!ui) this.page(sender);
    if (m.type === "LEARN_GET") return this.store.read();
    if (m.type === "LEARN_OPEN") {
      await this.api.tabs.create({
        url: this.api.runtime.getURL("src/ui/learning.html"),
      });
      return {};
    }
    if (m.type === "LEARN_SET") {
      if (!ui) throw Error("仅设置页可修改学习设置");
      if (
        m.preferences?.enabled &&
        !(await this.api.permissions.contains({ origins }))
      )
        throw Error("请授予网页访问权限");
      this.cancel();
      await this.store.configure(m.preferences);
      await this.sync();
      const tabs = await this.api.tabs.query({ url: origins });
      const results = await Promise.allSettled(
        tabs.map((t) =>
          this.api.scripting.executeScript({
            target: { tabId: t.id, frameIds: [0] },
            files: ["src/content/learning-bootstrap.js"],
          }),
        ),
      );
      return {
        unreachable: results.filter((r) => r.status === "rejected").length,
      };
    }
    if (m.type === "LEARN_IMPORT" || m.type === "LEARN_CLEAR") {
      if (!ui) throw Error("仅学习管理页可导入或清空");
      this.cancel();
      return m.type === "LEARN_IMPORT"
        ? this.store.import(m.data)
        : this.store.clear();
    }
    const state = await this.store.read();
    if (!state.preferences.enabled && !ui) throw Error("学习模式已关闭");
    if (m.type === "LEARN_UPDATE") return this.store.update(m.id, m.action);
    if (m.type === "LEARN_REVIEW") return this.store.review(m.id, m.rating);
    if (m.type === "LEARN_ADD") {
      if (!ui) await this.current(sender, m.url);
      return this.store.record({
        ...m.record,
        url: ui ? m.record.url : m.url,
        learning: true,
      });
    }
    if (m.type === "LEARN_CANCEL") {
      this.pending.get(sender.tab?.id)?.abort();
      return {};
    }
    if (m.type !== "LEARN_AI" || ui) throw Error("未知学习操作");
    await this.current(sender, m.url);
    if (
      typeof m.source !== "string" ||
      !m.source.trim() ||
      m.source.length > 20000
    )
      throw Error("请选取不超过20000字符的正文");
    if (!["recommend", "explain", "exercise"].includes(m.kind))
      throw Error("学习操作无效");
    if (this.pending.has(sender.tab.id))
      throw Error("当前学习分析尚未结束，请稍后再试");
    const token = this.epoch,
      controller = new AbortController();
    this.pending.set(sender.tab.id, controller);
    let acquired = false;
    try {
      const config = await this.settings.snapshot();
      const spec = learningRequest(m.kind, m.source, state.preferences, config);
      await this.jobs.slot(controller.signal, -1);
      acquired = true;
      if (token !== this.epoch) throw Error("学习设置已改变");
      await this.current(sender, m.url);
      const data = await requestJson(spec, { signal: controller.signal });
      if (
        token !== this.epoch ||
        controller.signal.aborted ||
        (await this.settings.snapshot()).configRevision !==
          config.configRevision
      )
        throw Error("学习操作已取消或连接已改变");
      await this.current(sender, m.url);
      return learningResponse(m.kind, data, config.provider, m.source);
    } finally {
      if (acquired) this.jobs.free();
      if (this.pending.get(sender.tab.id) === controller)
        this.pending.delete(sender.tab.id);
    }
  }
}
