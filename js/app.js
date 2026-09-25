import { STEPS, defaultState } from './schema.js';
import { db } from './db.js';
import { serialize, deserialize } from './serializer.js';

// 超过该长度的 URL 在部分浏览器/IM 中会被截断，触发降级方案
const URL_LIMIT = 1800;

let state = defaultState();
let currentStep = 0;

const $ = (sel) => document.querySelector(sel);
const stepNav = $('#stepNav');
const stepPanel = $('#stepPanel');
const toast = $('#toast');

let toastTimer = null;
function showToast(message, kind = '') {
  toast.textContent = message;
  toast.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

// ---------- 渲染 ----------
function renderNav() {
  stepNav.innerHTML = '';
  STEPS.forEach((step, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dot' + (i === currentStep ? ' active' : i < currentStep ? ' done' : '');
    btn.textContent = `${i + 1}. ${step.title}`;
    btn.addEventListener('click', () => { currentStep = i; render(); });
    stepNav.appendChild(btn);
  });
}

function renderField(step, field) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const value = state[step.id][field.key];

  const label = document.createElement('label');
  label.textContent = field.label;
  if (field.sensitive) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '敏感 · 不分享';
    label.appendChild(tag);
  }
  wrap.appendChild(label);

  const update = (next) => {
    state[step.id][field.key] = next;
    persist();
  };

  if (field.type === 'text' || field.type === 'textarea') {
    const input = document.createElement(field.type === 'text' ? 'input' : 'textarea');
    if (field.type === 'text') input.type = 'text';
    input.value = value;
    input.addEventListener('input', () => update(input.value));
    wrap.appendChild(input);
  } else if (field.type === 'select') {
    const select = document.createElement('select');
    for (const opt of field.options) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener('change', () => update(select.value));
    wrap.appendChild(select);
  } else if (field.type === 'radio') {
    for (const opt of field.options) {
      const row = document.createElement('label');
      row.className = 'option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `${step.id}.${field.key}`;
      input.checked = value === opt.value;
      input.addEventListener('change', () => update(opt.value));
      row.append(input, opt.label);
      wrap.appendChild(row);
    }
  } else if (field.type === 'checkbox') {
    const row = document.createElement('label');
    row.className = 'option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
    input.addEventListener('change', () => update(input.checked));
    row.append(input, '启用');
    wrap.appendChild(row);
  } else if (field.type === 'checkbox-group') {
    for (const opt of field.options) {
      const row = document.createElement('label');
      row.className = 'option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Array.isArray(value) && value.includes(opt.value);
      input.addEventListener('change', () => {
        const set = new Set(Array.isArray(state[step.id][field.key]) ? state[step.id][field.key] : []);
        input.checked ? set.add(opt.value) : set.delete(opt.value);
        update([...set]);
      });
      row.append(input, opt.label);
      wrap.appendChild(row);
    }
  }
  return wrap;
}

function renderSummary() {
  const table = document.createElement('table');
  table.className = 'summary-table';
  for (const step of STEPS) {
    if (step.id === 'confirm') continue;
    for (const field of step.fields) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = field.label + (field.sensitive ? '（敏感）' : '');
      const val = document.createElement('td');
      const raw = state[step.id][field.key];
      if (field.options) {
        const values = Array.isArray(raw) ? raw : [raw];
        val.textContent = values
          .map((v) => field.options.find((o) => o.value === v)?.label ?? v)
          .join('、') || '—';
      } else {
        val.textContent = raw === '' || raw == null ? '—' : String(raw);
      }
      tr.append(name, val);
      table.appendChild(tr);
    }
  }
  return table;
}

function renderStep() {
  const step = STEPS[currentStep];
  stepPanel.innerHTML = '';
  const h2 = document.createElement('h2');
  h2.textContent = `第 ${currentStep + 1} 步 · ${step.title}`;
  const desc = document.createElement('p');
  desc.className = 'desc';
  desc.textContent = step.desc;
  stepPanel.append(h2, desc);
  if (step.id === 'confirm') stepPanel.appendChild(renderSummary());
  for (const field of step.fields) stepPanel.appendChild(renderField(step, field));
}

function render() {
  renderNav();
  renderStep();
  $('#prevBtn').disabled = currentStep === 0;
  $('#nextBtn').disabled = currentStep === STEPS.length - 1;
}

// ---------- 持久化（刷新保持） ----------
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.saveState(state).catch(() => showToast('本地保存失败', 'error'));
  }, 200);
}

// ---------- 分享 ----------
function shareUrlFor(fragment) {
  const url = new URL(location.href);
  url.hash = fragment;
  return url.toString();
}

async function generateShare() {
  try {
    const { string, payload } = await serialize(state);
    const inlineUrl = shareUrlFor(`c=${string}`);
    let url = inlineUrl;
    let meta = `长度 ${inlineUrl.length} 字符`;

    if (inlineUrl.length > URL_LIMIT) {
      // 降级：完整内容存入本地 IndexedDB，URL 只带短 id
      const id = Math.random().toString(36).slice(2, 10);
      await db.saveShare(id, string);
      url = shareUrlFor(`s=${id}`);
      meta = `完整链接 ${inlineUrl.length} 字符，超过 ${URL_LIMIT} 上限，已降级为短链接（仅本浏览器可打开）；跨设备请复制完整字符串`;
      $('#urlMeta').classList.add('warn');
    } else {
      $('#urlMeta').classList.remove('warn');
    }

    $('#shareUrl').value = url;
    $('#shareString').value = string;
    $('#urlMeta').textContent = meta;
    $('#readableJson').textContent = JSON.stringify(payload, null, 2);
    $('#sharePanel').classList.remove('hidden');
    showToast('分享链接已生成（敏感信息已过滤）');
  } catch (err) {
    showToast(`生成分享失败：${err.message}`, 'error');
  }
}

async function restoreFromString(input) {
  try {
    const { state: restored, notices } = await deserialize(input);
    state = restored;
    await db.saveState(state);
    currentStep = 0;
    render();
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    showToast(notices.length ? notices.join('；') : '已从分享内容恢复状态', notices.length ? 'warn' : '');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ---------- 启动 ----------
async function boot() {
  render();
  const hash = location.hash.slice(1);
  if (hash.startsWith('c=')) {
    await restoreFromString(hash.slice(2));
    return;
  }
  if (hash.startsWith('s=')) {
    const stored = await db.loadShare(hash.slice(2)).catch(() => null);
    if (stored) {
      await restoreFromString(stored);
    } else {
      showToast('短链接对应的分享内容不在本浏览器中，请向对方索取完整字符串粘贴恢复', 'error');
    }
    return;
  }
  const saved = await db.loadState().catch(() => null);
  if (saved) {
    state = saved;
    render();
  }
}

$('#prevBtn').addEventListener('click', () => { if (currentStep > 0) { currentStep--; render(); } });
$('#nextBtn').addEventListener('click', () => { if (currentStep < STEPS.length - 1) { currentStep++; render(); } });
$('#shareBtn').addEventListener('click', generateShare);
$('#resetBtn').addEventListener('click', async () => {
  state = defaultState();
  currentStep = 0;
  await db.clearState().catch(() => {});
  render();
  showToast('已重置');
});
$('#copyUrlBtn').addEventListener('click', () => copyText($('#shareUrl').value));
$('#copyStringBtn').addEventListener('click', () => copyText($('#shareString').value));
$('#importBtn').addEventListener('click', () => {
  const value = $('#importString').value.trim();
  if (value) restoreFromString(value);
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    showToast('复制失败，请手动选择复制', 'error');
  }
}

boot();
