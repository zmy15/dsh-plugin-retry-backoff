/**
 * test/verify-profile.mjs — 用 DSH **自己的**引导模块验证插件真的进了 profile 树。
 *
 * 这一步不是"读文本看有没有那行"（那种断言在 patch 合并语义变了之后会静默失效），
 * 而是调用 `dsh-app-boot` 真正导出/加载 profile，然后断言合并后的插件树里
 * 存在我们的行。因此它验证的是**DSH 加载器眼里的结果**。
 *
 * 用法：node test/verify-profile.mjs [profileName]
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const profileName = process.argv[2] ?? 'desktop';
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileDir = join(home, 'profiles', profileName);
const profileModules = join(home, 'profiles', 'node_modules');

const PLUGIN = 'dsh-plugin-retry-backoff';

let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

console.log(`\n验证 profile "${profileName}"：${profileDir}\n`);

// ── 1. profile 清单已登记本 bundle ──────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const bundles = manifest.dsh?.profile?.bundles ?? [];
check('profile 清单在 bundles 里登记了本插件', bundles.includes(PLUGIN), `bundles = ${JSON.stringify(bundles)}`);

// ── 2. 包目录可解析且声明了 dsh.bundle.patch ────────────────────────────────
const pluginDir = join(profileDir, 'node_modules', PLUGIN);
check('插件包目录存在（可从 profile 锚点解析）', existsSync(pluginDir), pluginDir);

const pluginManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
check('插件声明了 dsh.bundle.patch（bundle 层必需）', typeof pluginManifest.dsh?.bundle?.patch === 'string');
check('插件声明了 dsh.client（前端半边）', pluginManifest.dsh?.client !== undefined,
  '没有 dsh.client 就不会注入浏览器半边');

// ── 3. 用 DSH 自己的 boot 模块加载并**组合** profile ──────────────────────
//
// 这是关键一步：`loadProfileDirectory` 解析每个 bundle 的 patch 层，
// `composeEntries` 把它们合并成**最终要挂载的条目列表**（与 DSH 启动时
// 走的是同一个 `applyEntryPatches`）。断言因此验证的是加载器眼里的结果，
// 而不是"文件里出现过某一行"这种会随语义漂移而静默失效的文本匹配。
const require = createRequire(join(profileModules, 'noop.js'));
let boot;
try {
  boot = require('@deepseek-ai/dsh-app-boot');
} catch (error) {
  console.log(`  FAIL 无法 require dsh-app-boot: ${error.message}`);
  process.exit(1);
}

// installAnchor 指向安装内的 dsh app 包（第一解析锚点）。
// 运行中的 dsh 在 asar 里，这里用 profile 侧解析出的同一包即可定位包边界。
const installAnchor = require.resolve('@deepseek-ai/dsh-app-boot/package.json');

let composed = null;
try {
  const loaded = boot.loadProfileDirectory('dsh', profileDir, installAnchor, {});
  check('loadProfileDirectory 成功解析 profile', true);
  check('解析出的 bundle 层包含本插件', loaded.layers.some((l) => l.packageName === PLUGIN),
    `layers = ${loaded.layers.map((l) => l.packageName).join(', ')}`);

  composed = boot.composeEntries([...loaded.layers.map((l) => l.patches), ...loaded.patches]);
} catch (error) {
  console.log(`  FAIL profile 组合抛错：${error.message}`);
  failed += 1;
}

if (composed !== null) {
  const names = composed.map((entry) => entry?.name ?? entry?.id ?? String(entry));
  check('组合后的条目列表包含本插件', names.includes(PLUGIN),
    `entries = ${JSON.stringify(names)}`);

  const row = composed.find((entry) => entry?.name === PLUGIN);
  check('本插件的行未被禁用', row !== undefined && row.disabled !== true);
  check('本插件的行 id 稳定（retry-backoff）', row?.id === 'retry-backoff', `id = ${row?.id}`);
  check('本插件的行未携带行内 config', row?.config === undefined,
    '行内 config 会被插件拒绝（设置走用户设置层）');
  check('官方 llm-retry 仍在树里（本插件是追加，不是替换）',
    names.includes('@deepseek-ai/dsh-llm-retry'),
    '若官方行消失了说明 patch 语义被误改');
}

// ── 4. 直接核对 patch 语义：本包 patch 里确实有一条 insert 我们的行 ────────
const patchPath = join(pluginDir, pluginManifest.dsh.bundle.patch);
const patchText = readFileSync(patchPath, 'utf8');
check('bundle patch 含 insert 段', /-\s*insert:/.test(patchText));
check('bundle patch 插入的行 id 是 retry-backoff', /id:\s*retry-backoff/.test(patchText));
check('bundle patch 插入的行 name 指向本包', new RegExp(`name:\\s*['"]?${PLUGIN}`).test(patchText));

// ── 5. 关键机制：行内 config 必须缺席（设置走用户层）──────────────────────
check('bundle patch 未误设行内 config', !/^\s*config:/m.test(patchText),
  '设置应走用户设置层，行内 config 会被插件拒绝');

// ── 6. 前端产物存在且是可加载形态 ──────────────────────────────────────────
const clientPath = join(pluginDir, 'lib', 'client.bundle.js');
check('前端产物 lib/client.bundle.js 存在', existsSync(clientPath));
if (existsSync(clientPath)) {
  const client = readFileSync(clientPath, 'utf8');
  check('前端产物是 __ModuleLoader__ 形态', client.includes('window.__ModuleLoader__.load('));
  check('前端产物导出 apply', /exports\.apply\s*=/.test(client));
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);