// 序列化 / 反序列化：版本标记 + 敏感信息过滤 + 压缩（Web Worker）+ base64url。
// 字符串格式: w1.<format><base64url>
//   w1   — 协议版本（字符串结构本身）
//   format — 'd' deflate-raw 压缩, 'r' 未压缩（环境不支持压缩时的退化）
// 解压后的 JSON: { v: <状态版本>, data: { <stepId>: { ... } } }

import { STATE_VERSION, STEPS, defaultState, sensitiveKeys, migrate } from './schema.js';

const PREFIX = 'w1.';

// ---------- base64url ----------
export function bytesToBase64url(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- Worker RPC ----------
let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker('./js/compress-worker.js', { type: 'classic' });
    worker.onmessage = (event) => {
      const { id } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (event.data.ok) entry.resolve(event.data);
      else entry.reject(new Error(event.data.error || '压缩 Worker 出错'));
    };
    worker.onerror = (err) => {
      for (const entry of pending.values()) entry.reject(new Error('压缩 Worker 启动失败'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function callWorker(message, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...message }, transfer);
  });
}

// ---------- 敏感信息过滤 ----------
export function sanitize(state) {
  const sensitive = sensitiveKeys();
  const clean = {};
  for (const step of STEPS) {
    clean[step.id] = {};
    for (const field of step.fields) {
      if (sensitive.has(`${step.id}.${field.key}`)) continue;
      const value = state?.[step.id]?.[field.key];
      clean[step.id][field.key] = value === undefined
        ? structuredClone(field.default)
        : structuredClone(value);
    }
  }
  return clean;
}

// ---------- 校验与合并 ----------
// 把（可能来自旧版本/被篡改的）data 合并进默认状态：未知键丢弃，类型不符回退默认值。
function coerce(data) {
  const state = defaultState();
  for (const step of STEPS) {
    const incoming = data?.[step.id];
    if (incoming === null || typeof incoming !== 'object') continue;
    for (const field of step.fields) {
      if (!(field.key in incoming)) continue;
      const value = incoming[field.key];
      const def = field.default;
      if (Array.isArray(def)) {
        if (Array.isArray(value)) {
          const allowed = new Set((field.options || []).map((o) => o.value));
          state[step.id][field.key] = value.filter((v) => allowed.has(v));
        }
      } else if (typeof def === 'boolean') {
        state[step.id][field.key] = Boolean(value);
      } else if (typeof def === 'string') {
        if (typeof value !== 'string') continue;
        if (field.options && !field.options.some((o) => o.value === value)) continue;
        state[step.id][field.key] = value.slice(0, 2000);
      }
    }
  }
  return state;
}

// ---------- 序列化 ----------
export async function serialize(state) {
  const payload = { v: STATE_VERSION, data: sanitize(state) };
  const json = JSON.stringify(payload);
  const res = await callWorker({ op: 'encode', text: json });
  return {
    string: PREFIX + res.format + bytesToBase64url(new Uint8Array(res.data)),
    payload,
  };
}

// ---------- 反序列化 ----------
// 返回 { state, notices: string[] }；失败抛出带用户可读信息的 Error。
export async function deserialize(input) {
  let str = String(input || '').trim();
  // 允许直接粘贴完整 URL
  if (str.includes('#')) str = str.slice(str.indexOf('#') + 1);
  if (str.startsWith('c=')) str = str.slice(2);
  if (!str.startsWith(PREFIX)) {
    throw new Error('无法识别的分享内容：缺少版本前缀');
  }
  const body = str.slice(PREFIX.length);
  const format = body[0];
  let bytes;
  try {
    bytes = base64urlToBytes(body.slice(1));
  } catch {
    throw new Error('分享内容已损坏：不是合法的编码');
  }
  const res = await callWorker({ op: 'decode', format, data: bytes }, [bytes.buffer]);

  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    throw new Error('分享内容已损坏：数据格式不正确');
  }
  if (payload === null || typeof payload !== 'object' || typeof payload.v !== 'number') {
    throw new Error('分享内容已损坏：缺少版本信息');
  }

  const notices = [];
  let data = payload.data;
  if (payload.v > STATE_VERSION) {
    // 来自更新版本：尽力恢复，无法识别的字段会被丢弃
    notices.push(`该分享来自更新的版本 (v${payload.v})，已按兼容模式恢复，部分新选项可能丢失`);
  } else if (payload.v < STATE_VERSION) {
    try {
      data = migrate(data, payload.v);
    } catch {
      notices.push(`旧版本 (v${payload.v}) 数据无法完整迁移，已按兼容模式恢复`);
    }
    notices.push(`该分享来自旧版本 (v${payload.v})，已自动迁移到当前版本`);
  }
  return { state: coerce(data), notices };
}
