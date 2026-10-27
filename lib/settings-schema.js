/**
 * settings-schema.js — **设置的唯一真源**（宿主与浏览器两侧共用）。
 *
 * 为什么要有这个文件：同一张设置表若在宿主与客户端各写一遍，白名单漏一个键
 * 就会让用户改的设置被**静默丢弃**（症状是"改了没生效、重启回默认"）。
 * 这里键集只定义一次：
 *   · 客户端 `client.js` 直接 import 本文件（浏览器安全，无 Node API）。
 *   · 宿主 `index.js` 也 import 本文件做同一套校验。
 * 两侧共用 ⇒ "存进去的"与"读出来的"不会分叉。
 *
 * ⚠️ 本文件必须**浏览器安全**：不得出现 Node API / 顶层副作用。
 */

/** 设置形状版本：存储形状或默认语义变动时 +1，由 migrateSettings 消费。 */
export const SETTINGS_VERSION = 1;

// ── 可重试失败码 ────────────────────────────────────────────────────────────
/**
 * DSH 的 `LlmFailure.code` 取值里，属于"重试可能解决"的那一批。
 *
 * 429 在 DSH 里落到 `RATE_LIMIT`（也有网关把它报成 `SERVER` / `TRANSPORT`），
 * 所以默认集合覆盖限流、服务端、超时与传输四类；认证 / 配额 / 无效请求这类
 * **重试解决不了**的码刻意不在默认集合里（`AUTH` / `QUOTA` / `INVALID_REQUEST` /
 * `PROTOCOL` / `CONTEXT`），否则会拿着用户的额度去撞一堵不会开的墙。
 */
export const DEFAULT_RETRYABLE_CODES = [
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
];

/** 失败码的白名单（面板里可勾选的全部取值）。 */
export const RETRYABLE_CODE_CHOICES = [
  { code: 'RATE_LIMIT', label: '限流 / 429' },
  { code: 'SERVER', label: '服务端错误 / 5xx' },
  { code: 'TIMEOUT', label: '请求超时' },
  { code: 'TRANSPORT', label: '网络传输失败' },
  { code: 'EMPTY_RESPONSE', label: '空响应' },
  { code: 'AUTH', label: '认证失败（重试通常无效）' },
  { code: 'QUOTA', label: '额度耗尽（重试通常无效）' },
  { code: 'INVALID_REQUEST', label: '请求非法（重试通常无效）' },
  { code: 'PROTOCOL', label: '协议错误（重试通常无效）' },
  { code: 'CONTEXT', label: '上下文超限（重试通常无效）' },
];

// ── 量程（面板与校验共用同一组数字，避免两处各写一遍）────────────────────────
export const LIMITS = {
  /** 延长轮次：0 = 本插件不介入（完全交回 DSH 原生策略）。 */
  maxRounds: { min: 0, max: 200, step: 1, default: 8 },
  /** 首次退避基数（毫秒）。 */
  initialDelayMs: { min: 100, max: 600_000, step: 100, default: 2_000 },
  /** 退避倍率。1 = 固定间隔；越大增长越快。 */
  multiplier: { min: 1, max: 10, step: 0.1, default: 2 },
  /** 单次退避上限（毫秒）——避免倍率把等待推成几小时。 */
  maxDelayMs: { min: 100, max: 3_600_000, step: 100, default: 60_000 },
  /** 抖动比例：0 = 不加抖动；0.3 = ±30% 随机。防多会话同时重试撞在一起。 */
  jitterRatio: { min: 0, max: 1, step: 0.05, default: 0.2 },
  /**
   * 尊重提供方 `Retry-After`：开启后，若响应头给出的等待时间更长，
   * 就用它替换本地计算的退避（上限仍受 maxDelayMs 约束）。
   */
  providerDelayCeilingMs: { min: 0, max: 3_600_000, step: 1000, default: 300_000 },
};

/** 设置对象的默认值（唯一真源）。 */
export const DEFAULTS = {
  enabled: true,
  maxRounds: LIMITS.maxRounds.default,
  initialDelayMs: LIMITS.initialDelayMs.default,
  multiplier: LIMITS.multiplier.default,
  maxDelayMs: LIMITS.maxDelayMs.default,
  jitterRatio: LIMITS.jitterRatio.default,
  retryableCodes: [...DEFAULT_RETRYABLE_CODES],
  respectProviderRetryAfter: true,
  /** 面板状态展示用，不参与重试决策。 */
  settingsVersion: SETTINGS_VERSION,
};

// ── 校验工具 ────────────────────────────────────────────────────────────────

/** 在 [lo, hi] 内的数字；否则回落 fallback。 */
export function clampNum(value, lo, hi, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo || n > hi) return fallback;
  return n;
}

/** 非空字符串的白名单成员；否则回落 fallback。 */
function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * 把任意输入（磁盘上的旧值、面板传来的脏值、undefined）整理成一份**合法**设置。
 *
 * 语义与 wallpaper-engine 的 `clampNum` 一致：**越界即回默认值**，不悄悄改成边界值
 * —— 把用户写的 999999 静默改成 3600000 是"无声改值"，回默认才是可解释的行为。
 * 唯一的跨字段归一化是「基数 ≤ 上限」：上限较低时只把基数跟到上限（等待行为不变），
 * 不会反过来改掉用户设置的上限。
 *
 * @param {unknown} input - 任意输入。
 * @returns {object} 一份全新的、合法的设置对象。
 */
export function sanitizeSettings(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  const out = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    maxRounds: Math.round(clampNum(raw.maxRounds, LIMITS.maxRounds.min, LIMITS.maxRounds.max, DEFAULTS.maxRounds)),
    initialDelayMs: clampNum(raw.initialDelayMs, LIMITS.initialDelayMs.min, LIMITS.initialDelayMs.max, DEFAULTS.initialDelayMs),
    multiplier: clampNum(raw.multiplier, LIMITS.multiplier.min, LIMITS.multiplier.max, DEFAULTS.multiplier),
    maxDelayMs: clampNum(raw.maxDelayMs, LIMITS.maxDelayMs.min, LIMITS.maxDelayMs.max, DEFAULTS.maxDelayMs),
    jitterRatio: clampNum(raw.jitterRatio, LIMITS.jitterRatio.min, LIMITS.jitterRatio.max, DEFAULTS.jitterRatio),
    respectProviderRetryAfter:
      typeof raw.respectProviderRetryAfter === 'boolean'
        ? raw.respectProviderRetryAfter
        : DEFAULTS.respectProviderRetryAfter,
    settingsVersion: SETTINGS_VERSION,
  };

  // 失败码：只保留白名单内的已知码，去重，顺序按白名单固定。
  const known = RETRYABLE_CODE_CHOICES.map((c) => c.code);
  const incoming = Array.isArray(raw.retryableCodes) ? raw.retryableCodes : DEFAULTS.retryableCodes;
  const seen = new Set();
  out.retryableCodes = known.filter((code) => {
    if (!incoming.includes(code) || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
  // 一个都不剩 = 插件永不重试，与 enabled:false 等价但更难解释 ⇒ 回默认集合。
  if (out.retryableCodes.length === 0) out.retryableCodes = [...DEFAULT_RETRYABLE_CODES];

  // 跨字段约束：上限低于基数时，把基数跟到上限。
  // 这**不改变任何实际等待**——曲线本来就以 maxDelayMs 封顶，
  // 而"基数高于上限"与"基数等于上限"的每一轮延迟完全相同。
  // 曾经的实现把两个值一起重置为默认（60s），于是用户把「单轮上限」拉到最左
  // 会被弹回"1 分钟"；这里只做行为等价的归一化，绝不丢掉用户设的上限。
  if (out.initialDelayMs > out.maxDelayMs) out.initialDelayMs = out.maxDelayMs;

  return out;
}

/**
 * 计算第 `round` 轮（从 1 开始）的退避毫秒数。
 *
 * 公式：`min(initialDelayMs * multiplier^(round-1), maxDelayMs)`，再乘对称抖动
 * `1 - jitter + 2*jitter*random()`，最后仍以 maxDelayMs 封顶（抖动不得越过上限）。
 *
 * 这是**纯函数**（random 可注入）⇒ 宿主与浏览器两侧的预览曲线、以及测试，
 * 都用同一条公式，不会各算各的。
 *
 * @param {object} settings - 已消毒的设置。
 * @param {number} round - 轮次，从 1 开始。
 * @param {() => number} [random] - 随机源，默认 Math.random。
 * @returns {number} 毫秒（>= 0 的整数）。
 */
export function backoffDelay(settings, round, random = Math.random) {
  const exponent = Math.max(0, Math.min(round - 1, 64));
  const exponential = Math.min(settings.initialDelayMs * settings.multiplier ** exponent, settings.maxDelayMs);
  const jitter = 1 - settings.jitterRatio + 2 * settings.jitterRatio * random();
  return Math.max(0, Math.round(Math.min(exponential * jitter, settings.maxDelayMs)));
}

/**
 * 预览整条退避曲线（面板与文档共用）。
 * @param {object} settings - 已消毒的设置。
 * @param {number} [rounds] - 预览轮数。
 * @returns {number[]} 每轮的毫秒数（不含抖动，即"最坏/计划值"）。
 */
export function backoffCurve(settings, rounds = 8) {
  const n = Math.max(0, Math.min(Math.round(rounds), LIMITS.maxRounds.max));
  const out = [];
  for (let round = 1; round <= n; round += 1) {
    out.push(backoffDelay(settings, round, () => 0.5));
  }
  return out;
}