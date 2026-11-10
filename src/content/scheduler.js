import { phase, publicError, length } from "../shared/core.js";
const paused = ["NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "RATE_LIMITED"];
const fatal = [
  "AUTH_FAILED",
  "QUOTA_EXCEEDED",
  "PERMISSION_MISSING",
  "CONFIG_INVALID",
];
export class Session {
  constructor({ job, extractor, renderer, send, onChange = () => {} }) {
    Object.assign(this, { job, extractor, renderer, send, onChange });
    this.rows = new Map();
    this.visible = new Set();
    this.onscreen = new Set();
    this.groupCounter = 0;
    this.cancelled = false;
    this.interrupted = false;
    this.halted = false;
    this.budgetBlocked = false;
    this.running = false;
    this.lastError = null;
  }
  scan() {
    const found = this.extractor.scan();
    const live = new Set(found.map((r) => r.id));
    for (const r of found) {
      const old = this.rows.get(r.id);
      if (!old || old.record.revision !== r.revision) {
        if (old) {
          this.renderer.remove(r.id);
          this.send("RELEASE", { paragraphId: old.key }).catch(() => {});
        }
        this.rows.set(r.id, {
          record: { ...r },
          key: r.id + "r" + r.revision,
          status: "pending",
        });
      }
    }
    for (const [id, row] of this.rows)
      if (!live.has(id)) {
        this.renderer.remove(id);
        this.rows.delete(id);
        this.visible.delete(id);
        this.send("RELEASE", { paragraphId: row.key }).catch(() => {});
      }
    this.onChange();
    return found;
  }
  state() {
    const counts = {
      pending: 0,
      requesting: 0,
      translated: 0,
      error: 0,
      cancelled: 0,
      stale: 0,
    };
    let offscreen = 0;
    for (const [id, row] of this.rows) {
      if (counts[row.status] !== undefined) counts[row.status]++;
      if (row.status === "pending" && !this.visible.has(id)) offscreen++;
    }
    return {
      jobId: this.job.id,
      provider: this.job.provider,
      model: this.job.model,
      phase: phase({
        cancelled: this.cancelled,
        interrupted: this.interrupted,
        fatal: this.fatal,
        errors: counts.error,
        translated: counts.translated,
        budgetBlocked: this.budgetBlocked,
        active: this.running,
        offscreen,
      }),
      counts,
      budget: this.budget,
      error: this.lastError,
      halted: this.halted,
      fatal: !!this.fatal,
      budgetBlocked: this.budgetBlocked,
    };
  }
  valid(row) {
    return (
      !this.cancelled &&
      !this.interrupted &&
      this.rows.get(row.record.id) === row &&
      this.extractor.current(row.record)
    );
  }
  async pump() {
    if (
      this.running ||
      this.cancelled ||
      this.interrupted ||
      this.halted ||
      this.budgetBlocked
    )
      return;
    this.running = true;
    this.onChange();
    const active = new Set();
    try {
      for (;;) {
        while (
          active.size < 2 &&
          !this.cancelled &&
          !this.interrupted &&
          !this.halted &&
          !this.budgetBlocked
        ) {
          const rows = this.nextRows();
          if (!rows.length) break;
          const task =
            rows.length === 1
              ? this.translate(rows[0])
              : this.translateGroup(rows);
          active.add(task);
          void task.then(
            () => active.delete(task),
            () => active.delete(task),
          );
        }
        if (!active.size) break;
        await Promise.race(active);
      }
    } finally {
      this.running = false;
      this.onChange();
    }
  }
  nextRows() {
    const pending = [...this.rows.values()]
      .filter(
        (row) => row.status === "pending" && this.visible.has(row.record.id),
      )
      .sort(
        (a, b) =>
          Number(this.onscreen.has(b.record.id)) -
          Number(this.onscreen.has(a.record.id)),
      );
    const first = pending[0];
    if (!first) return [];
    if (length(first.record.text) > 1200) return [first];
    const rows = [];
    let chars = 0;
    for (const row of pending) {
      const count = length(row.record.text);
      if (count > 1200 || chars + count > 2400 || rows.length === 8) break;
      rows.push(row);
      chars += count;
    }
    return rows;
  }
  async translateGroup(rows) {
    const key = "page-group:" + ++this.groupCounter;
    for (const row of rows) row.status = "requesting";
    this.onChange();
    try {
      const plan = await this.send("PREPARE_ITEMS", {
        paragraphId: key,
        items: rows.map((row) => ({ id: row.key, text: row.record.text })),
      });
      this.budget = plan.budget;
      if (plan.blocked) {
        this.budgetBlocked = true;
        for (const row of rows) if (this.valid(row)) row.status = "pending";
        return;
      }
      const translations = new Map(
        plan.cached.map((item) => [item.id, item.text]),
      );
      if (
        plan.ids.length !== rows.length ||
        rows.some((row) => !plan.ids.includes(row.key))
      )
        throw Object.assign(Error(), { code: "RESPONSE_FORMAT" });
      for (const row of rows)
        if (translations.has(row.key) && this.valid(row)) {
          this.renderer.show(
            row.record,
            translations.get(row.key),
            this.job.target,
          );
          row.status = "translated";
        }
      const results = await Promise.allSettled(
        plan.batches.map(async (batch) => {
          const result = await this.send("BATCH", batch);
          this.budget = result.budget;
          for (const item of result.translations)
            translations.set(item.id, item.text);
        }),
      );
      const failures = results.filter((result) => result.status === "rejected"),
        failure =
          failures.find((result) => fatal.includes(result.reason.code)) ||
          failures.find((result) => result.reason.code !== "CANCELLED") ||
          failures[0];
      if (failure) throw failure.reason;
      if (
        plan.ids.length !== rows.length ||
        rows.some(
          (row) => !plan.ids.includes(row.key) || !translations.has(row.key),
        )
      )
        throw Object.assign(Error(), { code: "RESPONSE_FORMAT" });
      for (const row of rows)
        if (this.valid(row) && row.status !== "translated") {
          this.renderer.show(
            row.record,
            translations.get(row.key),
            this.job.target,
          );
          row.status = "translated";
        }
    } catch (error) {
      for (const row of rows) this.failed(row, error);
    } finally {
      await this.send("RELEASE", { paragraphId: key }).catch(() => {});
      this.onChange();
    }
  }
  failed(row, error) {
    if (!this.valid(row) || row.status === "translated") return;
    if (error.budget) this.budget = error.budget;
    row.status = "error";
    if (!this.fatal || fatal.includes(error.code))
      this.lastError = publicError(error);
    if (["INTERRUPTED", "OUTCOME_UNKNOWN"].includes(error.code)) {
      this.interrupted = true;
      if (!this.fatal)
        this.lastError = publicError({ code: "OUTCOME_UNKNOWN" });
    }
    if (paused.includes(error.code)) this.halted = true;
    if (fatal.includes(error.code)) {
      this.fatal = true;
      this.halted = true;
    }
    this.renderer.show(
      row.record,
      this.lastError.message,
      this.job.target,
      true,
    );
  }
  async translate(row) {
    row.status = "requesting";
    this.onChange();
    try {
      const plan = await this.send("PREPARE", {
        paragraphId: row.key,
        text: row.record.text,
      });
      this.budget = plan.budget;
      if (!this.valid(row)) return;
      if (plan.blocked) {
        row.status = "pending";
        this.budgetBlocked = true;
        return;
      }
      const translations = new Map(plan.cached.map((x) => [x.id, x.text]));
      const results = await Promise.allSettled(
        plan.batches.map(async (batch) => {
          const result = await this.send("BATCH", batch);
          this.budget = result.budget;
          for (const x of result.translations) translations.set(x.id, x.text);
        }),
      );
      const failures = results.filter((x) => x.status === "rejected");
      const rejected =
        failures.find((x) => fatal.includes(x.reason.code)) ||
        failures.find((x) =>
          ["INTERRUPTED", "OUTCOME_UNKNOWN"].includes(x.reason.code),
        ) ||
        failures.find((x) => x.reason.code !== "CANCELLED") ||
        failures[0];
      if (rejected) throw rejected.reason;
      if (!this.valid(row)) return;
      if (plan.ids.some((id) => !translations.has(id)))
        throw Object.assign(Error(), { code: "RESPONSE_FORMAT" });
      this.renderer.show(
        row.record,
        plan.ids.map((id) => translations.get(id)).join(""),
        this.job.target,
      );
      row.status = "translated";
    } catch (error) {
      this.failed(row, error);
    } finally {
      await this.send("RELEASE", { paragraphId: row.key }).catch(() => {});
      this.onChange();
    }
  }
  stop() {
    this.cancelled = true;
    for (const r of this.rows.values())
      if (["pending", "requesting"].includes(r.status)) r.status = "cancelled";
    this.onChange();
  }
  interrupt() {
    if (this.cancelled) return;
    this.interrupted = true;
    this.halted = true;
    this.lastError = publicError({ code: "OUTCOME_UNKNOWN" });
    for (const r of this.rows.values())
      if (r.status === "requesting") r.status = "error";
    this.onChange();
  }
  async retry() {
    if (this.cancelled || this.interrupted || this.fatal) return;
    await this.send("RETRY");
    this.scan();
    for (const row of this.rows.values())
      if (row.status === "error") {
        this.renderer.remove(row.record.id);
        row.status = "pending";
      }
    this.halted = false;
    void this.pump();
  }
  async continue() {
    if (this.running || !this.budgetBlocked) return;
    this.budget = await this.send("CONTINUE");
    this.budgetBlocked = false;
    void this.pump();
  }
}
