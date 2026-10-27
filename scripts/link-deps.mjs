/**
 * link-deps.mjs — 把测试所需的 peer 依赖链到本仓，免去联网安装。
 *
 * 为什么需要它：本插件的运行时依赖（`@deepseek-ai/schemastery`、`zod`）由 DSH
 * 运行时提供，**不该**打进插件包。但本地跑 `test/` 时需要能 `import` 到它们，
 * 否则测试一启动就 ERR_MODULE_NOT_FOUND。
 *
 * 做法：在 DSH 已安装的 profile 里找到这些包，然后用 junction（Windows）/
 * symlink（其他平台）链进 `./node_modules`。只创建链接，不复制字节，也不联网。
 *
 * 用法：
 *   node scripts/link-deps.mjs                 # 自动探测 profile
 *   node scripts/link-deps.mjs <profileDir>    # 指定 profile 目录
 */

import { existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** 测试真正需要的运行时依赖（与 lib/ 的 import 对应）。 */
const NEEDED = [
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  'zod',
];

/**
 * 找到含这些依赖的 node_modules 目录。
 * @param {string|undefined} explicit - 用户指定的 profile 目录。
 * @returns {string|null} node_modules 路径。
 */
function findRuntime(explicit) {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  const candidates = [];
  if (explicit !== undefined) {
    candidates.push(join(resolve(explicit), 'node_modules'));
  }
  candidates.push(
    join(home, 'profiles', 'desktop', 'node_modules'),
    join(home, 'profiles', 'node_modules'),
    join(home, 'profiles', 'web', 'node_modules'),
  );
  for (const dir of candidates) {
    if (NEEDED.every((name) => existsSync(join(dir, name, 'package.json')))) return dir;
  }
  // 部分依赖分散在不同 node_modules 时，退一步：只要 schemastery 在就认为可链。
  for (const dir of candidates) {
    if (existsSync(join(dir, '@deepseek-ai', 'schemastery', 'package.json'))) return dir;
  }
  return null;
}

const runtime = findRuntime(process.argv[2]);
if (runtime === null) {
  console.error(
    'link-deps: 找不到已安装的 DSH 依赖。\n'
    + '  请先安装 DSH 桌面端，或用 `node scripts/link-deps.mjs <profileDir>` 指定 profile。',
  );
  process.exit(1);
}

console.log(`link-deps: 运行时依赖来自 ${runtime}\n`);

let linked = 0;
let missing = 0;
for (const name of NEEDED) {
  const target = join(runtime, name);
  const linkPath = join(root, 'node_modules', name);
  if (!existsSync(join(target, 'package.json'))) {
    console.log(`  skip  ${name}（该 profile 未安装）`);
    missing += 1;
    continue;
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  // 先清掉旧链接（重复运行要幂等）。
  if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`  link  ${name} -> ${target}`);
  linked += 1;
}

console.log(`\n完成：链接 ${linked} 个，缺失 ${missing} 个`);
if (missing > 0) {
  console.log('缺失的依赖会让对应测试失败；补齐后可重新运行本脚本。');
}