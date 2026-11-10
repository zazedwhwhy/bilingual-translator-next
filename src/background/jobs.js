import {
  Budget,
  Failure,
  fail,
  length,
  splitText,
  batches,
  validateBatch,
} from "../shared/core.js";
const fatalCodes = [
  "AUTH_FAILED",
  "QUOTA_EXCEEDED",
  "PERMISSION_MISSING",
  "CONFIG_INVALID",
];
const pauseCodes = ["NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "RATE_LIMITED"];
export class Jobs {
  constructor({ translate, cache, diagnostics }) {
    Object.assign(this, { translate, cache, diagnostics });
    this.jobs = new Map();
    this.active = 0;
    this.waiters = [];
    this.epoch = crypto.randomUUID();
  }
  create(binding, config, budget = new Budget()) {
    for (const job of this.jobs.values())
      if (
        job.binding.tabId === binding.tabId &&
        job.binding.kind === binding.kind
      )
        this.cancel(job.id);
    const job = {
      id: crypto.randomUUID(),
      binding,
      config: structuredClone(config),
      budget,
      batches: new Map(),
      preparations: new Map(),
      cancelled: false,
      halted: null,
      retryAt: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }
  get(sender, id) {
    const job = this.jobs.get(id);
    if (!job) fail("INTERRUPTED", "任务未知");
    if (
      sender.tab?.id !== job.binding.tabId ||
      sender.documentId !== job.binding.documentId ||
      sender.frameId !== 0 ||
      (job.binding.kind?.startsWith("workspace") &&
        sender.url !== job.binding.url)
    )
      fail("INVALID_MESSAGE", "来源不匹配");
    if (job.cancelled) fail("CANCELLED", "任务已停止");
    return job;
  }
  async prepare(sender, id, paragraphId, text) {
    const j = this.get(sender, id);
    if (j.halted) fail(j.halted, "请先手动重试");
    if (
      typeof paragraphId !== "string" ||
      paragraphId.length > 200 ||
      typeof text !== "string" ||
      !text.trim()
    )
      fail("INVALID_MESSAGE", "段落无效");
    if (length(text) > 60000) fail("SEGMENT_TOO_LARGE", "段落过长");
    if (j.preparations.has(paragraphId)) return j.preparations.get(paragraphId);
    const task = this.prepareNew(j, paragraphId, text);
    j.preparations.set(paragraphId, task);
    try {
      return await task;
    } catch (e) {
      j.preparations.delete(paragraphId);
      throw e;
    }
  }
  async prepareItems(sender, id, paragraphId, items) {
    const job = this.get(sender, id);
    if (job.halted) fail(job.halted, "请先手动重试");
    if (typeof paragraphId !== "string" || paragraphId.length > 200)
      fail("INVALID_MESSAGE", "段落编号无效");
    validateBatch({ jobId: id, batchId: paragraphId, items });
    if (items.some((item) => item.id.length > 200 || length(item.text) > 1200))
      fail("INVALID_MESSAGE", "字幕片段过长");
    if (job.preparations.has(paragraphId))
      return job.preparations.get(paragraphId);
    const task = this.prepareNew(
      job,
      paragraphId,
      null,
      items.map(({ id, text }) => ({ id, text })),
    );
    job.preparations.set(paragraphId, task);
    try {
      return await task;
    } catch (error) {
      job.preparations.delete(paragraphId);
      throw error;
    }
  }
  async prepareNew(j, paragraphId, text, providedItems) {
    const items =
        providedItems ||
        splitText(text).map((text, i) => ({
          id: paragraphId + ":" + i,
          text,
        })),
      fresh = [],
      cached = [];
    for (const x of items) {
      const hit = await this.cache.get(x.text, j.config);
      if (j.cancelled) fail("CANCELLED", "任务停止");
      if (hit !== null) cached.push({ id: x.id, text: hit, cached: true });
      else fresh.push(x);
    }
    if (
      !j.budget.reserve(
        paragraphId,
        fresh.map((x) => x.text),
      )
    ) {
      j.budgetBlocked = true;
      return { blocked: true, budget: j.budget.snapshot() };
    }
    const planned = batches(fresh).map((items) => {
      const batchId = crypto.randomUUID();
      j.batches.set(batchId, {
        batchId,
        paragraphId,
        items,
        controller: new AbortController(),
      });
      return { batchId, items };
    });
    if (!fresh.length) j.budget.release(paragraphId);
    return {
      cached,
      batches: planned,
      ids: items.map((x) => x.id),
      budget: j.budget.snapshot(),
    };
  }
  async slot(signal, priority = 0) {
    if (signal.aborted) fail("CANCELLED", "停止");
    if (this.active < 2) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const row = {
        priority,
        resolve: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        reject,
      };
      const abort = () => {
        this.waiters = this.waiters.filter((x) => x !== row);
        reject(new Failure("CANCELLED", "停止"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.push(row);
      this.waiters.sort((a, b) => b.priority - a.priority);
    });
  }
  free() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
  }
  async run(sender, request) {
    validateBatch(request);
    const j = this.get(sender, request.jobId),
      b = j.batches.get(request.batchId);
    if (!b || JSON.stringify(b.items) !== JSON.stringify(request.items))
      fail("INVALID_MESSAGE", "未授权批次");
    if (b.promise) return b.promise;
    b.promise = this.execute(j, b).catch((error) => {
      throw j.fatalError || error;
    });
    return b.promise;
  }
  async execute(j, b) {
    const signal = b.controller.signal;
    // Only the first video request jumps queued page work; subsequent batches
    // keep FIFO order. Existing in-flight requests are not duplicated/preempted.
    const priority =
      j.binding.kind === "video" && !j.firstVideoRequestQueued ? 1 : 0;
    if (j.binding.kind === "video") j.firstVideoRequestQueued = true;
    await this.slot(signal, priority);
    let dispatched = false;
    const start = Date.now();
    try {
      if (j.cancelled || signal.aborted) fail("CANCELLED", "停止");
      if (j.halted) fail(j.halted, "队列暂停");
      await j.budget.dispatch(
        b.paragraphId,
        b.items.map((x) => x.text),
      );
      if (j.cancelled || signal.aborted) fail("CANCELLED", "停止");
      dispatched = true;
      const translations = await this.translate(b.items, j.config, signal);
      if (j.cancelled || signal.aborted) fail("CANCELLED", "停止");
      if (translations.length !== b.items.length)
        fail("RESPONSE_FORMAT", "格式错误");
      await this.cache.putMany(
        b.items.map((item, index) => ({
          text: item.text,
          translated: translations[index].text,
        })),
        j.config,
      );
      if (j.cancelled || signal.aborted) fail("CANCELLED", "停止");
      return { translations, budget: j.budget.snapshot() };
    } catch (e) {
      if (fatalCodes.includes(e.code)) {
        j.fatalError = e;
        j.halted = e.code;
        this.cancel(j.id);
      } else if (pauseCodes.includes(e.code)) {
        j.halted = e.code;
        j.retryAt = Date.now() + (e.retryAfterMs || 0);
      }
      if (!dispatched) b.promise = null;
      throw e;
    } finally {
      b.settled = true;
      this.diagnostics.record({
        jobId: j.id,
        batchId: b.batchId,
        provider: j.config.provider,
        model: j.config.model,
        elapsedMs: Date.now() - start,
        characters: dispatched
          ? b.items.reduce((n, x) => n + length(x.text), 0)
          : 0,
      });
      this.free();
    }
  }
  release(sender, id, paragraphId) {
    const j = this.get(sender, id);
    j.budget.release(paragraphId);
    for (const [key, b] of j.batches)
      if (b.paragraphId === paragraphId) {
        if (!b.settled) b.controller.abort();
        j.batches.delete(key);
      }
    j.preparations.delete(paragraphId);
  }
  cancel(id) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.cancelled = true;
    for (const b of j.batches.values()) b.controller.abort();
    for (const paragraphId of j.preparations.keys())
      j.budget.release(paragraphId);
    j.preparations.clear();
    j.batches.clear();
  }
  retry(sender, id) {
    const j = this.get(sender, id);
    if (Date.now() < j.retryAt)
      fail("RATE_LIMITED", "仍需等待", {
        retryAfterMs: j.retryAt - Date.now(),
      });
    j.halted = null;
  }
  async nextRound(sender, id) {
    const j = this.get(sender, id);
    if (!j.budgetBlocked || j.halted)
      fail("INVALID_STATE", "只有预算暂停时才能继续");
    j.budget.nextRound();
    j.budgetBlocked = false;
    for (const [key, promise] of j.preparations)
      await promise.then((p) => {
        if (p.blocked) j.preparations.delete(key);
      });
    return j.budget.snapshot();
  }
}
