import { Budget, fail, length } from "../shared/core.js";
import { AUTO_ORIGINS } from "../shared/auto.js";

class StoredBudget extends Budget {
  constructor(api, key, record) {
    super();
    this.api = api;
    this.key = key;
    if (record) {
      const fields = {
        round: "round",
        used: "segmentsUsed",
        chars: "codePointsUsed",
        total: "lifetimeSegments",
        totalChars: "lifetimeCodePoints",
      };
      for (const [field, stored] of Object.entries(fields)) {
        if (
          !Number.isSafeInteger(record[stored]) ||
          record[stored] < (field === "round" ? 1 : 0)
        )
          fail(
            "INTERACTION_STATE_INVALID",
            "快捷翻译用量记录无效，请重新打开网页。",
          );
        this[field] = record[stored];
      }
    }
    this.saving = Promise.resolve();
  }
  save() {
    const snapshot = this.snapshot();
    const pending = this.saving.then(() =>
      this.api.storage.session.set({ [this.key]: snapshot }),
    );
    this.saving = pending.catch(() => {});
    return pending;
  }
  async dispatch(id, texts) {
    super.dispatch(id, texts);
    // Persist consumed allowance before sending to the provider. A storage
    // failure stops the request, instead of silently resetting the allowance.
    await this.save();
  }
  async continue() {
    super.nextRound();
    await this.save();
  }
}

export class InteractionActions {
  constructor(api, { jobs, settings, preferences, learning }) {
    Object.assign(this, { api, jobs, settings, preferences, learning });
    this.documents = new Map();
  }
  sender(sender) {
    if (
      sender.id !== this.api.runtime.id ||
      !Number.isInteger(sender.tab?.id) ||
      sender.frameId !== 0 ||
      typeof sender.documentId !== "string" ||
      !/^https?:\/\//.test(sender.url || "")
    )
      fail("INVALID_MESSAGE", "快捷翻译页面来源无效");
  }
  document(sender) {
    const key = sender.tab.id + ":" + sender.documentId;
    let state = this.documents.get(key);
    if (!state) {
      for (const old of this.documents.values())
        if (old.tabId === sender.tab.id && old.documentId !== sender.documentId)
          this.stop(old);
      const ledger = "interactionBudget:" + key;
      state = {
        tabId: sender.tab.id,
        documentId: sender.documentId,
        ledger,
        request: null,
        blocked: false,
      };
      state.ready = this.api.storage.session
        .get(ledger)
        .then((rows) => new StoredBudget(this.api, ledger, rows[ledger]));
      state.ready.catch(() => {}); // Cancellation need not consume the pending ledger lookup.
      this.documents.set(key, state);
    }
    return state;
  }
  stop(state, requestId) {
    const request = state.request;
    if (!request || (requestId && request.id !== requestId)) return;
    state.request = null;
    if (request.job) this.jobs.cancel(request.job.id);
  }
  cancelAll() {
    for (const state of this.documents.values()) this.stop(state);
  }
  async forget(tabId) {
    for (const [key, state] of this.documents)
      if (state.tabId === tabId) {
        this.stop(state);
        this.documents.delete(key);
      }
    const rows = await this.api.storage.session.get(null);
    const keys = Object.keys(rows).filter((key) =>
      key.startsWith("interactionBudget:" + tabId + ":"),
    );
    if (keys.length) await this.api.storage.session.remove(keys);
  }
  async checkPage(sender, url) {
    const tab = await this.api.tabs.get(sender.tab.id);
    if (tab.url !== url || !tab.active)
      fail("CANCELLED", "页面已改变或不在前台");
    const [frame] = await this.api.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      func: () => location.href,
    });
    if (frame?.documentId !== sender.documentId || frame.result !== url)
      fail("CANCELLED", "页面已跳转");
  }
  async handle(message, sender) {
    this.sender(sender);
    const state = this.document(sender);
    if (message.type === "INTERACTION_VALIDATE") {
      const config = await this.settings.snapshot();
      if (
        !this.preferences.state().input ||
        config.configRevision !== message.configRevision ||
        this.preferences.state().inputTarget !== message.target
      )
        fail("CONFIG_INVALID", "输入框翻译设置已改变，请重新翻译。");
      await this.checkPage(sender, message.url);
      return {};
    }
    if (message.type === "INTERACTION_CANCEL") {
      if (typeof message.requestId !== "string")
        fail("INVALID_MESSAGE", "缺少请求编号");
      this.stop(state, message.requestId);
      return {};
    }
    if (message.type === "INTERACTION_CONTINUE") {
      if (!state.blocked || state.request)
        fail("INVALID_STATE", "只有额度用尽时才能继续");
      const budget = await state.ready;
      await budget.continue();
      state.blocked = false;
      return { budget: budget.snapshot() };
    }
    if (message.type !== "INTERACTION_TRANSLATE")
      fail("INVALID_MESSAGE", "未知快捷翻译操作");
    const prefs = this.preferences.state();
    if (
      !["selection", "hover", "input"].includes(message.mode) ||
      !prefs[message.mode]
    )
      fail("INTERACTION_DISABLED", "这个翻译入口尚未开启");
    if (
      typeof message.requestId !== "string" ||
      !message.requestId ||
      message.requestId.length > 100 ||
      typeof message.text !== "string" ||
      !message.text.trim() ||
      typeof message.url !== "string"
    )
      fail("INVALID_MESSAGE", "快捷翻译内容无效");
    if (length(message.text) > 6000)
      fail("INTERACTION_TOO_LONG", "一次最多翻译6000字符，请缩小选区。");
    let origin;
    try {
      origin = new URL(sender.url).origin === new URL(message.url).origin;
    } catch {}
    if (!origin) fail("INVALID_MESSAGE", "快捷翻译页面来源不匹配");
    if (state.request?.id === message.requestId) {
      if (
        state.request.text !== message.text ||
        state.request.mode !== message.mode
      )
        fail("INVALID_MESSAGE", "请求编号已用于其它内容");
      return state.request.promise;
    }
    this.stop(state);
    const request = {
      id: message.requestId,
      text: message.text,
      mode: message.mode,
      context:
        typeof message.context === "string"
          ? message.context.slice(0, 2000)
          : "",
      url: message.url,
    };
    state.request = request;
    request.promise = this.execute(state, request, sender);
    return request.promise;
  }
  async execute(state, request, sender) {
    const current = () => {
      if (state.request !== request || !this.preferences.state()[request.mode])
        fail("CANCELLED", "请求已取消");
    };
    const learningEpoch = this.learning?.epoch;
    let job;
    try {
      if (!(await this.api.permissions.contains({ origins: AUTO_ORIGINS })))
        fail("PERMISSION_MISSING", "请先开启快捷翻译并授权网页访问");
      current();
      const budget = await state.ready;
      current();
      const config = await this.settings.snapshot();
      current();
      await this.checkPage(sender, request.url);
      current();
      const connection =
        request.mode === "input"
          ? {
              ...config,
              source: "auto",
              target: this.preferences.state().inputTarget,
            }
          : config;
      job = this.jobs.create(
        {
          tabId: sender.tab.id,
          documentId: sender.documentId,
          frameId: 0,
          kind: "interaction",
        },
        connection,
        budget,
      );
      request.job = job;
      const prepared = await this.jobs.prepare(
        sender,
        job.id,
        request.id,
        request.text,
      );
      current();
      if (prepared.blocked) {
        state.blocked = true;
        fail("BUDGET_EXCEEDED", "本页快捷翻译额度已用尽，请确认后继续下一轮。");
      }
      const results = new Map(prepared.cached.map((row) => [row.id, row.text]));
      await Promise.all(
        prepared.batches.map(async (batch) => {
          const result = await this.jobs.run(sender, {
            jobId: job.id,
            batchId: batch.batchId,
            items: batch.items,
          });
          for (const row of result.translations) results.set(row.id, row.text);
        }),
      );
      current();
      await this.checkPage(sender, request.url);
      current();
      if (
        (await this.settings.snapshot()).configRevision !==
        config.configRevision
      )
        fail("CONFIG_INVALID", "翻译设置已改变");
      current();
      if (prepared.ids.some((id) => !results.has(id)))
        fail("RESPONSE_FORMAT", "译文不完整");
      let learningWarning = "";
      if (
        this.learning &&
        this.learning.epoch === learningEpoch &&
        request.mode !== "input"
      ) {
        try {
          await this.learning.store.record({
            text: request.text,
            translation: prepared.ids.map((id) => results.get(id)).join(""),
            context: request.context,
            url: request.url,
          });
        } catch {
          learningWarning = "学习记录未保存，请到学习页检查存储。";
        }
      }
      return {
        learningWarning,
        translation: prepared.ids.map((id) => results.get(id)).join(""),
        configRevision: config.configRevision,
        cacheEnabled: connection.cacheEnabled,
        target: connection.target,
        cached: prepared.batches.length === 0,
        budget: budget.snapshot(),
      };
    } finally {
      if (job) {
        this.jobs.cancel(job.id);
        this.jobs.jobs.delete(job.id);
      }
      if (state.request === request) state.request = null;
    }
  }
}
