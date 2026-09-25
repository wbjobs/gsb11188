import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../js/serializer.js');

// 与 app.js 中一致的 schema（精简版）
const SCHEMA = {
  steps: [
    { id: 'plan', fields: [{ key: 'tier' }] },
    { id: 'billing', fields: [{ key: 'cycle' }, { key: 'seats' }] },
    { id: 'addons', fields: [{ key: 'features' }] },
    { id: 'theme', fields: [{ key: 'mode' }, { key: 'accent' }] },
    { id: 'profile', fields: [{ key: 'nickname' }, { key: 'phone', sensitive: true }, { key: 'email', sensitive: true }] },
    { id: 'confirm', fields: [{ key: 'note' }, { key: 'agree' }] },
  ],
};

function sampleState() {
  return {
    v: S.CURRENT_VERSION,
    step: 3,
    data: {
      plan: { tier: 'pro' },
      billing: { cycle: 'yearly', seats: '5' },
      addons: { features: ['analytics', 'sso'] },
      theme: { mode: 'dark', accent: 'green' },
      profile: { nickname: '小明', phone: '13800001111', email: 'a@b.com' },
      confirm: { note: '尽快开通', agree: ['yes'] },
    },
  };
}

// 通过 self 垫片加载真实的 compress-worker.js，验证 Worker 内压缩逻辑
function loadWorker() {
  const listeners = {};
  const self = {
    onmessage: null,
    postMessage(msg) { self.__last = msg; },
  };
  const src = readFileSync(new URL('../js/compress-worker.js', import.meta.url), 'utf8');
  new Function('self', src)(self);
  return {
    async call(action, text) {
      const id = 1;
      const done = new Promise((resolve, reject) => {
        self.postMessage = (msg) => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error)));
      });
      await self.onmessage({ data: { id, action, text } });
      return done;
    },
  };
}

test('任意步骤状态均可序列化并精确恢复', () => {
  for (let step = 0; step < SCHEMA.steps.length; step++) {
    const state = sampleState();
    state.step = step;
    const { plain } = S.serialize(state, SCHEMA);
    const result = S.deserialize(plain, SCHEMA);
    assert.equal(result.ok, true, 'step=' + step);
    assert.equal(result.state.step, step);
    assert.deepEqual(result.state.data.plan, state.data.plan);
    assert.deepEqual(result.state.data.addons, state.data.addons);
    assert.deepEqual(result.state.data.theme, state.data.theme);
  }
});

test('敏感信息被过滤（schema 标记 + 内置黑名单）', () => {
  const state = sampleState();
  const { plain, removed, json } = S.serialize(state, SCHEMA);
  assert.ok(removed.includes('data.profile.phone'));
  assert.ok(removed.includes('data.profile.email'));
  assert.ok(!json.includes('13800001111'));
  assert.ok(!json.includes('a@b.com'));
  const result = S.deserialize(plain, SCHEMA);
  assert.equal(result.state.data.profile.phone, undefined);
  assert.equal(result.state.data.profile.nickname, '小明');

  // 手工构造夹带敏感字段的链接，反序列化时也会被剔除
  const evil = JSON.parse(json);
  evil.body.data.profile.phone = '13999999999';
  evil.body.data.confirm.token = 'secret-token';
  evil.c = S.checksum(JSON.stringify(evil.body));
  const forged = 'WZ.' + S.encodeText(JSON.stringify(evil));
  const r2 = S.deserialize(forged, SCHEMA);
  assert.equal(r2.ok, true);
  assert.equal(r2.state.data.profile.phone, undefined);
  assert.equal(r2.state.data.confirm.token, undefined);
  assert.ok(r2.warnings.some((w) => w.includes('敏感')));
});

test('非法状态有明确错误提示', () => {
  assert.equal(S.deserialize('', SCHEMA).ok, false);
  assert.equal(S.deserialize('XXX.abc', SCHEMA).error, S.ERR.BAD_PREFIX);
  assert.equal(S.deserialize('WZ.!!!not-base64!!!', SCHEMA).ok, false);
  assert.equal(S.deserialize('WZ.aGVsbG8', SCHEMA).ok, false); // 合法 b64 但非 JSON 结构

  // 篡改内容 -> 校验和不匹配
  const { plain } = S.serialize(sampleState(), SCHEMA);
  const payload = JSON.parse(S.decodeText(plain.slice(3)));
  payload.body.data.plan.tier = 'team';
  const tampered = 'WZ.' + S.encodeText(JSON.stringify(payload));
  assert.equal(S.deserialize(tampered, SCHEMA).error, S.ERR.BAD_CRC);
});

test('低版本数据自动迁移（v1 theme.color -> v2 theme.accent）', () => {
  const v1body = { v: 1, step: 3, data: { theme: { color: 'orange', mode: 'dark' } } };
  const payload = JSON.stringify({ c: S.checksum(JSON.stringify(v1body)), body: v1body });
  const result = S.deserialize('WZ.' + S.encodeText(payload), SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.state.v, S.CURRENT_VERSION);
  assert.equal(result.state.data.theme.accent, 'orange');
  assert.equal(result.state.data.theme.color, undefined);
});

test('高版本数据降级恢复，未知字段被忽略', () => {
  const future = {
    v: 99, step: 1,
    data: { plan: { tier: 'pro', hologram: true }, unknownStep: { x: 1 } },
  };
  const payload = JSON.stringify({ c: S.checksum(JSON.stringify(future)), body: future });
  const result = S.deserialize('WZ.' + S.encodeText(payload), SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.downgraded, true);
  assert.equal(result.state.v, S.CURRENT_VERSION);
  assert.equal(result.state.data.plan.tier, 'pro');
  assert.equal(result.state.data.plan.hologram, undefined);
  assert.equal(result.state.data.unknownStep, undefined);
  assert.ok(result.warnings.some((w) => w.includes('v99')));
});

test('步骤越界收敛到第一步', () => {
  const body = { v: S.CURRENT_VERSION, step: 42, data: {} };
  const payload = JSON.stringify({ c: S.checksum(JSON.stringify(body)), body });
  const result = S.deserialize('WZ.' + S.encodeText(payload), SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.state.step, 0);
});

test('Worker 压缩往返：压缩串可解压并精确恢复', async () => {
  const worker = loadWorker();
  const state = sampleState();
  const { json } = S.serialize(state, SCHEMA);

  const packed = await worker.call('compress', json);
  assert.ok(packed.startsWith('WZC.'));
  assert.ok(packed.length < ('WZ.' + S.encodeText(json)).length, '压缩后应更短');

  const unpacked = await worker.call('decompress', packed);
  assert.equal(unpacked, json);

  const result = S.deserialize(null, SCHEMA, unpacked);
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.data.billing, state.data.billing);
});

test('Worker 拒绝损坏的压缩串', async () => {
  const worker = loadWorker();
  await assert.rejects(() => worker.call('decompress', 'WZ.abc'), /WZC/);
  await assert.rejects(() => worker.call('decompress', 'WZC.corrupted-data'));
});

test('序列化结果可读：明文格式可解码为 JSON', () => {
  const { plain } = S.serialize(sampleState(), SCHEMA);
  assert.ok(plain.startsWith('WZ.'));
  const decoded = JSON.parse(S.decodeText(plain.slice(3)));
  assert.equal(typeof decoded.c, 'string');
  assert.equal(decoded.body.v, S.CURRENT_VERSION);
});

test('URL 长度可预估，超限场景有短键降级所需数据', () => {
  const big = sampleState();
  big.data.confirm.note = '长'.repeat(5000);
  const { plain } = S.serialize(big, SCHEMA);
  const fakeUrl = 'https://example.com/#s=' + plain;
  assert.ok(fakeUrl.length > 2000, '构造出超限 URL');
  // 降级方案依赖：payload 是可独立存储/恢复的完整串
  const result = S.deserialize(plain, SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.state.data.confirm.note.length, 5000);
});
