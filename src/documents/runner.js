import { Failure, length } from "../shared/core.js";
const fatalCodes = [
  "AUTH_FAILED",
  "QUOTA_EXCEEDED",
  "PERMISSION_MISSING",
  "CONFIG_INVALID",
];
export class DocumentRunner {
  constructor(send, onChange = () => {}) {
    Object.assign(this, { send, onChange });
    this.translations = new Map();
    this.errors = new Map();
    this.phase = "idle";
    this.generation = 0;
  }
  async start(document) {
    await this.stop(false);
    const generation = ++this.generation;
    this.document = document;
    this.translations.clear();
    this.errors.clear();
    this.index = 0;
    this.pendingPriorities = null;
    this.phase = "starting";
    this.emit();
    const job = await this.send("WB_START");
    if (generation !== this.generation) {
      await this.send("WB_CANCEL", { jobId: job.id }).catch(() => {});
      return;
    }
    this.job = job;
    this.phase = "translating";
    await this.run(generation);
  }
  emit() {
    this.onChange(this);
  }
  group() {
    const first = this.document.segments[this.index];
    if (!this.document.batchItems || length(first.text) > 1200)
      return { segments: [first], bulk: false, id: first.id };
    const segments = [];
    let chars = 0;
    for (const segment of this.document.segments.slice(
      this.index,
      this.index + 8,
    )) {
      const count = length(segment.text);
      if (
        this.translations.has(segment.id) ||
        count > 1200 ||
        chars + count > 2400
      )
        break;
      segments.push(segment);
      chars += count;
    }
    return { segments, bulk: true, id: "group:" + first.id };
  }
  async run(generation = this.generation) {
    if (this.running && this.runningGeneration === generation) return;
    this.runningGeneration = generation;
    this.running = true;
    const jobId = this.job.id;
    try {
      while (this.index < this.document.segments.length) {
        if (generation !== this.generation) return;
        if (this.pendingPriorities) {
          const order = this.pendingPriorities;
          this.pendingPriorities = null;
          const remaining = this.document.segments
            .slice(this.index)
            .sort(
              (a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9),
            );
          this.document.segments.splice(
            this.index,
            remaining.length,
            ...remaining,
          );
        }
        const first = this.document.segments[this.index];
        if (this.translations.has(first.id)) {
          this.index++;
          continue;
        }
        const group = this.group();
        let prepared;
        this.emit();
        try {
          prepared = await this.send(
            group.bulk ? "WB_PREPARE_ITEMS" : "WB_PREPARE",
            {
              jobId,
              paragraphId: group.id,
              ...(group.bulk
                ? {
                    items: group.segments.map(({ id, text }) => ({ id, text })),
                  }
                : { text: first.text }),
            },
          );
          this.budget = prepared.budget;
          if (generation !== this.generation) return;
          if (prepared.blocked) {
            this.phase = "paused_budget";
            return;
          }
          const map = new Map(prepared.cached.map((row) => [row.id, row.text]));
          const results = await Promise.allSettled(
            prepared.batches.map(async (batch) => {
              const result = await this.send("WB_BATCH", { jobId, ...batch });
              this.budget = result.budget;
              for (const row of result.translations) map.set(row.id, row.text);
            }),
          );
          const failed = results.filter((r) => r.status === "rejected");
          const error =
            failed.find((r) => fatalCodes.includes(r.reason.code)) ||
            failed.find((r) => r.reason.code !== "CANCELLED") ||
            failed[0];
          if (error) throw error.reason;
          if (prepared.ids.some((id) => !map.has(id)))
            throw new Failure("RESPONSE_FORMAT", "译文缺少段落");
          if (generation !== this.generation) return;
          for (const segment of group.segments) {
            this.translations.set(
              segment.id,
              group.bulk
                ? map.get(segment.id)
                : prepared.ids.map((id) => map.get(id)).join(""),
            );
            this.errors.delete(segment.id);
          }
          this.index += group.segments.length;
        } catch (error) {
          if (generation !== this.generation) return;
          if (error.budget) this.budget = error.budget;
          for (const segment of group.segments)
            this.errors.set(segment.id, {
              code: error.code || "INTERNAL_ERROR",
              message: error.message || "翻译失败",
            });
          this.phase = ["INTERRUPTED", "OUTCOME_UNKNOWN"].includes(error.code)
            ? "interrupted"
            : "error";
          return;
        } finally {
          if (prepared && !prepared.blocked)
            await this.send("WB_RELEASE", {
              jobId,
              paragraphId: group.id,
            }).catch(() => {});
          this.emit();
        }
      }
      if (generation === this.generation) this.phase = "complete";
    } finally {
      if (this.runningGeneration === generation) {
        this.running = false;
        this.emit();
      }
    }
  }
  async stop(notify = true) {
    this.generation++;
    const job = this.job;
    this.job = null;
    this.phase = "cancelled";
    if (job) await this.send("WB_CANCEL", { jobId: job.id }).catch(() => {});
    if (notify) this.emit();
  }
  prioritize(ids) {
    this.pendingPriorities = new Map(ids.map((id, index) => [id, index]));
  }
  async continue() {
    if (this.phase !== "paused_budget" || this.running) return;
    this.budget = await this.send("WB_CONTINUE", { jobId: this.job.id });
    this.phase = "translating";
    await this.run();
  }
  async extend(document) {
    if (!this.job) return this.start(document);
    if (this.running) throw new Failure("JOB_BUSY", "上一批字幕尚在处理");
    const old = this.document.segments;
    if (
      document.segments.length < old.length ||
      old.some(
        (row, i) =>
          row.id !== document.segments[i]?.id ||
          row.text !== document.segments[i]?.text,
      )
    )
      throw new Failure("SUBTITLE_CHANGED", "已有字幕发生改变，请重新开始");
    this.document = document;
    if (this.phase !== "complete") {
      this.emit();
      return;
    }
    this.phase = "translating";
    await this.run();
  }
  async retry() {
    if (this.phase !== "error" || this.running) return;
    await this.send("WB_RETRY", { jobId: this.job.id });
    this.phase = "translating";
    await this.run();
  }
}
