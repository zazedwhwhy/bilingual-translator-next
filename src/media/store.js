let database;
function open() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("bt-next-media", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("records", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function operation(mode, perform) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", mode);
    let result;
    const request = perform(tx.objectStore("records"));
    if (request) request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || Error("媒体存储事务中断"));
  });
}
export const getRecord = (id) =>
  operation("readonly", (store) => store.get(id));
export const putRecord = (record) =>
  operation("readwrite", (store) => store.put(record));
export const removeRecord = (id) =>
  operation("readwrite", (store) => store.delete(id));
export async function updateSession(id, change) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite"),
      store = tx.objectStore("records");
    let result, failure;
    const request = store.get(id);
    request.onsuccess = () => {
      try {
        const session = request.result;
        if (!session || session.kind !== "session")
          throw Object.assign(Error("音频会话已关闭或删除"), {
            code: "SESSION_GONE",
          });
        change(session, store);
        session.updated = Date.now();
        store.put(session);
        result = session;
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () =>
      reject(failure || tx.error || Error("媒体存储事务中断"));
  });
}
export async function addAudio(
  sessionId,
  blob,
  { name = "audio.webm", offset = 0, duration = null } = {},
) {
  const id = crypto.randomUUID();
  await updateSession(sessionId, (session, store) => {
    store.put({
      id,
      kind: "audio",
      sessionId,
      blob,
      name,
      offset,
      duration,
      created: Date.now(),
    });
    session.chunks.push({ id, name, offset, duration, state: "ready" });
  });
  return id;
}
export async function removeSession(id) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite"),
      store = tx.objectStore("records"),
      cursor = store.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (row.value.id === id || row.value.sessionId === id) row.delete();
      row.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () =>
      reject(tx.error || Error("无法删除本次音频"));
  });
}
