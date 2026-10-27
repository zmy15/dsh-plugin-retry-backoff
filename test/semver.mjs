/**
 * test/semver.mjs — 供契约检查使用的极简 semver 比对。
 *
 * 为什么自己写：本仓只依赖"判断 range 是否覆盖运行时版本"这一件事，引入 semver
 * 依赖不划算。但**必须写对 prerelease 序** —— 这正是最初踩的坑：
 * `^0.1.5-rc.1` 在 semver 语义下**不含 0.2.x**，而"带 prerelease 的版本天然小于
 * 同主次版本的正式版"这条规则决定了 `0.1.5-rc.2 < 0.2.0`。
 *
 * 规则（够本仓用）：
 *   · 主次修订逐段比大小；
 *   · 同主次修订时：**有 prerelease 的小于没有的**（`0.2.0-rc.1 < 0.2.0`）；
 *   · 都有 prerelease 时按标识符逐段比（数字段数值比、字母段字典序、数字段 < 字母段）。
 */

/** 解析 `x.y.z` 或 `x.y.z-pre`（解析失败返回 null）。 */
export function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim());
  if (m === null) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? null : m[4].split('.'),
  };
}

/** 比较两个 prerelease 标识符数组（遵循 semver §11）。 */
function comparePre(a, b) {
  if (a === null && b === null) return 0;
  // 没有 prerelease 的版本**更大**。
  if (a === null) return 1;
  if (b === null) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // 段数少的更小
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字段 < 字母段
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 比较两个版本（-1 / 0 / 1）。 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

/**
 * 判断 `range` 是否覆盖 `version`（支持 `>=x`、`^x.y.z`、精确值）。
 *
 * `^` 的语义按 semver：主版本 > 0 时锁主版本；`0.y.z` 时锁次版本；
 * `0.0.z` 时锁修订版本。**并遵守 prerelease 规则**：只有当 range 自身带
 * prerelease 且与其主次修订相同时，才允许匹配 prerelease 版本
 *（这就是 `^0.1.5-rc.1` 不含 `0.2.x`、但含 `0.1.5-rc.2` 的原因）。
 *
 * @param {string} version - 运行时版本。
 * @param {string} range - 依赖范围。
 * @returns {boolean} 是否覆盖。
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (v === null) return true; // 解析不了就不拦（避免误报）

  const r = String(range).trim();

  if (r.startsWith('>=')) {
    const lo = parseVersion(r.slice(2));
    if (lo === null) return true;
    return compareVersions(v, lo) >= 0;
  }

  if (r.startsWith('^')) {
    const lo = parseVersion(r.slice(1));
    if (lo === null) return true;
    if (compareVersions(v, lo) < 0) return false;
    // 上界：主版本 > 0 ⇒ 同主版本；0.y ⇒ 同次版本；0.0.z ⇒ 同修订。
    const upperOk = lo.nums[0] > 0
      ? v.nums[0] === lo.nums[0]
      : lo.nums[1] > 0
        ? v.nums[0] === 0 && v.nums[1] === lo.nums[1]
        : v.nums[0] === 0 && v.nums[1] === 0 && v.nums[2] === lo.nums[2];
    if (!upperOk) return false;
    // prerelease 例外：range 不带 prerelease 时，不匹配 prerelease 版本。
    if (v.pre !== null && lo.pre === null) return false;
    return true;
  }

  const exact = parseVersion(r);
  return exact === null ? true : compareVersions(v, exact) === 0;
}