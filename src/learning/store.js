const KEY = "englishLearningV1";
const defaults = { enabled: false, level: "B1", preference: "practical" };
const bad = (message) => {
  throw Object.assign(Error(message), { code: "LEARNING_INVALID" });
};
const clean = (v, max, required = false) => {
  if (typeof v !== "string" || v.length > max || (required && !v.trim()))
    bad("学习资料格式无效或过长");
  return v.trim();
};
export const identity = (text) =>
  text.trim().toLowerCase().replace(/\s+/g, " ");
function sourceURL(value = "") {
  if (!value) return "";
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol)) bad("来源地址无效");
  return u.origin + u.pathname;
}
function prefs(p) {
  if (
    !p ||
    typeof p.enabled !== "boolean" ||
    !["A1", "A2", "B1", "B2", "C1", "C2"].includes(p.level) ||
    !["practical", "article"].includes(p.preference)
  )
    bad("学习设置无效");
  return { enabled: p.enabled, level: p.level, preference: p.preference };
}
function record(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    bad("学习记录格式无效");
  const text = clean(raw.text, 6000, true);
  const translation = clean(raw.translation, 12000, true);
  return {
    id: identity(text),
    text,
    translation,
    context: clean(raw.context ?? "", 2000),
    url: sourceURL(raw.url),
    learning:
      raw.learning ??
      (/^[A-Za-z][A-Za-z\s'’,-]*$/.test(text) &&
        text.split(/\s+/).length <= 12),
    step: 0,
    due: Date.now(),
    remembered: 0,
    forgotten: 0,
    created: Date.now(),
  };
}
function validateRow(r) {
  const base = record(r);
  if (
    r.id !== base.id ||
    typeof r.learning !== "boolean" ||
    !Number.isInteger(r.step) ||
    r.step < 0 ||
    r.step > 5 ||
    !["due", "created", "remembered", "forgotten"].every(
      (k) => Number.isSafeInteger(r[k]) && r[k] >= 0,
    )
  )
    bad("学习记录损坏，未导入");
  return {
    ...base,
    step: r.step,
    due: r.due,
    remembered: r.remembered,
    forgotten: r.forgotten,
    created: r.created,
  };
}
export class LearningStore {
  constructor(storage) {
    this.storage = storage;
    this.tail = Promise.resolve();
  }
  async read() {
    await this.tail;
    return this.load();
  }
  async load() {
    const d = (await this.storage.get(KEY))[KEY];
    if (!d) return { version: 1, preferences: { ...defaults }, records: [] };
    if (d.version !== 1 || !Array.isArray(d.records) || d.records.length > 3000)
      bad("学习库格式不兼容");
    return {
      version: 1,
      preferences: prefs(d.preferences),
      records: d.records.map(validateRow),
    };
  }
  mutate(fn) {
    const result = this.tail.then(async () => {
      const d = await this.load();
      const out = fn(d);
      if (d.records.length > 3000 || JSON.stringify(d).length > 3000000)
        bad("学习库已满，请先导出并整理");
      await this.storage.set({ [KEY]: d });
      return out;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  configure(patch) {
    return this.mutate(
      (d) => (d.preferences = prefs({ ...d.preferences, ...patch })),
    );
  }
  async record(raw) {
    if (!(await this.read()).preferences.enabled) return null;
    return this.mutate((d) => {
      if (!d.preferences.enabled) return null;
      const row = record(raw);
      const old = d.records.find((r) => r.id === row.id);
      if (old) {
        if (raw.learning === true) old.learning = true;
        old.translation = row.translation;
        if (row.context) old.context = row.context;
        if (row.url) old.url = row.url;
        return old;
      }
      d.records.push(row);
      return row;
    });
  }
  update(id, action) {
    return this.mutate((d) => {
      const r = d.records.find((r) => r.id === id);
      if (!r) bad("学习条目不存在");
      if (action === "delete") d.records = d.records.filter((r) => r !== r);
      else if (action === "learn") r.learning = true;
      else if (action === "archive") r.learning = false;
      else bad("未知学习操作");
      return r;
    });
  }
  review(id, rating, now = Date.now()) {
    return this.mutate((d) => {
      const r = d.records.find((r) => r.id === id);
      if (!r || !r.learning) bad("学习条目不存在");
      if (rating === "skip") return r;
      if (rating === "remember") {
        r.remembered++;
        r.step = Math.min(5, r.step + 1);
      } else if (rating === "forget") {
        r.forgotten++;
        r.step = 0;
      } else bad("复习反馈无效");
      r.due = now + [1, 1, 3, 7, 14, 30][r.step] * 86400000;
      return r;
    });
  }
  import(data) {
    if (
      !data ||
      data.version !== 1 ||
      !Array.isArray(data.records) ||
      data.records.length > 3000
    )
      bad("不支持的学习文件");
    const rows = data.records.map(validateRow);
    return this.mutate((d) => {
      for (const row of rows)
        if (!d.records.some((r) => r.id === row.id)) d.records.push(row);
      return { added: rows.length, total: d.records.length };
    });
  }
  clear() {
    return this.mutate((d) => {
      d.records = [];
      return {};
    });
  }
}
