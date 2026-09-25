/*
 * serializer.js — 向导状态序列化 / 反序列化
 *
 * 职责：
 *  - 状态 -> 可分享字符串（明文 WZ 前缀，压缩由 Worker 完成，产物 WZC 前缀）
 *  - 敏感字段过滤（schema.sensitive + 内置 denylist 双保险）
 *  - FNV-1a 校验和，识别损坏 / 非法状态
 *  - 版本迁移（低版本升级）与版本降级（高版本尽力恢复）
 *
 * 环境无关：浏览器挂 window.WizardSerializer，Node 可 require 用于测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WizardSerializer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CURRENT_VERSION = 2;
  const PLAIN_PREFIX = 'WZ';   // 未压缩：WZ.<b64url(json)>
  const PACKED_PREFIX = 'WZC'; // 已压缩：WZC.<b64url(deflate-raw(json))>

  // 内置敏感 key 黑名单（不区分大小写，子串匹配），与 schema 标记互为补充
  const SENSITIVE_PATTERNS = [
    'password', 'passwd', 'secret', 'token', 'apikey', 'api_key',
    'phone', 'mobile', 'idcard', 'id_card', 'ssn', 'creditcard', 'card_no',
  ];

  /* ---------- base64url（UTF-8 安全） ---------- */

  function bytesToB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBytes(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function encodeText(str) {
    return bytesToB64url(new TextEncoder().encode(str));
  }

  function decodeText(b64url) {
    return new TextDecoder().decode(b64urlToBytes(b64url));
  }

  /* ---------- 校验和：FNV-1a 32bit ---------- */

  function checksum(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /* ---------- 敏感信息过滤 ---------- */

  function isSensitiveKey(key) {
    const lower = String(key).toLowerCase();
    return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
  }

  // 依据 schema 收集被标记为敏感的字段路径（data.<step>.<key>）
  function schemaSensitiveKeys(schema) {
    const set = new Set();
    if (!schema || !schema.steps) return set;
    for (const step of schema.steps) {
      for (const field of step.fields || []) {
        if (field.sensitive) set.add(step.id + '.' + field.key);
      }
    }
    return set;
  }

  /**
   * 返回 { clean, removed }：clean 为过滤后的深拷贝，removed 为被移除的字段路径。
   * 规则：schema 标记 sensitive 的字段 + key 命中内置黑名单的字段（任意层级）。
   */
  function filterSensitive(state, schema) {
    const removed = [];
    const marked = schemaSensitiveKeys(schema);

    function walk(node, path) {
      if (Array.isArray(node)) return node.map((v, i) => walk(v, path.concat(i)));
      if (node && typeof node === 'object') {
        const out = {};
        for (const [key, value] of Object.entries(node)) {
          const childPath = path.concat(key);
          const dotted = childPath.join('.');
          // path 形如 ['data', stepId, fieldKey]，与 schema 标记比对后两段
          const schemaPath = childPath.slice(1).join('.');
          if (isSensitiveKey(key) || marked.has(schemaPath)) {
            removed.push(dotted);
            continue;
          }
          out[key] = walk(value, childPath);
        }
        return out;
      }
      return node;
    }

    return { clean: walk(state, []), removed };
  }

  /* ---------- 版本迁移 ---------- */

  // 逐级迁移函数：MIGRATIONS[n] 把版本 n 的状态升级为 n+1
  const MIGRATIONS = {
    // v1 -> v2：主题字段 theme.color 更名为 theme.accent
    1(state) {
      const next = structuredClone(state);
      const theme = next.data && next.data.theme;
      if (theme && typeof theme === 'object' && 'color' in theme) {
        theme.accent = theme.color;
        delete theme.color;
      }
      next.v = 2;
      return next;
    },
  };

  function migrate(state, fromVersion) {
    let current = state;
    const notes = [];
    for (let v = fromVersion; v < CURRENT_VERSION; v++) {
      const fn = MIGRATIONS[v];
      if (!fn) throw new Error('缺少 v' + v + ' -> v' + (v + 1) + ' 的迁移逻辑');
      current = fn(current);
      notes.push('v' + v + ' → v' + (v + 1));
    }
    return { state: current, notes };
  }

  /* ---------- 序列化 ---------- */

  /**
   * state: { v, step, data }；schema 见 app.js。
   * 返回 { json, plain, removed }：
   *  - json   过滤敏感信息并附校验和后的 JSON 字符串（压缩 Worker 的输入）
   *  - plain  未压缩的可分享字符串
   *  - removed 被过滤掉的敏感字段路径
   */
  function serialize(state, schema) {
    const { clean, removed } = filterSensitive(state, schema);
    const envelope = {
      v: CURRENT_VERSION,
      step: clean.step,
      data: clean.data || {},
    };
    const body = JSON.stringify(envelope);
    const payload = JSON.stringify({ c: checksum(body), body: envelope });
    return { json: payload, plain: PLAIN_PREFIX + '.' + encodeText(payload), removed };
  }

  /* ---------- 反序列化 ---------- */

  const ERR = {
    EMPTY: '内容为空',
    BAD_PREFIX: '无法识别的格式（缺少 WZ/WZC 前缀）',
    BAD_BASE64: '内容损坏（Base64 解码失败）',
    BAD_JSON: '内容损坏（JSON 解析失败）',
    BAD_CRC: '校验和不匹配，数据可能已被篡改或截断',
    BAD_SHAPE: '状态结构不完整',
  };

  function fail(error) {
    return { ok: false, error };
  }

  /**
   * 解析序列化字符串。
   * packedJson 用于压缩分支：调用方（Worker 解压后）传入解压出的 JSON 字符串。
   * 返回 { ok, state, migrated, downgraded, warnings, removed? } 或 { ok:false, error }
   */
  function deserialize(input, schema, packedJson) {
    let jsonText;

    if (typeof packedJson === 'string') {
      jsonText = packedJson;
    } else {
      if (!input || typeof input !== 'string') return fail(ERR.EMPTY);
      const text = input.trim();
      const dot = text.indexOf('.');
      const prefix = dot === -1 ? text : text.slice(0, dot);
      if (prefix !== PLAIN_PREFIX) {
        // 压缩串应由调用方先解压；这里收到说明流程有误或格式未知
        return fail(prefix === PACKED_PREFIX ? ERR.BAD_PREFIX : ERR.BAD_PREFIX);
      }
      try {
        jsonText = decodeText(text.slice(dot + 1));
      } catch (e) {
        return fail(ERR.BAD_BASE64);
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return fail(ERR.BAD_JSON);
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.c !== 'string' || !parsed.body) {
      return fail(ERR.BAD_SHAPE);
    }

    const body = parsed.body;
    if (checksum(JSON.stringify(body)) !== parsed.c) return fail(ERR.BAD_CRC);
    if (typeof body.v !== 'number' || typeof body.step !== 'number' ||
        !body.data || typeof body.data !== 'object') {
      return fail(ERR.BAD_SHAPE);
    }

    const warnings = [];
    let state = { v: body.v, step: body.step, data: body.data };
    let migrated = false;
    let downgraded = false;

    if (body.v > CURRENT_VERSION) {
      // 高版本降级：仅保留当前版本认识的字段，其余丢弃
      downgraded = true;
      state = downgrade(state, schema);
      state.v = CURRENT_VERSION;
      warnings.push('链接来自更新的版本（v' + body.v + '），已按 v' + CURRENT_VERSION + ' 尽力恢复，未知字段被忽略');
    } else if (body.v < CURRENT_VERSION) {
      try {
        const result = migrate(state, body.v);
        state = result.state;
        migrated = true;
        warnings.push('旧版本数据（v' + body.v + '）已自动迁移：' + result.notes.join('，'));
      } catch (e) {
        return fail('版本迁移失败：' + e.message);
      }
    }

    // 反序列化同样过一遍敏感过滤，防止手工构造的链接夹带敏感字段
    const { clean, removed } = filterSensitive(state, schema);
    if (removed.length) warnings.push('已剔除链接中的敏感字段：' + removed.join(', '));

    // step 越界收敛
    const stepCount = schema && schema.steps ? schema.steps.length : 0;
    if (stepCount > 0 && (clean.step < 0 || clean.step >= stepCount)) {
      warnings.push('步骤序号越界，已回到第一步');
      clean.step = 0;
    }

    return { ok: true, state: clean, migrated, downgraded, warnings };
  }

  // 高版本降级：按 schema 白名单裁剪 data
  function downgrade(state, schema) {
    const known = { v: state.v, step: state.step, data: {} };
    if (!schema || !schema.steps) return { v: state.v, step: state.step, data: state.data };
    for (const step of schema.steps) {
      const src = state.data ? state.data[step.id] : undefined;
      if (!src || typeof src !== 'object') continue;
      const dst = {};
      for (const field of step.fields || []) {
        if (field.key in src) dst[field.key] = src[field.key];
      }
      if (Object.keys(dst).length) known.data[step.id] = dst;
    }
    return known;
  }

  return {
    CURRENT_VERSION,
    PLAIN_PREFIX,
    PACKED_PREFIX,
    ERR,
    serialize,
    deserialize,
    filterSensitive,
    checksum,
    encodeText,
    decodeText,
    bytesToB64url,
    b64urlToBytes,
  };
});
