import { fail } from "../shared/core.js";
import {
  AUTO_ORIGINS,
  AUTO_SCRIPT_ID,
  foreignLanguage,
} from "../shared/auto.js";
export class AutoTranslation {
  constructor(api, { settings, start, cancel }) {
    Object.assign(this, { api, settings, start, cancel });
    this.enabled = false;
    this.permission = false;
    this.registered = false;
    this.generation = 0;
    this.documents = new Map();
    this.latest = new Map();
    this.suppressed = new Set();
    this.versions = new Map();
    this.error = null;
  }
  state() {
    return {
      enabled: this.enabled,
      ready: this.enabled && this.permission && this.registered && !this.error,
      permission: this.permission,
      error: this.error,
    };
  }
  async register(enabled) {
    const registered = await this.api.scripting.getRegisteredContentScripts({
      ids: [AUTO_SCRIPT_ID],
    });
    if (enabled && !registered.length)
      await this.api.scripting.registerContentScripts([
        {
          id: AUTO_SCRIPT_ID,
          matches: AUTO_ORIGINS,
          excludeMatches: [
            "https://chromewebstore.google.com/*",
            "https://chrome.google.com/webstore/*",
          ],
          js: ["src/content/auto-entry.js"],
          runAt: "document_idle",
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    if (!enabled && registered.length)
      await this.api.scripting.unregisterContentScripts({
        ids: [AUTO_SCRIPT_ID],
      });
    this.registered = enabled;
  }
  async init() {
    const { autoTranslation } =
      await this.api.storage.local.get("autoTranslation");
    this.enabled = autoTranslation?.enabled === true;
    this.permission =
      this.enabled &&
      (await this.api.permissions.contains({ origins: AUTO_ORIGINS }));
    await this.register(this.enabled && this.permission);
    if (this.enabled && !this.permission)
      this.error = {
        code: "PERMISSION_MISSING",
        message: "自动翻译需要重新授予网页访问权限。",
      };
    return this.state();
  }
  async set(enabled) {
    if (typeof enabled !== "boolean")
      fail("INVALID_MESSAGE", "自动翻译开关无效");
    if (enabled) {
      if (!(await this.api.permissions.contains({ origins: AUTO_ORIGINS })))
        fail("PERMISSION_MISSING", "请授予网页访问权限");
      const old = this.enabled;
      await this.register(true);
      try {
        await this.api.storage.local.set({
          autoTranslation: { enabled: true },
        });
      } catch (error) {
        if (!old) await this.register(false);
        throw error;
      }
      this.enabled = true;
      this.permission = true;
      this.error = null;
      this.documents.clear();
    } else {
      this.enabled = false;
      this.generation++;
      this.error = null;
      await this.cancel();
      try {
        await this.api.storage.local.set({
          autoTranslation: { enabled: false },
        });
        await this.register(false);
      } catch (error) {
        this.error = {
          code: "AUTO_SAVE_FAILED",
          message: "关闭状态尚未保存，请重试；重启扩展后可能恢复原设置。",
        };
        throw error;
      }
    }
    return this.state();
  }
  suppress(tabId) {
    this.versions.set(tabId, (this.versions.get(tabId) || 0) + 1);
    const current = this.latest.get(tabId);
    if (current) this.suppressed.add(current.key);
  }
  forget(tabId) {
    this.suppress(tabId);
    this.latest.delete(tabId);
  }
  async configurationChanged() {
    const notices = [];
    for (const [tabId, page] of this.latest)
      if (this.documents.get(page.key)?.reason === "configuration") {
        this.documents.delete(page.key);
        notices.push(
          this.api.tabs.sendMessage(
            tabId,
            { channel: "BT_AUTO", type: "CONFIGURATION_CHANGED" },
            { documentId: page.documentId },
          ),
        );
      }
    const results = await Promise.allSettled(notices);
    return {
      unreachable: results.filter((x) => x.status === "rejected").length,
    };
  }
  async handleReady(message, sender) {
    if (
      sender.id !== this.api.runtime.id ||
      !Number.isInteger(sender.tab?.id) ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      typeof message.url !== "string" ||
      message.url.length > 8192 ||
      !/^https?:\/\//.test(message.url) ||
      typeof message.sample !== "string" ||
      message.sample.length > 4000 ||
      typeof message.declared !== "string" ||
      message.declared.length > 64
    )
      fail("INVALID_MESSAGE", "自动翻译页面来源无效");
    // Chrome's sender URL can retain the document's original URL after pushState.
    // The start controller checks the actual tab URL and exact documentId again.
    let sameOrigin = false;
    try {
      sameOrigin = new URL(sender.url).origin === new URL(message.url).origin;
    } catch {}
    if (!sameOrigin) fail("INVALID_MESSAGE", "自动翻译页面来源无效");
    if (!this.enabled) return { started: false, reason: "disabled" };
    this.permission = await this.api.permissions.contains({
      origins: AUTO_ORIGINS,
    });
    if (!this.permission) return { started: false, reason: "permission" };
    const tabId = sender.tab.id,
      key = tabId + ":" + sender.documentId + ":" + message.url;
    if (this.documents.has(key) || this.suppressed.has(key))
      return { started: false, reason: "already_checked" };
    const epoch = this.generation,
      version = this.versions.get(tabId) || 0,
      valid = () =>
        this.enabled &&
        epoch === this.generation &&
        version === (this.versions.get(tabId) || 0) &&
        !this.suppressed.has(key);
    this.documents.set(key, true);
    this.latest.set(tabId, {
      key,
      url: message.url,
      documentId: sender.documentId,
    });
    if (this.documents.size > 256)
      this.documents.delete(this.documents.keys().next().value);
    const config = await this.settings.public();
    if (!config.hasKey) {
      this.documents.set(key, { reason: "configuration" });
      return { started: false, reason: "configuration" };
    }
    const detected = await this.api.i18n.detectLanguage(message.sample);
    if (!valid()) return { started: false, reason: "cancelled" };
    if (
      !foreignLanguage({
        declared: message.declared,
        sample: message.sample,
        target: config.target,
        detected,
      })
    )
      return { started: false, reason: "target_or_unknown" };
    try {
      await this.start(tabId, {
        documentId: sender.documentId,
        url: message.url,
        configRevision: config.configRevision,
        isCurrent: valid,
      });
      return { started: valid(), reason: valid() ? "started" : "cancelled" };
    } catch (error) {
      if (error.code === "AUTO_DEFERRED") {
        this.documents.delete(key);
        return { started: false, reason: "background" };
      }
      if (error.code === "CANCELLED" || error.code === "VIDEO_CHANGED")
        return { started: false, reason: "cancelled" };
      throw error;
    }
  }
}
