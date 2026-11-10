import { Learning } from "./background/learning.js";
import { Settings } from "./background/settings.js";
import { Jobs } from "./background/jobs.js";
import { Cache, Diagnostics, indexedStore } from "./background/cache.js";
import { buildRequest, decodeResponse } from "./providers/registry.js";
import { requestJson } from "./background/transport.js";
import { fail, publicError } from "./shared/core.js";
import { videoActions } from "./background/video.js";
import { mediaActions } from "./background/media.js";
import { pageActions } from "./background/page.js";
import { AutoTranslation } from "./background/auto.js";
import { InteractionActions } from "./background/interactions.js";
import { InteractionSettings } from "./background/interaction-settings.js";
const settings = new Settings(chrome),
  ready = settings.init();
ready.catch(() => {});
const diagnostics = new Diagnostics();
let cacheDegraded = false;
const cache = new Cache({
  store: indexedStore(),
  onDegrade: () => {
    cacheDegraded = true;
    diagnostics.record({ code: "CACHE_DEGRADED" });
  },
});
const translate = async (items, c, signal) =>
  decodeResponse(
    await requestJson(buildRequest(items, c), { signal }),
    items,
    c.provider,
  );
const jobs = new Jobs({ translate, cache, diagnostics });
const learning = new Learning(chrome, { settings, jobs });
const learningReady = ready.then(() => learning.sync());
learningReady.catch(() => diagnostics.record({ code: "LEARNING_INIT_FAILED" }));
let interactions;
const quick = new InteractionSettings(chrome, {
  cancel: () => interactions?.cancelAll(),
});
interactions = new InteractionActions(chrome, {
  jobs,
  settings,
  preferences: quick,
  learning,
});
const quickReady = ready
  .then(() => quick.init())
  .catch(() => {
    quick.error = {
      code: "INTERACTION_INIT_FAILED",
      message: "快捷翻译初始化失败，请重新设置。",
    };
    diagnostics.record({ code: "INTERACTION_INIT_FAILED" });
  });
const pages = pageActions(chrome, {
  jobs,
  settings,
  onError: (code) => diagnostics.record({ code }),
});
const automatic = new AutoTranslation(chrome, {
  settings,
  start: pages.start,
  cancel: pages.cancelAutomatic,
});
const autoReady = ready
  .then(() => automatic.init())
  .catch(() => {
    automatic.error = {
      code: "AUTO_INIT_FAILED",
      message: "自动翻译初始化失败，请重新设置。",
    };
    diagnostics.record({ code: "AUTO_INIT_FAILED" });
  });
const handleVideo = videoActions(chrome, { jobs, settings });
const media = mediaActions(chrome, {
  onError: (code) => diagnostics.record({ code }),
  videoMessage: async (tabId, type, data = {}) => {
    const r = await chrome.tabs.sendMessage(
      tabId,
      { channel: "BT_VIDEO", type, ...data },
      { frameId: 0 },
    );
    if (!r?.ok)
      throw Object.assign(
        Error(r?.error?.message || "视频页面已中断"),
        r?.error,
      );
    return r.data;
  },
});
const workspaceSources = new Map();
const isUI = (sender) =>
  sender.id === chrome.runtime.id &&
  ["src/ui/options.html", "src/ui/popup.html"].some(
    (p) => sender.url === chrome.runtime.getURL(p),
  );
async function handle(m, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id) fail("INVALID_MESSAGE", "来源无效");
  if (m.type?.startsWith("LEARN_")) {
    await learningReady;
    try {
      return await learning.handle(m, sender);
    } catch (error) {
      if (!error.code) error.code = "LEARNING_ERROR";
      throw error;
    }
  }
  if (m.type?.startsWith("INTERACTION_")) {
    await quickReady;
    if (m.type === "INTERACTION_CONFIG" || m.type === "INTERACTION_SET") {
      if (!isUI(sender))
        fail("INVALID_MESSAGE", "仅允许扩展界面更改快捷翻译设置");
      const state =
        m.type === "INTERACTION_CONFIG"
          ? quick.state()
          : await quick.set(m.preferences);
      return { ...state, configured: (await settings.public()).hasKey };
    }
    if (m.type === "INTERACTION_READY") {
      interactions.sender(sender);
      const config = await settings.public();
      return {
        ...quick.state(),
        target: config.target,
        configured: config.hasKey,
        learningEnabled: (await learning.store.read()).preferences.enabled,
      };
    }
    const result = await interactions.handle(m, sender);
    return m.type === "INTERACTION_TRANSLATE"
      ? { ...result, cacheDegraded: cacheDegraded && result.cacheEnabled }
      : result;
  }
  if (m.type === "AUTO_PAGE_READY") {
    await autoReady;
    return automatic.handleReady(m, sender);
  }
  if (m.type === "AUTO_CONFIG" || m.type === "AUTO_SET") {
    if (!isUI(sender)) fail("INVALID_MESSAGE", "仅允许扩展界面设置自动翻译");
    await autoReady;
    const state =
      m.type === "AUTO_CONFIG"
        ? automatic.state()
        : await automatic.set(m.enabled);
    return { ...state, configured: (await settings.public()).hasKey };
  }
  if (m.type?.startsWith("ASR_")) return media.handle(m, sender);
  if (m.type?.startsWith("VIDEO_")) {
    if (
      !isUI(sender) &&
      sender.url !== chrome.runtime.getURL("src/ui/workbench.html")
    )
      fail("INVALID_MESSAGE", "仅允许扩展界面控制视频");
    return handleVideo(m);
  }
  if (m.type === "OPEN_WORKBENCH" && isUI(sender)) {
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL("src/ui/workbench.html"),
    });
    if (Number.isInteger(m.tabId)) {
      workspaceSources.set(tab.id, m.tabId);
      await chrome.storage.session.set({
        ["workspaceSource:" + tab.id]: m.tabId,
      });
    }
    return { tabId: tab.id };
  }
  if (m.type?.startsWith("WB_")) {
    const workspaceURL = chrome.runtime.getURL("src/ui/workbench.html");
    if (
      sender.url !== workspaceURL ||
      sender.frameId !== 0 ||
      !sender.documentId
    )
      fail("INVALID_MESSAGE", "仅允许文件工作台执行此操作");
    if (!sender.tab) {
      const contexts = await chrome.runtime.getContexts({
        documentIds: [sender.documentId],
      });
      const context = contexts.find(
        (c) => c.documentUrl === workspaceURL && c.tabId >= 0,
      );
      if (!context) fail("INVALID_MESSAGE", "工作台已关闭");
      sender = { ...sender, tab: { id: context.tabId } };
    }
    if (m.type === "WB_START") {
      if (m.purpose && !["document", "subtitles"].includes(m.purpose))
        fail("INVALID_MESSAGE", "工作台任务类型无效");
      const config = await settings.snapshot();
      const job = jobs.create(
        {
          tabId: sender.tab.id,
          documentId: sender.documentId,
          frameId: 0,
          kind: "workspace:" + (m.purpose || "document"),
          url: workspaceURL,
        },
        config,
      );
      return { id: job.id, epoch: jobs.epoch, ...(await settings.public()) };
    }
    if (m.type === "WB_SOURCE") {
      const key = "workspaceSource:" + sender.tab.id;
      return {
        tabId:
          workspaceSources.get(sender.tab.id) ||
          (await chrome.storage.session.get(key))[key] ||
          null,
      };
    }
    if (m.type === "WB_PREPARE")
      return jobs.prepare(sender, m.jobId, m.paragraphId, m.text);
    if (m.type === "WB_PREPARE_ITEMS")
      return jobs.prepareItems(sender, m.jobId, m.paragraphId, m.items);
    if (m.type === "WB_BATCH")
      return jobs.run(sender, {
        jobId: m.jobId,
        batchId: m.batchId,
        items: m.items,
      });
    if (m.type === "WB_RELEASE") {
      jobs.release(sender, m.jobId, m.paragraphId);
      return {};
    }
    if (m.type === "WB_CONTINUE") return jobs.nextRound(sender, m.jobId);
    if (m.type === "WB_RETRY") {
      jobs.retry(sender, m.jobId);
      return {};
    }
    if (m.type === "WB_CANCEL") {
      jobs.get(sender, m.jobId);
      jobs.cancel(m.jobId);
      return {};
    }
    fail("INVALID_MESSAGE", "未知工作台操作");
  }
  if (isUI(sender)) {
    if (m.type === "CONFIG") return settings.public();
    if (m.type === "SAVE_CONFIG") {
      if (sender.url !== chrome.runtime.getURL("src/ui/options.html"))
        fail("INVALID_MESSAGE", "来源无效");
      const previous = await settings.public();
      const result = await settings.save(m.config);
      learning.cancel();
      interactions.cancelAll();
      await quick
        .broadcast()
        .catch(() =>
          diagnostics.record({ code: "INTERACTION_PAGE_DISCONNECTED" }),
        );
      for (const job of jobs.jobs.values())
        if (job.config.provider === previous.provider) jobs.cancel(job.id);
      const notices = await automatic.configurationChanged();
      if (notices.unreachable)
        diagnostics.record({ code: "AUTO_PAGE_DISCONNECTED" });
      return result;
    }
    if (m.type === "CLEAR_KEY") {
      if (sender.url !== chrome.runtime.getURL("src/ui/options.html"))
        fail("INVALID_MESSAGE", "来源无效");
      const c = await settings.public();
      return settings.clearKey(c.provider, async (p) => {
        learning.cancel();
        interactions.cancelAll();
        for (const j of jobs.jobs.values())
          if (j.config.provider === p) jobs.cancel(j.id);
      });
    }
    if (m.type === "CLEAR_CACHE") {
      await cache.clear();
      cacheDegraded = false;
      return {};
    }
    if (m.type === "DIAGNOSTICS") return diagnostics.export();
    if (m.type === "TEST_CONNECTION") {
      if (sender.url !== chrome.runtime.getURL("src/ui/options.html"))
        fail("INVALID_MESSAGE", "来源无效");
      const c = await settings.snapshot();
      return translate([{ id: "test", text: "Hello, world." }], c);
    }
    if (m.type === "START") {
      return pages.start(m.tabId);
    }
    if (["STATUS", "STOP", "RESTORE", "RETRY", "CONTINUE"].includes(m.type)) {
      if (m.type === "STOP" || m.type === "RESTORE")
        automatic.suppress(m.tabId);
      return { ...(await pages.control(m.type, m.tabId)), cacheDegraded };
    }
    fail("INVALID_MESSAGE", "未知操作");
  } else {
    if (m.type === "PREPARE")
      return jobs.prepare(sender, m.jobId, m.paragraphId, m.text);
    if (m.type === "PREPARE_ITEMS") {
      const job = jobs.get(sender, m.jobId);
      if (job.binding.kind && job.binding.kind !== "video")
        fail("INVALID_MESSAGE", "仅允许网页或字幕批量任务");
      return jobs.prepareItems(sender, m.jobId, m.paragraphId, m.items);
    }
    if (m.type === "BATCH")
      return jobs.run(sender, {
        jobId: m.jobId,
        batchId: m.batchId,
        items: m.items,
      });
    if (m.type === "RELEASE") {
      jobs.release(sender, m.jobId, m.paragraphId);
      return {};
    }
    if (m.type === "RETRY") {
      jobs.retry(sender, m.jobId);
      return {};
    }
    if (m.type === "CONTINUE") return jobs.nextRound(sender, m.jobId);
    if (m.type === "CANCEL") {
      jobs.get(sender, m.jobId);
      jobs.cancel(m.jobId);
      return {};
    }
    fail("INVALID_MESSAGE", "未知操作");
  }
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.channel !== "BT_BG") return;
  handle(m, sender).then(
    (data) => reply({ ok: true, data }),
    (error) => {
      const job = jobs.jobs.get(m.jobId);
      const bound =
        job &&
        sender.tab?.id === job.binding.tabId &&
        sender.documentId === job.binding.documentId &&
        sender.frameId === 0;
      reply({
        ok: false,
        error: publicError(error),
        ...(bound ? { budget: job.budget.snapshot() } : {}),
      });
    },
  );
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bt-next") return;
  let id,
    disconnected = false;
  port.onMessage.addListener((m) => {
    void (async () => {
      let sender = port.sender;
      const workspaceURL = chrome.runtime.getURL("src/ui/workbench.html");
      if (!sender.tab && sender.url === workspaceURL && sender.documentId) {
        const contexts = await chrome.runtime.getContexts({
          documentIds: [sender.documentId],
        });
        const context = contexts.find(
          (c) => c.documentUrl === workspaceURL && c.tabId >= 0,
        );
        if (!context) throw Error("工作台已关闭");
        sender = { ...sender, tab: { id: context.tabId } };
      }
      jobs.get(sender, m.jobId);
      id = m.jobId;
      if (disconnected) jobs.cancel(id);
      else port.postMessage({ epoch: jobs.epoch });
    })().catch(() => port.disconnect());
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (id) jobs.cancel(id);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  learning.pending.get(tabId)?.abort();
  void interactions
    .forget(tabId)
    .catch(() => diagnostics.record({ code: "INTERACTION_CLEANUP_FAILED" }));
  automatic.forget(tabId);
  workspaceSources.delete(tabId);
  void chrome.storage.session.remove("workspaceSource:" + tabId);
  for (const j of jobs.jobs.values())
    if (j.binding.tabId === tabId) jobs.cancel(j.id);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (automatic.enabled)
    void chrome.tabs
      .sendMessage(
        tabId,
        { channel: "BT_AUTO", type: "ACTIVATED" },
        { frameId: 0 },
      )
      .catch(() => {
        /* A tab may not have an automatic bootstrap. */
      });
});
chrome.permissions.onRemoved.addListener(() => {
  learning.cancel();
  void learning
    .sync()
    .catch(() => diagnostics.record({ code: "LEARNING_INIT_FAILED" }));
  void quickReady
    .then(async () => {
      if (
        !(await chrome.permissions.contains({
          origins: ["http://*/*", "https://*/*"],
        }))
      )
        await quick.set({ selection: false, hover: false, input: false });
      else {
        learning.cancel();
        interactions.cancelAll();
        await quick.broadcast();
      }
    })
    .catch(() => diagnostics.record({ code: "INTERACTION_INIT_FAILED" }));
  void ready
    .then(async () => {
      if (
        automatic.enabled &&
        !(await chrome.permissions.contains({
          origins: ["http://*/*", "https://*/*"],
        }))
      )
        await automatic.set(false);
    })
    .catch(() => diagnostics.record({ code: "AUTO_SAVE_FAILED" }));
});
