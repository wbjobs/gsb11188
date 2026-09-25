/*
 * app.js — 六步向导主逻辑
 * 状态流：表单 <-> state -> IndexedDB（刷新保持）
 * 分享流：state -> 过滤敏感 -> 校验和 -> Worker 压缩 -> URL hash（超限降级为短键）
 */
(function () {
  'use strict';

  const S = window.WizardSerializer;
  const Store = window.WizardStorage;

  const URL_LIMIT = 2000; // 保守的 URL 长度上限
  const HASH_STATE = 's=';  // #s=<序列化串>
  const HASH_KEY = 'k=';    // #k=<IndexedDB 短键>（超限降级）

  /* ---------- 向导 schema：6 步，敏感字段用 sensitive 标记 ---------- */

  const SCHEMA = {
    steps: [
      {
        id: 'plan', title: '套餐',
        fields: [
          { key: 'tier', label: '选择套餐', type: 'radio',
            options: [['basic', '基础版'], ['pro', '专业版'], ['team', '团队版']] },
        ],
      },
      {
        id: 'billing', title: '计费',
        fields: [
          { key: 'cycle', label: '计费周期', type: 'radio',
            options: [['monthly', '按月'], ['yearly', '按年（省 20%）']] },
          { key: 'seats', label: '席位', type: 'radio',
            options: [['1', '1 人'], ['5', '5 人'], ['20', '20 人']] },
        ],
      },
      {
        id: 'addons', title: '增值功能',
        fields: [
          { key: 'features', label: '勾选需要的功能', type: 'checkbox',
            options: [['analytics', '数据分析'], ['backup', '自动备份'], ['sso', '单点登录']] },
        ],
      },
      {
        id: 'theme', title: '外观',
        fields: [
          { key: 'mode', label: '主题模式', type: 'radio',
            options: [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']] },
          { key: 'accent', label: '强调色', type: 'radio',
            options: [['blue', '蓝'], ['green', '绿'], ['orange', '橙']] },
        ],
      },
      {
        id: 'profile', title: '联系人',
        fields: [
          { key: 'nickname', label: '昵称', type: 'text' },
          { key: 'phone', label: '手机号', type: 'tel', sensitive: true },
          { key: 'email', label: '邮箱', type: 'text', sensitive: true },
        ],
      },
      {
        id: 'confirm', title: '确认',
        fields: [
          { key: 'note', label: '备注', type: 'text' },
          { key: 'agree', label: '我确认以上选择', type: 'checkbox',
            options: [['yes', '我确认以上选择']] },
        ],
      },
    ],
  };

  /* ---------- 状态 ---------- */

  function defaultState() {
    return {
      v: S.CURRENT_VERSION,
      step: 0,
      data: {
        plan: { tier: 'basic' },
        billing: { cycle: 'monthly', seats: '1' },
        addons: { features: [] },
        theme: { mode: 'auto', accent: 'blue' },
        profile: { nickname: '', phone: '', email: '' },
        confirm: { note: '', agree: [] },
      },
    };
  }

  let state = defaultState();

  /* ---------- DOM ---------- */

  const $ = (sel) => document.querySelector(sel);
  const stepperEl = $('#stepper');
  const containerEl = $('#step-container');
  const toastEl = $('#toast');

  let toastTimer = null;
  function toast(message, kind) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3600);
  }

  function renderStepper() {
    stepperEl.innerHTML = '';
    SCHEMA.steps.forEach((step, index) => {
      const dot = document.createElement('span');
      dot.className = 'dot' + (index === state.step ? ' active' : index < state.step ? ' done' : '');
      dot.textContent = (index + 1) + '. ' + step.title;
      dot.addEventListener('click', () => { state.step = index; persist(); render(); });
      stepperEl.appendChild(dot);
    });
  }

  function renderStep() {
    const step = SCHEMA.steps[state.step];
    containerEl.innerHTML = '';
    const stepData = state.data[step.id] || (state.data[step.id] = {});

    for (const field of step.fields) {
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = field.label;
      if (field.sensitive) {
        const badge = document.createElement('span');
        badge.className = 'badge-sensitive';
        badge.textContent = '敏感，不随链接分享';
        legend.appendChild(badge);
      }
      fieldset.appendChild(legend);

      if (field.type === 'radio' || field.type === 'checkbox') {
        for (const [value, label] of field.options) {
          const option = document.createElement('label');
          option.className = 'option';
          const input = document.createElement('input');
          input.type = field.type;
          input.name = step.id + '.' + field.key;
          input.value = value;
          if (field.type === 'radio') {
            input.checked = stepData[field.key] === value;
          } else {
            input.checked = Array.isArray(stepData[field.key]) && stepData[field.key].includes(value);
          }
          input.addEventListener('change', () => {
            if (field.type === 'radio') {
              stepData[field.key] = value;
            } else {
              const list = Array.isArray(stepData[field.key]) ? stepData[field.key] : [];
              stepData[field.key] = input.checked
                ? list.concat(value)
                : list.filter((v) => v !== value);
            }
            persist();
          });
          option.appendChild(input);
          option.appendChild(document.createTextNode(label));
          fieldset.appendChild(option);
        }
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'field';
        const input = document.createElement('input');
        input.type = field.type === 'tel' ? 'tel' : 'text';
        input.value = stepData[field.key] || '';
        input.addEventListener('input', () => {
          stepData[field.key] = input.value;
          persist();
        });
        wrap.appendChild(input);
        fieldset.appendChild(wrap);
      }
      containerEl.appendChild(fieldset);
    }

    $('#btn-prev').disabled = state.step === 0;
    $('#btn-next').disabled = state.step === SCHEMA.steps.length - 1;
  }

  function render() {
    renderStepper();
    renderStep();
  }

  /* ---------- 持久化（刷新保持） ---------- */

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Store.saveState(state).catch(() => toast('本地保存失败', 'error'));
    }, 150);
  }

  /* ---------- 压缩 Worker ---------- */

  let worker = null;
  let msgId = 0;
  const pending = new Map();

  function getWorker() {
    if (!worker) {
      worker = new Worker('js/compress-worker.js');
      worker.onmessage = (event) => {
        const { id, ok, result, error } = event.data;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        ok ? entry.resolve(result) : entry.reject(new Error(error));
      };
      worker.onerror = () => {
        pending.forEach((entry) => entry.reject(new Error('Worker 异常')));
        pending.clear();
      };
    }
    return worker;
  }

  const compressionSupported =
    typeof Worker !== 'undefined' && typeof CompressionStream !== 'undefined';

  function compress(text) {
    if (!compressionSupported) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, action: 'compress', text });
    });
  }

  function decompress(text) {
    if (!compressionSupported) return Promise.reject(new Error('当前环境不支持解压'));
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, action: 'decompress', text });
    });
  }

  /* ---------- 分享 ---------- */

  function buildUrl(fragment) {
    const url = new URL(location.href);
    url.hash = fragment;
    return url.toString();
  }

  function randomKey() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return S.bytesToB64url(bytes);
  }

  async function share() {
    const { json, plain, removed } = S.serialize(state, SCHEMA);
    if (removed.length) {
      toast('已过滤敏感字段：' + removed.join(', '), 'warn');
    }

    let packed = null;
    try {
      packed = await compress(json);
    } catch (e) {
      // 压缩失败降级为明文串
    }
    const payload = packed || plain;
    let url = buildUrl(HASH_STATE + payload);
    let info;

    if (url.length <= URL_LIMIT) {
      info = '链接长度 ' + url.length + ' 字符' + (packed ? '（已压缩）' : '（未压缩）') + '，可直接分享。';
    } else {
      // 超限降级：完整串存入 IndexedDB，链接只带短键（仅同一浏览器可恢复）；
      // 同时把完整串放进文本框，可手动复制给能跑完整 URL 的渠道。
      const key = randomKey();
      try {
        await Store.saveShare(key, payload);
        url = buildUrl(HASH_KEY + key);
        info = '链接超长（' + url.length + ' → 超限），已降级为短键链接（仅本浏览器有效）。' +
               '文本框内是完整序列化串，可手动复制。';
      } catch (e) {
        info = '链接超长且本地存储不可用，请手动复制文本框中的完整序列化串。';
      }
      $('#share-output').value = payload;
    }

    if (!$('#share-output').value) $('#share-output').value = url;
    $('#share-info').textContent = info;
    $('#share-panel').classList.remove('hidden');
    $('#btn-view-raw').dataset.json = json;
    $('#raw-state').classList.add('hidden');
    history.replaceState(null, '', url);
  }

  /* ---------- 从链接 / 本地恢复 ---------- */

  async function restoreFromHash() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return false;

    let payload = null;
    if (hash.startsWith(HASH_KEY)) {
      const key = hash.slice(HASH_KEY.length);
      try {
        payload = await Store.loadShare(key);
      } catch (e) { /* fallthrough */ }
      if (!payload) {
        toast('短键链接仅在其生成的浏览器中有效，本地未找到对应数据', 'error');
        return false;
      }
    } else if (hash.startsWith(HASH_STATE)) {
      payload = hash.slice(HASH_STATE.length);
    } else {
      toast(S.ERR.BAD_PREFIX, 'error');
      return false;
    }

    let result;
    if (payload.startsWith(S.PACKED_PREFIX + '.')) {
      let json;
      try {
        json = await decompress(payload);
      } catch (e) {
        toast('解压失败：' + e.message, 'error');
        return false;
      }
      result = S.deserialize(null, SCHEMA, json);
    } else {
      result = S.deserialize(payload, SCHEMA);
    }

    if (!result.ok) {
      toast('无法恢复分享状态：' + result.error, 'error');
      return false;
    }

    // 与本地默认状态合并，容忍缺失的分步数据
    const merged = defaultState();
    merged.step = result.state.step;
    for (const step of SCHEMA.steps) {
      if (result.state.data[step.id]) {
        merged.data[step.id] = Object.assign({}, merged.data[step.id], result.state.data[step.id]);
      }
    }
    state = merged;
    persist();

    (result.warnings || []).forEach((w) => toast(w, 'warn'));
    if (!result.warnings || !result.warnings.length) toast('已从分享链接恢复状态');
    return true;
  }

  async function boot() {
    const fromLink = await restoreFromHash();
    if (!fromLink) {
      try {
        const saved = await Store.loadState();
        if (saved && saved.data) {
          state = Object.assign(defaultState(), saved);
          if (state.step < 0 || state.step >= SCHEMA.steps.length) state.step = 0;
        }
      } catch (e) { /* IndexedDB 不可用时使用默认状态 */ }
    }
    render();
  }

  /* ---------- 事件 ---------- */

  $('#btn-prev').addEventListener('click', () => {
    if (state.step > 0) { state.step--; persist(); render(); }
  });
  $('#btn-next').addEventListener('click', () => {
    if (state.step < SCHEMA.steps.length - 1) { state.step++; persist(); render(); }
  });
  $('#btn-share').addEventListener('click', () => {
    share().catch((e) => toast('生成分享链接失败：' + e.message, 'error'));
  });
  $('#btn-reset').addEventListener('click', () => {
    state = defaultState();
    Store.clearState().catch(() => {});
    history.replaceState(null, '', location.pathname + location.search);
    $('#share-panel').classList.add('hidden');
    render();
    toast('已重置');
  });
  $('#btn-copy').addEventListener('click', async () => {
    const output = $('#share-output');
    try {
      await navigator.clipboard.writeText(output.value);
      toast('已复制');
    } catch (e) {
      output.select();
      document.execCommand('copy');
      toast('已复制');
    }
  });
  $('#btn-view-raw').addEventListener('click', () => {
    const raw = $('#raw-state');
    const json = $('#btn-view-raw').dataset.json;
    if (raw.classList.contains('hidden')) {
      try {
        raw.textContent = JSON.stringify(JSON.parse(json).body, null, 2);
      } catch (e) {
        raw.textContent = json;
      }
      raw.classList.remove('hidden');
    } else {
      raw.classList.add('hidden');
    }
  });

  window.addEventListener('hashchange', () => {
    restoreFromHash().then((ok) => { if (ok) render(); });
  });

  boot();
})();
