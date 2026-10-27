/**
 * dsh-plugin-retry-backoff — client (browser) half.
 *
 * 一个编译好的浏览器模块（`window.__ModuleLoader__.load({ id, factory })` 形态），
 * 与宿主半边同包发布。宿主在启动时读 package.json 的 `dsh.client` 清单把它注入前端。
 *
 * ⚠️ 这份代码**同时**跑在网页端与桌面端：它只依赖 `window` / `document` / `fetch`，
 * 与宿主形态无关（桌面端壳内嵌的是同一份前端产物）。设置读写走同源 HTTP 路由
 * （见宿主半边的 `lib/routes.js`），所以两种宿主里行为一致。
 *
 * 面板挂在官方设置界面的 `settings.section` 座位上（与 wallpaper-engine /
 * skin-center 同一机制）：它自己成为设置导航里的一行，而不是往别人的页面里塞控件。
 */

import { DEFAULTS, LIMITS, RETRYABLE_CODE_CHOICES, sanitizeSettings } from './settings-schema.js';

/** 座位 id（设置导航里的稳定标识）。 */
const SECTION_ID = 'retry-backoff';
/** 与宿主 `lib/routes.js` 的 BASE 同源。 */
const BASE = '/retry-backoff';

/** 本地预览用的设置副本；面板渲染与预览曲线都读它。 */
let draft = sanitizeSettings(DEFAULTS);
/** 最近一次从宿主读到的运行时事实。设置存在插件自己的文件里，默认即可写。 */
let runtime = { writable: true, storage: 'file' };
/** 保存状态文案。 */
let status = '';

/**
 * 取设置（GET <BASE>/settings）。
 * @returns {Promise<object|null>} 宿主载荷，失败返回 null。
 */
async function loadSettings() {
  try {
    const res = await fetch(`${BASE}/settings`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 写设置（PUT <BASE>/settings）；面板提交完整快照。
 * @param {object} next - 完整设置对象。
 * @returns {Promise<object|null>} 宿主回读的载荷，失败返回 null。
 */
async function saveSettings(next) {
  try {
    const res = await fetch(`${BASE}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 恢复默认（POST <BASE>/reset）。 */
async function resetSettings() {
  try {
    const res = await fetch(`${BASE}/reset`, { method: 'POST' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 毫秒 → 人类可读（面板与预览共用，避免两处各写一份格式化）。 */
function formatDelay(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)} 秒`;
  }
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} 分钟`;
}

/** 面板里的一个数字滑杆（返回 React 元素）。 */
function NumberRow(React, { label, hint, value, limit, onChange }) {
  return React.createElement(
    'label',
    { className: 'rb-row', key: label },
    React.createElement('span', { className: 'rb-row-head' },
      React.createElement('span', { className: 'rb-row-label' }, label),
      React.createElement('span', { className: 'rb-row-value' },
        limit.format ? limit.format(value) : String(value)),
    ),
    React.createElement('input', {
      type: 'range',
      min: limit.min,
      max: limit.max,
      step: limit.step,
      value,
      onChange: (event) => onChange(Number(event.target.value)),
    }),
    hint ? React.createElement('span', { className: 'rb-hint' }, hint) : null,
  );
}

/** 面板里的一个开关。 */
function ToggleRow(React, { label, hint, checked, onChange }) {
  return React.createElement(
    'label',
    { className: 'rb-row rb-toggle', key: label },
    React.createElement('input', {
      type: 'checkbox',
      checked,
      onChange: (event) => onChange(event.target.checked),
    }),
    React.createElement('span', { className: 'rb-row-head' },
      React.createElement('span', { className: 'rb-row-label' }, label),
      hint ? React.createElement('span', { className: 'rb-hint' }, hint) : null,
    ),
  );
}

/**
 * 退避曲线预览：把"第 N 轮等多久"直接画出来，用户不必脑内算 2^n。
 */
function CurvePreview(React, settings) {
  const rows = [];
  for (let round = 1; round <= settings.maxRounds; round += 1) {
    const exponent = Math.max(0, Math.min(round - 1, 64));
    const raw = Math.min(settings.initialDelayMs * settings.multiplier ** exponent, settings.maxDelayMs);
    rows.push({ round, ms: Math.round(raw) });
  }
  const widest = rows.length ? rows[rows.length - 1].ms : 1;

  return React.createElement(
    'div',
    { className: 'rb-curve' },
    React.createElement('div', { className: 'rb-curve-title' },
      settings.maxRounds === 0
        ? '当前为 0 轮 —— 本插件不会介入，交回 DSH 原生重试策略'
        : `共 ${settings.maxRounds} 轮延长重试（括号内为该轮最长等待）`),
    rows.length === 0 ? null : React.createElement('div', { className: 'rb-curve-bars' },
      ...rows.map((row) => React.createElement(
        'div',
        { className: 'rb-bar', key: row.round, title: `第 ${row.round} 轮：${formatDelay(row.ms)}` },
        React.createElement('div', {
          className: 'rb-bar-fill',
          style: { height: `${Math.max(4, Math.round((row.ms / widest) * 100))}%` },
        }),
        React.createElement('span', { className: 'rb-bar-label' }, String(row.round)),
      )),
    ),
    rows.length === 0 ? null : React.createElement('div', { className: 'rb-curve-total' },
      `累计最长等待约 ${formatDelay(rows.reduce((sum, row) => sum + row.ms, 0))}`),
  );
}

/**
 * 设置面板主体。
 *
 * ⚠️ 签名必须是 `(props)`：本组件由 `React.createElement(Panel, { React })` 挂载，
 * React 只会传**一个** props 参数。若写成 `(React, props)`，则第一个形参收到的是
 * `{ React }`、第二个形参是 `undefined` ⇒ 解构 `props` 直接抛 TypeError，
 * 表现为"设置导航里有这一行、点进去右侧全白"。
 */
function Panel(props) {
  const React = props.React;
  const { onClose } = props;
  const [, forceRender] = React.useState(0);
  const rerender = () => forceRender((n) => n + 1);

  React.useEffect(() => {
    let alive = true;
    loadSettings().then((payload) => {
      if (!alive || payload === null) return;
      draft = sanitizeSettings(payload.settings);
      runtime = payload.runtime ?? runtime;
      status = '';
      rerender();
    });
    return () => { alive = false; };
  }, []);

  const patch = (changes) => {
    draft = sanitizeSettings({ ...draft, ...changes });
    rerender();
  };

  const onSave = async () => {
    status = '保存中…';
    rerender();
    const payload = await saveSettings(draft);
    if (payload === null) {
      status = runtime.writable
        ? '保存失败：无法写入宿主设置文件（详见宿主日志）'
        : '保存失败：宿主设置存储不可用，点「重新检测」再试';
      // 失败后回读一次运行时事实：设置服务可能在面板打开之后才激活，
      // 这样按钮不必等用户重开面板才恢复可用。
      const latest = await loadSettings();
      if (latest !== null && latest.runtime) runtime = latest.runtime;
    } else {
      draft = sanitizeSettings(payload.settings);
      runtime = payload.runtime ?? runtime;
      status = '已保存，立即生效';
    }
    rerender();
  };

  const onReset = async () => {
    status = '重置中…';
    rerender();
    const payload = await resetSettings();
    if (payload === null) {
      status = runtime.writable
        ? '重置失败：无法写入宿主设置文件（详见宿主日志）'
        : '重置失败：宿主设置存储不可用，点「重新检测」再试';
      const latest = await loadSettings();
      if (latest !== null && latest.runtime) runtime = latest.runtime;
    } else {
      draft = sanitizeSettings(payload.settings);
      runtime = payload.runtime ?? runtime;
      status = '已恢复默认值';
    }
    rerender();
  };

  /** 重新检测设置存储（只重读宿主事实，不动 draft 之外的设置值）。 */
  const onRecheck = async () => {
    status = '正在重新检测设置存储…';
    rerender();
    const payload = await loadSettings();
    if (payload === null) {
      status = '仍然连不上宿主设置接口（路由不可达）';
    } else {
      draft = sanitizeSettings(payload.settings);
      runtime = payload.runtime ?? runtime;
      status = runtime.writable ? '设置存储已就绪，可以保存了' : '设置存储仍不可用';
    }
    rerender();
  };

  const children = [];

  children.push(React.createElement('div', { className: 'rb-head', key: 'head' },
    React.createElement('h3', { className: 'rb-title' }, '重试退避（429 / 限流）'),
    React.createElement('p', { className: 'rb-desc' },
      '模型请求遇到可通过重试解决的失败（429 限流、服务端错误、超时、传输失败）时，'
      + '按下面的指数退避曲线延长重试轮次与等待时间，直到请求成功。'
      + '轮次用尽后交回 DSH 原生重试策略（不会直接失败）。'),
  ));

  children.push(ToggleRow(React, {
    key: 'enabled',
    label: '启用本插件',
    hint: '关闭 = 完全回到 DSH 原生重试行为',
    checked: draft.enabled,
    onChange: (v) => patch({ enabled: v }),
  }));

  children.push(NumberRow(React, {
    key: 'maxRounds',
    label: '延长轮次',
    hint: '本插件最多追加多少次重试（0 = 不介入）',
    value: draft.maxRounds,
    limit: LIMITS.maxRounds,
    onChange: (v) => patch({ maxRounds: v }),
  }));

  children.push(NumberRow(React, {
    key: 'initialDelayMs',
    label: '首次等待',
    hint: '第 1 轮退避时长；不会超过下面的「单轮上限」',
    value: draft.initialDelayMs,
    limit: {
      ...LIMITS.initialDelayMs,
      // 滑杆本身就限制在上限以内：基数高于上限在数学上等价于固定间隔，
      // 但让滑杆能拖过去再被弹回只会让人以为"设置没生效"。
      max: Math.min(LIMITS.initialDelayMs.max, draft.maxDelayMs),
      format: formatDelay,
    },
    onChange: (v) => patch({ initialDelayMs: v }),
  }));

  children.push(NumberRow(React, {
    key: 'multiplier',
    label: '退避倍率',
    hint: `每轮等待 ×${draft.multiplier}；1 = 固定间隔`,
    value: draft.multiplier,
    limit: LIMITS.multiplier,
    onChange: (v) => patch({ multiplier: v }),
  }));

  children.push(NumberRow(React, {
    key: 'maxDelayMs',
    label: '单轮上限',
    hint: '任何一轮都不会等超过这个时长；拉低时首次等待会一起跟到该值',
    value: draft.maxDelayMs,
    limit: { ...LIMITS.maxDelayMs, format: formatDelay },
    onChange: (v) => patch({ maxDelayMs: v }),
  }));

  children.push(NumberRow(React, {
    key: 'jitterRatio',
    label: '抖动比例',
    hint: `±${Math.round(draft.jitterRatio * 100)}% 随机，避免多会话同时重试撞在一起`,
    value: draft.jitterRatio,
    limit: LIMITS.jitterRatio,
    onChange: (v) => patch({ jitterRatio: v }),
  }));

  children.push(ToggleRow(React, {
    key: 'respectProviderRetryAfter',
    label: '尊重提供方的 Retry-After',
    hint: '提供方给出的等待时间（不超过单轮上限时）优先于本地曲线',
    checked: draft.respectProviderRetryAfter,
    onChange: (v) => patch({ respectProviderRetryAfter: v }),
  }));

  children.push(React.createElement('div', { className: 'rb-codes', key: 'codes' },
    React.createElement('span', { className: 'rb-row-label' }, '重试哪些失败码'),
    React.createElement('div', { className: 'rb-code-grid' },
      ...RETRYABLE_CODE_CHOICES.map((choice) => React.createElement(
        'label',
        { className: 'rb-code', key: choice.code, title: choice.code },
        React.createElement('input', {
          type: 'checkbox',
          checked: draft.retryableCodes.includes(choice.code),
          onChange: (event) => {
            const set = new Set(draft.retryableCodes);
            if (event.target.checked) set.add(choice.code); else set.delete(choice.code);
            const ordered = RETRYABLE_CODE_CHOICES
              .map((c) => c.code)
              .filter((code) => set.has(code));
            patch({ retryableCodes: ordered.length ? ordered : [...DEFAULTS.retryableCodes] });
          },
        }),
        React.createElement('span', null, choice.label),
      )),
    ),
  ));

  children.push(React.createElement('div', { className: 'rb-preview', key: 'preview' },
    CurvePreview(React, draft)));

  children.push(React.createElement('div', { className: 'rb-actions', key: 'actions' },
    React.createElement('button', {
      type: 'button', className: 'rb-btn rb-btn-primary', onClick: onSave,
      disabled: !runtime.writable,
      title: runtime.writable ? '保存并立即生效' : '宿主设置存储不可用，临时只读',
    }, '保存'),
    React.createElement('button', {
      type: 'button', className: 'rb-btn', onClick: onReset,
      disabled: !runtime.writable,
      title: runtime.writable ? '恢复为插件默认值' : '宿主设置存储不可用，临时只读',
    }, '恢复默认'),
    runtime.writable ? null : React.createElement('button', {
      type: 'button', className: 'rb-btn', onClick: onRecheck,
    }, '重新检测'),
    onClose ? React.createElement('button', {
      type: 'button', className: 'rb-btn', onClick: onClose,
    }, '关闭') : null,
    status ? React.createElement('span', { className: 'rb-status' }, status) : null,
  ));

  // 只读时给出**可见**的解释，而不是两个没有反应的灰按钮（这正是用户最先撞上的困惑）。
  if (!runtime.writable) {
    children.push(React.createElement('p', { className: 'rb-notice', key: 'readonly' },
      '宿主的设置存储暂时不可用：上面只能预览，暂时无法保存。'
      + '请稍后点「重新检测」；仍不行请重启 DSH。'));
  }

  return React.createElement('div', { className: 'rb-panel' }, ...children);
}

/** 面板样式（一次性注入；座位生命周期结束时不专门回收，重复注入由 id 去重）。 */
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('retry-backoff-styles')) return;
  const style = document.createElement('style');
  style.id = 'retry-backoff-styles';
  style.textContent = `
.rb-panel { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px; max-width: 720px; }
.rb-title { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.rb-desc, .rb-hint { margin: 0; font-size: 12px; opacity: .62; line-height: 1.55; }
.rb-row { display: flex; flex-direction: column; gap: 6px; }
.rb-toggle { flex-direction: row; align-items: flex-start; gap: 10px; }
.rb-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.rb-row-label { font-size: 13px; font-weight: 500; }
.rb-row-value { font-size: 12px; opacity: .78; font-variant-numeric: tabular-nums; }
.rb-row input[type=range] { width: 100%; }
.rb-codes { display: flex; flex-direction: column; gap: 8px; }
.rb-code-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 6px 14px; }
.rb-code { display: flex; align-items: center; gap: 7px; font-size: 12px; opacity: .9; }
.rb-preview { border: 1px solid rgba(128,128,128,.28); border-radius: 8px; padding: 12px; }
.rb-curve-title { font-size: 12px; opacity: .72; margin-bottom: 10px; }
.rb-curve-bars { display: flex; align-items: flex-end; gap: 5px; height: 88px; }
.rb-bar { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end;
  align-items: center; height: 100%; gap: 4px; }
.rb-bar-fill { width: 100%; border-radius: 3px 3px 0 0; background: currentColor; opacity: .38; min-height: 3px; }
.rb-bar-label { font-size: 10px; opacity: .55; }
.rb-curve-total { margin-top: 9px; font-size: 12px; opacity: .72; }
.rb-actions { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.rb-btn { padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
  border: 1px solid rgba(128,128,128,.36); background: transparent; color: inherit; }
.rb-btn:disabled { opacity: .45; cursor: not-allowed; }
.rb-btn-primary { background: rgba(79,140,255,.16); border-color: rgba(79,140,255,.5); }
.rb-status { font-size: 12px; opacity: .72; }
.rb-notice { margin: 0; font-size: 12px; line-height: 1.6; padding: 8px 10px; border-radius: 6px;
  border: 1px solid rgba(224,163,58,.4); background: rgba(224,163,58,.1); }
`;
  document.head.appendChild(style);
}

/**
 * 浏览器半边的服务依赖：官方座位服务。
 *
 * 用 `inject` 声明**必需**依赖，座位服务缺席时插件不加载（无设置界面的宿主里
 * 加载一个画不出东西的面板没有意义）。宿主半边仍独立负责重试本身。
 */
export const inject = ['slots'];

/**
 * 挂载浏览器半边。
 *
 * ⚠️ React 的来源是模块壳的 `require("react")`（与 wallpaper-engine 同一写法），
 * **不是** `ctx.get('react')` —— 前端是自定义模块加载器，不提供 react 服务。
 * 用 `globalThis.__RB_REACT__` 作为可注入的兜底，方便测试里塞一个假 React。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 客户端上下文。
 */
export function apply(ctx) {
  ensureStyles();

  const React = globalThis.__RB_REACT__ ?? (typeof __RB_REQUIRE__ === 'function' ? __RB_REQUIRE__('react') : undefined);
  if (!React) {
    ctx.logger?.warn?.('retry-backoff: React unavailable; settings panel not mounted');
    return;
  }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: SECTION_ID, order: 480, label: () => '重试退避' },
      () => React.createElement(Panel, { React }),
    ),
  );
}

export { Panel, formatDelay };