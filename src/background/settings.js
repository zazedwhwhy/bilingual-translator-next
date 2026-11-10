import { fail } from "../shared/core.js";
import { providers, languages } from "../providers/registry.js";
export class Settings {
  constructor(api) {
    this.api = api;
    this.ready = false;
  }
  async init() {
    await this.api.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    this.ready = true;
  }
  check() {
    if (!this.ready) fail("CONFIG_INVALID", "存储未初始化");
  }
  async public() {
    this.check();
    const { connection: c } = await this.api.storage.local.get("connection");
    if (!c)
      return {
        provider: "google",
        model: "",
        target: "zh-CN",
        source: "auto",
        cacheEnabled: false,
        hasKey: false,
      };
    const { secret, ...rest } = c;
    return { ...rest, hasKey: !!secret };
  }
  async snapshot() {
    this.check();
    const { connection: c } = await this.api.storage.local.get("connection");
    if (!c?.secret) fail("CONFIG_INVALID", "请先配置 API Key");
    if (
      !(await this.api.permissions.contains({
        origins: [providers[c.provider].origin],
      }))
    )
      fail("PERMISSION_MISSING", "请授予服务访问权限");
    return structuredClone(c);
  }
  async save(input) {
    this.check();
    const p = providers[input.provider];
    if (
      !p ||
      !languages.includes(input.target) ||
      (!languages.includes(input.source) && input.source !== "auto")
    )
      fail("CONFIG_INVALID", "配置无效");
    if (
      input.provider !== "google" &&
      (typeof input.model !== "string" ||
        !input.model.trim() ||
        input.model.length > 200)
    )
      fail("CONFIG_INVALID", "模型名无效");
    const { connection: old } = await this.api.storage.local.get("connection");
    const secret =
      input.secret || (old?.provider === input.provider ? old.secret : "");
    if (
      typeof secret !== "string" ||
      !secret.trim() ||
      secret.length > 4096 ||
      /[\r\n]/.test(secret)
    )
      fail("CONFIG_INVALID", "请填写有效 API Key");
    if (!(await this.api.permissions.contains({ origins: [p.origin] })))
      fail("PERMISSION_MISSING", "服务访问权限未授予");
    const c = {
      provider: input.provider,
      model: input.provider === "google" ? "" : input.model.trim(),
      secret: secret.trim(),
      target: input.target,
      source: input.source,
      cacheEnabled: input.cacheEnabled === true,
      configRevision: crypto.randomUUID(),
    };
    await this.api.storage.local.set({ connection: c });
    return this.public();
  }
  async clearKey(provider, cancel) {
    this.check();
    const { connection: c } = await this.api.storage.local.get("connection");
    if (c?.provider === provider) {
      await cancel(provider);
      await this.api.storage.local.set({ connection: { ...c, secret: "" } });
    }
    return this.public();
  }
}
