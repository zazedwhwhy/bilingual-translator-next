import { fail } from "../shared/core.js";
import { languages } from "../providers/registry.js";
import { AUTO_ORIGINS } from "../shared/auto.js";
const scriptId = "bt-next-quick-translation";
const initial = {
  selection: false,
  hover: false,
  input: false,
  inputTarget: "en",
};
const enabled = (prefs) => prefs.selection || prefs.hover || prefs.input;
export class InteractionSettings {
  constructor(api, { cancel = () => {} } = {}) {
    this.api = api;
    this.cancel = cancel;
    this.preferences = { ...initial };
    this.permission = false;
    this.error = null;
    this.saving = Promise.resolve();
  }
  state() {
    return {
      ...this.preferences,
      permission: this.permission,
      ready: !!enabled(this.preferences) && this.permission && !this.error,
      error: this.error,
    };
  }
  async register(install) {
    const rows = await this.api.scripting.getRegisteredContentScripts({
      ids: [scriptId],
    });
    if (install && !rows.length)
      await this.api.scripting.registerContentScripts([
        {
          id: scriptId,
          matches: AUTO_ORIGINS,
          excludeMatches: [
            "https://chromewebstore.google.com/*",
            "https://chrome.google.com/webstore/*",
          ],
          js: ["src/content/interaction-bootstrap.js"],
          runAt: "document_idle",
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    if (!install && rows.length)
      await this.api.scripting.unregisterContentScripts({ ids: [scriptId] });
  }
  validate(patch) {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => !(key in initial))
    )
      fail("CONFIG_INVALID", "快捷翻译设置无效");
    for (const [key, value] of Object.entries(patch))
      if (
        key === "inputTarget"
          ? !languages.includes(value)
          : typeof value !== "boolean"
      )
        fail("CONFIG_INVALID", "快捷翻译设置无效");
  }
  async init() {
    const { quickTranslation } =
      await this.api.storage.local.get("quickTranslation");
    if (quickTranslation) {
      this.validate(quickTranslation);
      this.preferences = { ...initial, ...quickTranslation };
    }
    this.permission = await this.api.permissions.contains({
      origins: AUTO_ORIGINS,
    });
    await this.register(!!enabled(this.preferences) && this.permission);
    if (enabled(this.preferences) && !this.permission)
      this.error = {
        code: "PERMISSION_MISSING",
        message: "快捷翻译需要重新授予网页访问权限。",
      };
    return this.state();
  }
  set(patch) {
    const pending = this.saving.then(() => this.save(patch));
    this.saving = pending.catch(() => {});
    return pending;
  }
  async save(patch) {
    this.validate(patch);
    const permission = await this.api.permissions.contains({
      origins: AUTO_ORIGINS,
    });
    if (
      Object.entries(patch).some(
        ([key, value]) => key !== "inputTarget" && value === true,
      ) &&
      !permission
    )
      fail("PERMISSION_MISSING", "请授予网页访问权限");
    const previous = this.preferences,
      next = { ...previous, ...patch };
    await this.register(!!enabled(next) && permission);
    try {
      await this.api.storage.local.set({ quickTranslation: next });
    } catch (error) {
      try {
        await this.register(!!enabled(previous) && permission);
      } catch (cleanup) {
        this.error = {
          code: "INTERACTION_INIT_FAILED",
          message: "快捷翻译注册状态需要检查，请重新设置。",
        };
        error.cause ??= cleanup;
      }
      throw error;
    }
    this.cancel();
    this.preferences = next;
    this.permission = permission;
    this.error =
      enabled(next) && !permission
        ? {
            code: "PERMISSION_MISSING",
            message: "快捷翻译需要重新授予网页访问权限。",
          }
        : null;
    await this.broadcast();
    return this.state();
  }
  async broadcast() {
    const tabs = await this.api.tabs.query({ url: AUTO_ORIGINS });
    const results = await Promise.allSettled(
      tabs.map(async (tab) => {
        if (
          /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(
            tab.url || "",
          )
        )
          return;
        if (enabled(this.preferences) && this.permission)
          await this.api.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            files: ["src/content/interaction-bootstrap.js"],
          });
        else
          await this.api.tabs.sendMessage(
            tab.id,
            { channel: "BT_INTERACTION", type: "CONFIG_CHANGED" },
            { frameId: 0 },
          );
      }),
    );
    return {
      unreachable: results.filter((row) => row.status === "rejected").length,
    };
  }
}
