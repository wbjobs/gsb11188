// Web Worker：负责压缩 / 解压，避免阻塞 UI。
// 优先使用 CompressionStream(deflate-raw)；环境不支持时退化为不压缩（raw）。
// 消息协议:
//   { id, op: 'encode', text }      -> { id, ok, format, data: Uint8Array }
//   { id, op: 'decode', format, data } -> { id, ok, text }

async function pipe(bytes, stream) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const supportsStream = typeof CompressionStream === 'function';

self.onmessage = async (event) => {
  const { id, op } = event.data;
  try {
    if (op === 'encode') {
      const raw = new TextEncoder().encode(event.data.text);
      if (supportsStream) {
        const data = await pipe(raw, new CompressionStream('deflate-raw'));
        self.postMessage({ id, ok: true, format: 'd', data }, [data.buffer]);
      } else {
        self.postMessage({ id, ok: true, format: 'r', data: raw }, [raw.buffer]);
      }
    } else if (op === 'decode') {
      const data = new Uint8Array(event.data.data);
      let bytes;
      if (event.data.format === 'd') {
        if (!supportsStream) throw new Error('当前环境不支持解压该数据');
        bytes = await pipe(data, new DecompressionStream('deflate-raw'));
      } else if (event.data.format === 'r') {
        bytes = data;
      } else {
        throw new Error(`未知压缩格式: ${event.data.format}`);
      }
      self.postMessage({ id, ok: true, text: new TextDecoder().decode(bytes) });
    } else {
      throw new Error(`未知操作: ${op}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
