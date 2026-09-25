/*
 * compress-worker.js — 在 Web Worker 中做 deflate-raw 压缩 / 解压，
 * 避免阻塞主线程。依赖原生 CompressionStream / DecompressionStream。
 *
 * 消息协议：
 *   入：{ id, action: 'compress'|'decompress', text }
 *     compress   text = 明文 JSON   -> result = 'WZC.<b64url>'
 *     decompress text = 'WZC.<b64url>' -> result = 明文 JSON
 *   出：{ id, ok, result | error }
 */
'use strict';

const PACKED_PREFIX = 'WZC';

function bytesToB64url(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeThrough(bytes, stream) {
  const writer = stream.writable.getWriter();
  // 写入失败（如解压数据损坏）会在读取端抛出，这里吞掉写入端的拒绝以避免未处理异常
  const writing = writer.write(bytes).then(() => writer.close()).catch(() => {});
  const response = new Response(stream.readable);
  const buffer = await response.arrayBuffer();
  await writing;
  return new Uint8Array(buffer);
}

async function compress(text) {
  const input = new TextEncoder().encode(text);
  const cs = new CompressionStream('deflate-raw');
  const packed = await pipeThrough(input, cs);
  return PACKED_PREFIX + '.' + bytesToB64url(packed);
}

async function decompress(text) {
  const dot = text.indexOf('.');
  if (dot === -1 || text.slice(0, dot) !== PACKED_PREFIX) {
    throw new Error('不是有效的压缩串（缺少 ' + PACKED_PREFIX + ' 前缀）');
  }
  const packed = b64urlToBytes(text.slice(dot + 1));
  const ds = new DecompressionStream('deflate-raw');
  const plain = await pipeThrough(packed, ds);
  return new TextDecoder().decode(plain);
}

self.onmessage = async function (event) {
  const { id, action, text } = event.data;
  try {
    const result = action === 'compress' ? await compress(text) : await decompress(text);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
