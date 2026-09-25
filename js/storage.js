/*
 * storage.js — IndexedDB 持久化
 *
 * 两个 object store：
 *  - state：keyPath 固定 'current'，保存刷新后恢复的向导完整状态（含敏感字段，仅存本地）
 *  - shares：超长 URL 降级方案的短键 -> 序列化串映射
 */
(function (root) {
  'use strict';

  const DB_NAME = 'wizard-db';
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

  async function tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = fn(store);
      transaction.oncomplete = () => {
        db.close();
        resolve(request && 'result' in request ? request.result : undefined);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    });
  }

  const WizardStorage = {
    saveState(state) {
      return tx('state', 'readwrite', (s) => s.put(state, 'current'));
    },
    loadState() {
      return tx('state', 'readonly', (s) => s.get('current'));
    },
    clearState() {
      return tx('state', 'readwrite', (s) => s.delete('current'));
    },
    saveShare(key, payload) {
      return tx('shares', 'readwrite', (s) => s.put(payload, key));
    },
    loadShare(key) {
      return tx('shares', 'readonly', (s) => s.get(key));
    },
  };

  root.WizardStorage = WizardStorage;
})(typeof self !== 'undefined' ? self : this);
