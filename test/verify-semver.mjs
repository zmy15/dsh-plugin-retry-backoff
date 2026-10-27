/**
 * test/verify-semver.mjs — 版本闸门判定的回归测试。
 *
 * 这条测试的存在理由：本仓真实踩过一次"插件装上了、文件全在、静态检查全绿，
 * 但 DSH 启动时整行跳过它"的故障。根因是 peerDependencies 用了
 * `^0.1.5-rc.1`，而 caret 在 semver 下**不含 0.2.x**，于是运行时
 * `0.2.1-rc.2` 被判为不兼容 ⇒ 插件被静默丢弃。
 *
 * 所以这里把 semver 语义钉死，尤其是 prerelase 序（`0.1.5-rc.2 < 0.2.0`）。
 */

import { compareVersions, parseVersion, satisfiesRange } from './semver.mjs';

let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

console.log('\n版本闸门（semver 语义）\n');

// ── prerelease 序：这是最初 bug 的根源 ─────────────────────────────────────
check('0.1.5-rc.2 < 0.2.0（prerelease 小于同主次的正式版）',
  compareVersions(parseVersion('0.1.5-rc.2'), parseVersion('0.2.0')) < 0);
check('0.2.0-rc.1 < 0.2.0',
  compareVersions(parseVersion('0.2.0-rc.1'), parseVersion('0.2.0')) < 0);
check('0.1.5-rc.1 < 0.1.5-rc.2（rc 序号递增）',
  compareVersions(parseVersion('0.1.5-rc.1'), parseVersion('0.1.5-rc.2')) < 0);
check('1.0.0-rc.1 < 1.0.0',
  compareVersions(parseVersion('1.0.0-rc.1'), parseVersion('1.0.0')) < 0);

// ── caret 的上界：当初的 bug 就在这里 ─────────────────────────────────────
check('^0.1.5-rc.1 不含 0.2.1-rc.2（当初的故障）',
  satisfiesRange('0.2.1-rc.2', '^0.1.5-rc.1') === false);
check('^0.1.5-rc.1 含 0.1.5-rc.2（同 tuple 的更高 rc）',
  satisfiesRange('0.1.5-rc.2', '^0.1.5-rc.1') === true);
check('^0.1.5-rc.1 不含 0.1.4（低于下界）',
  satisfiesRange('0.1.4', '^0.1.5-rc.1') === false);
check('^1.2.3 含 1.9.0（同主版本）', satisfiesRange('1.9.0', '^1.2.3') === true);
check('^1.2.3 不含 2.0.0（跨主版本）', satisfiesRange('2.0.0', '^1.2.3') === false);

// ── 开放下界：本插件采用的写法 ───────────────────────────────────────────
check('>=0.1.5-rc.1 含 0.1.5-rc.2', satisfiesRange('0.1.5-rc.2', '>=0.1.5-rc.1') === true);
check('>=0.1.5-rc.1 含 0.2.1-rc.2（修复后应通过）',
  satisfiesRange('0.2.1-rc.2', '>=0.1.5-rc.1') === true);
check('>=0.1.5-rc.1 含 1.0.0', satisfiesRange('1.0.0', '>=0.1.5-rc.1') === true);
check('>=0.1.5-rc.1 不含 0.1.4', satisfiesRange('0.1.4', '>=0.1.5-rc.1') === false);

// ── 精确值与解析健壮性 ───────────────────────────────────────────────────
check('精确值 4.0.2 匹配 4.0.2', satisfiesRange('4.0.2', '4.0.2') === true);
check('精确值 4.0.2 不匹配 4.0.3', satisfiesRange('4.0.3', '4.0.2') === false);
check('无法解析的运行时版本不误报', satisfiesRange('not-a-version', '>=0.1.5') === true);

console.log(`\n${failed === 0 ? '版本闸门判定全部正确' : `${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);