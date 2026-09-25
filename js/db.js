// IndexedDB 极简封装：两个仓库
//   state  — 当前向导状态（刷新后恢复）
//   shares — URL 超长时的完整分享 payload（短链接降级方案）
const DB_NAME = 'wizard-share';
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      if (!db.objectStoreNames.contains('shares')) db.createObjectStore('shares');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const result = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(result._value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      if (result && 'onsuccess' in result) {
        result.onsuccess = () => { result._value = result.result; };
      }
    });
  } finally {
    db.close();
  }
}

export const db = {
  saveState(state) {
    return withStore('state', 'readwrite', (s) => s.put(state, 'current'));
  },
  loadState() {
    return withStore('state', 'readonly', (s) => s.get('current'));
  },
  clearState() {
    return withStore('state', 'readwrite', (s) => s.delete('current'));
  },
  saveShare(id, payload) {
    return withStore('shares', 'readwrite', (s) => s.put(payload, id));
  },
  loadShare(id) {
    return withStore('shares', 'readonly', (s) => s.get(id));
  },
};
