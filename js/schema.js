// 向导结构定义：步骤、字段、默认值、敏感字段、版本迁移。
// 敏感字段只保存在本地 IndexedDB，绝不进入序列化结果。

export const STATE_VERSION = 2;

export const STEPS = [
  {
    id: 'basic',
    title: '基本信息',
    desc: '填写联系人信息（标注“敏感”的字段不会被分享）',
    fields: [
      { key: 'name', label: '称呼', type: 'text', default: '' },
      { key: 'phone', label: '手机号', type: 'text', default: '', sensitive: true },
      { key: 'idNumber', label: '证件号', type: 'text', default: '', sensitive: true },
    ],
  },
  {
    id: 'plan',
    title: '套餐选择',
    desc: '选择一个套餐档位',
    fields: [
      {
        key: 'plan', label: '套餐', type: 'radio', default: 'standard',
        options: [
          { value: 'basic', label: '基础版' },
          { value: 'standard', label: '标准版' },
          { value: 'pro', label: '专业版' },
        ],
      },
    ],
  },
  {
    id: 'addons',
    title: '附加选项',
    desc: '按需勾选附加服务',
    fields: [
      {
        key: 'addons', label: '附加服务', type: 'checkbox-group', default: [],
        options: [
          { value: 'install', label: '上门安装' },
          { value: 'warranty', label: '延保一年' },
          { value: 'training', label: '使用培训' },
        ],
      },
    ],
  },
  {
    id: 'prefs',
    title: '偏好设置',
    desc: '界面与通知偏好',
    fields: [
      {
        key: 'theme', label: '主题', type: 'radio', default: 'light',
        options: [
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ],
      },
      { key: 'newsletter', label: '订阅通知邮件', type: 'checkbox', default: false },
    ],
  },
  {
    id: 'delivery',
    title: '配送信息',
    desc: '配送方式与时间（地址为敏感信息，不参与分享）',
    fields: [
      { key: 'address', label: '详细地址', type: 'text', default: '', sensitive: true },
      {
        key: 'slot', label: '配送时段', type: 'select', default: 'any',
        options: [
          { value: 'any', label: '任意时间' },
          { value: 'morning', label: '上午' },
          { value: 'afternoon', label: '下午' },
        ],
      },
    ],
  },
  {
    id: 'confirm',
    title: '确认',
    desc: '确认以下配置，可附备注',
    fields: [
      { key: 'note', label: '备注', type: 'textarea', default: '' },
    ],
  },
];

export function defaultState() {
  const state = {};
  for (const step of STEPS) {
    state[step.id] = {};
    for (const field of step.fields) {
      state[step.id][field.key] = structuredClone(field.default);
    }
  }
  return state;
}

export function sensitiveKeys() {
  const keys = new Set();
  for (const step of STEPS) {
    for (const field of step.fields) {
      if (field.sensitive) keys.add(`${step.id}.${field.key}`);
    }
  }
  return keys;
}

// 版本迁移表：把旧版本 payload 的 data 逐级迁移到当前版本。
// v1 -> v2: prefs.notify 改名为 prefs.newsletter；delivery.slot 新增默认值。
const MIGRATIONS = {
  1(data) {
    const next = structuredClone(data);
    if (next.prefs && 'notify' in next.prefs) {
      next.prefs.newsletter = Boolean(next.prefs.notify);
      delete next.prefs.notify;
    }
    if (next.delivery && !('slot' in next.delivery)) {
      next.delivery.slot = 'any';
    }
    return next;
  },
};

export function migrate(data, fromVersion) {
  let version = fromVersion;
  let current = data;
  while (version < STATE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`缺少 v${version} -> v${version + 1} 的迁移`);
    current = step(current);
    version += 1;
  }
  return current;
}
