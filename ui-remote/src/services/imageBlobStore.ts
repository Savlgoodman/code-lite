/**
 * imageBlobStore — 生图产物二进制存储（IndexedDB）
 *
 * 远程端生图是纯前端应用，无后端可落盘。生成图/参考图二进制比对话缩略图大，
 * base64 全塞 localStorage 会很快溢出（5-10MB 上限），故图片二进制存 IndexedDB
 * （可存几百 MB），记录 JSON 里只存图片 id，展示时按 id 取 Blob 转 objectURL。
 */

const DB_NAME = "code-lite-image-gen";
const DB_VERSION = 1;
const STORE = "images";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 操作失败"));
  });
}

export const imageBlobStore = {
  async putImage(id: string, blob: Blob): Promise<void> {
    await withStore("readwrite", (store) => store.put(blob, id));
  },

  async getImage(id: string): Promise<Blob | null> {
    const result = await withStore<Blob | undefined>("readonly", (store) => store.get(id));
    return result ?? null;
  },

  async deleteImage(id: string): Promise<void> {
    await withStore("readwrite", (store) => store.delete(id));
  },

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 批量删除失败"));
    });
  },
};

/** 把 base64（不含 data: 前缀）解码为 Blob。 */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || "image/png" });
}

/** 把 Blob 读为纯 base64（不含 data: 前缀），供作为参考图发送。 */
export function blobToBase64(blob: Blob): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("图片读取失败"));
        return;
      }
      const comma = result.indexOf(",");
      resolve({ base64: comma >= 0 ? result.slice(comma + 1) : result, mimeType: blob.type || "image/png" });
    };
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}
