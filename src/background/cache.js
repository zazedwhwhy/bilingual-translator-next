import { providers } from "../providers/registry.js";
export class Diagnostics {
  constructor() {
    this.events = [];
  }
  record(meta) {
    const event = { at: Date.now() };
    for (const key of [
      "jobId",
      "batchId",
      "provider",
      "model",
      "elapsedMs",
      "characters",
      "status",
      "cacheHit",
      "code",
    ])
      if (["string", "number", "boolean"].includes(typeof meta[key]))
        event[key] = meta[key];
    this.events.push(event);
    this.events = this.events.slice(-100);
  }
  export() {
    return structuredClone(this.events);
  }
}
export function indexedStore() {
  let connection;
  const open = () =>
    (connection ??= new Promise((resolve, reject) => {
      const r = indexedDB.open("bt-next-cache", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("translations");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const transact = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("translations", mode);
      let result;
      const r = action(tx.objectStore("translations"));
      r.onsuccess = () => (result = r.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("cache transaction aborted"));
    });
  };
  return {
    get: (key) => transact("readonly", (s) => s.get(key)),
    async putMany(entries) {
      const db = await open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("translations", "readwrite"),
          store = tx.objectStore("translations");
        for (const [key, row] of entries) store.put(row, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error || Error("cache batch transaction aborted"));
      });
    },
    clear: () => transact("readwrite", (s) => s.clear()),
    async prune() {
      const db = await open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("translations", "readwrite"),
          s = tx.objectStore("translations");
        const rows = [];
        const r = s.openCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (c) {
            rows.push({ key: c.key, at: c.value.used });
            c.continue();
          } else
            rows
              .sort((a, b) => b.at - a.at)
              .slice(1000)
              .forEach((x) => s.delete(x.key));
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
export class Cache {
  constructor({ store, clock = Date.now, onDegrade = () => {} } = {}) {
    this.store = store;
    this.clock = clock;
    this.onDegrade = onDegrade;
    this.memory = new Map();
    this.generation = 0;
    this.writes = Promise.resolve();
    this.touches = new Set();
    this.touchTimer = null;
    this.pendingClear = null;
  }
  async key(text, c) {
    const raw = JSON.stringify([
      c.provider,
      providers[c.provider].url,
      c.model,
      c.provider === "claude" ? "2026-10-21" : "v1",
      c.source,
      c.target,
      "prompt-v1",
      text,
    ]);
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  }
  async get(text, c) {
    const generation = this.generation;
    const key = await this.key(text, c);
    if (generation !== this.generation) return null;
    let row = this.memory.get(key);
    if (!row && c.cacheEnabled && this.store)
      try {
        if (this.pendingClear) await this.pendingClear;
        if (generation !== this.generation) return null;
        row = await this.store.get(key);
      } catch {
        this.onDegrade();
      }
    if (generation !== this.generation) return null;
    if (!row) return null;
    if (
      typeof row.text !== "string" ||
      !row.text.trim() ||
      !Number.isFinite(row.at) ||
      row.at < 0 ||
      !Number.isFinite(row.used) ||
      row.used < 0
    ) {
      this.memory.delete(key);
      this.touches.delete(key);
      this.onDegrade();
      return null;
    }
    if (this.clock() - row.at > 30 * 86400000) {
      this.memory.delete(key);
      this.touches.delete(key);
      return null;
    }
    row = { ...row, used: this.clock() };
    this.remember(key, row);
    if (c.cacheEnabled && this.store) {
      this.touches.add(key);
      if (this.touchTimer === null)
        this.touchTimer = setTimeout(() => {
          this.touchTimer = null;
          void this.flushTouches().catch(() => this.onDegrade());
        }, 32);
    }
    return row.text;
  }
  remember(key, row) {
    this.memory.delete(key);
    this.memory.set(key, row);
    if (this.memory.size > 1000)
      this.memory.delete(this.memory.keys().next().value);
  }
  enqueue(action) {
    const pending = this.writes.then(action);
    this.writes = pending.catch(() => {});
    return pending;
  }
  writeRows(entries, generation) {
    if (!entries.length) return Promise.resolve();
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      await this.store.putMany(entries);
      if (generation === this.generation) await this.store.prune();
    });
  }
  flushTouches() {
    clearTimeout(this.touchTimer);
    this.touchTimer = null;
    const generation = this.generation;
    const entries = [...this.touches].flatMap((key) => {
      const row = this.memory.get(key);
      return row ? [[key, { ...row }]] : [];
    });
    this.touches.clear();
    return this.writeRows(entries, generation);
  }
  put(text, translated, c) {
    return this.putMany([{ text, translated }], c);
  }
  async putMany(values, c) {
    const generation = this.generation;
    const keys = await Promise.all(
      values.map((value) => this.key(value.text, c)),
    );
    if (generation !== this.generation) return;
    const entries = values.map((value, index) => {
      const row = {
        text: value.translated,
        at: this.clock(),
        used: this.clock(),
      };
      this.touches.delete(keys[index]);
      this.remember(keys[index], row);
      return [keys[index], row];
    });
    if (c.cacheEnabled && this.store)
      try {
        await this.flushTouches();
        await this.writeRows(entries, generation);
      } catch {
        this.onDegrade();
      }
  }
  async clear() {
    this.generation++;
    this.memory.clear();
    this.touches.clear();
    clearTimeout(this.touchTimer);
    this.touchTimer = null;
    if (this.store) {
      const pending = this.enqueue(() => this.store.clear());
      this.pendingClear = pending;
      try {
        await pending;
      } finally {
        if (this.pendingClear === pending) this.pendingClear = null;
      }
    }
  }
}
