/**
 * test/all.mjs — 一条命令跑完全部验证。
 *
 * 依次执行：
 *   ① 单元测试（退避公式 / 消毒 / 每个重试分支 / HTTP 路由 / 前端产物）
 *   ② 端到端（真实 loop 语义下的"429 反复失败直至成功"）
 *   ③ dsh.client 契约（前端能被 DSH 前端加载器认下）
 *   ④ profile 组合（本行真的进了 DSH 的插件树，且官方 llm-retry 仍在）
 *
 * 用法：node test/all.mjs [--profile desktop|web]
 * 退出码非 0 = 有验证未通过。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const profileArgIndex = process.argv.indexOf('--profile');
const profiles = profileArgIndex >= 0
  ? [process.argv[profileArgIndex + 1]]
  : ['desktop', 'web'];

const steps = [
  ['单元测试', join(here, 'run.mjs'), []],
  ['端到端重试循环', join(here, 'verify-e2e.mjs'), []],
  ['版本闸门判定', join(here, 'verify-semver.mjs'), []],
];

// profile 相关验证：装到 profile 里的那份（若已安装）优先，否则验证本仓库这份。
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const repoRoot = dirname(here);
for (const profile of profiles) {
  const installed = join(home, 'profiles', profile, 'node_modules', 'dsh-plugin-retry-backoff');
  const target = existsSync(installed) ? installed : repoRoot;
  const label = existsSync(installed) ? `${profile}（已安装）` : `${profile}（本仓库，未安装）`;
  steps.push([`前端契约 · ${label}`, join(here, 'verify-client-contract.mjs'), [target]]);
  if (existsSync(installed)) {
    steps.push([`profile 组合 · ${label}`, join(here, 'verify-profile.mjs'), [profile]]);
  }
}

let failedSteps = 0;
for (const [label, script, args] of steps) {
  console.log(`\n${'═'.repeat(60)}\n▶ ${label}\n${'═'.repeat(60)}`);
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    failedSteps += 1;
    console.log(`\n✗ ${label} 未通过（退出码 ${result.status}）`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
if (failedSteps === 0) {
  console.log(`✓ 全部 ${steps.length} 组验证通过`);
} else {
  console.log(`✗ ${failedSteps} / ${steps.length} 组验证失败`);
}
console.log(`${'═'.repeat(60)}\n`);

process.exit(failedSteps === 0 ? 0 : 1);