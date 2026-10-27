/**
 * test/verify-client-contract.mjs — 验证前端半边满足 DSH 的 `dsh.client` 契约。
 *
 * DSH 前端加载第三方插件走 `@deepseek-ai/dsh-client-modules` 的
 * `WebPluginTable.resolveMeta()`，它对这个包提出三条硬要求（见其源码）：
 *   ① `dsh.client` 存在且 `platform === "web"`（否则整个包被跳过，静默无面板）；
 *   ② `exports` 里必须有 `"./client"`（否则抛 "declares dsh.client but exports
 *      no './client' bundle"）；
 *   ③ 该路径指向的产物必须是真实存在的文件。
 *
 * 这里**复刻同一条解析规则**并断言，把"静默无面板"这类失败在安装期就变成红字。
 * 用法：node test/verify-client-contract.mjs <插件包目录>
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { satisfiesRange } from './semver.mjs';

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: node test/verify-client-contract.mjs <packageDir>');
  process.exit(2);
}

let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

console.log(`\n校验 dsh.client 契约：${pkgDir}\n`);

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

// ① 声明存在且平台为 web（DSH 只认 web）。
const decl = pkg.dsh?.client;
check('package.json 声明了 dsh.client', decl !== undefined);
check('dsh.client.platform === "web"', decl?.platform === 'web',
  `实际：${JSON.stringify(decl?.platform)}`);
if (decl?.inject !== undefined) {
  check('dsh.client.inject 是字符串数组',
    Array.isArray(decl.inject) && decl.inject.every((x) => typeof x === 'string'));
}
if (decl?.immediately !== undefined) {
  check('dsh.client.immediately 是布尔', typeof decl.immediately === 'boolean');
}
if (decl?.external !== undefined) {
  check('dsh.client.external 是字符串数组',
    Array.isArray(decl.external) && decl.external.every((x) => typeof x === 'string'));
}

// ② exports["./client"] 必须存在（DSH 的 clientExportOf 语义）。
const clientExport = pkg.exports?.['./client'];
check('exports 含 "./client" 子路径', clientExport !== undefined,
  `exports = ${JSON.stringify(Object.keys(pkg.exports ?? {}))}`);

// 解析出真实文件路径（支持 "./client": "./lib/x.js" 与条件导出对象两种写法）。
let clientRel;
if (typeof clientExport === 'string') clientRel = clientExport;
else if (clientExport && typeof clientExport === 'object') {
  clientRel = clientExport.default ?? clientExport.import ?? clientExport.require;
}
check('"./client" 能解析出一个路径', typeof clientRel === 'string', `得到：${JSON.stringify(clientExport)}`);

if (typeof clientRel === 'string') {
  const clientPath = join(pkgDir, clientRel);
  // ③ 产物必须真实存在且非空（DSH 激活时同步读取它，缺失即整树失败）。
  check('前端产物文件真实存在', existsSync(clientPath), clientPath);
  if (existsSync(clientPath)) {
    const size = statSync(clientPath).size;
    check('前端产物非空', size > 0, `${size} bytes`);

    const source = readFileSync(clientPath, 'utf8');
    // 产物必须是自定义模块壳形态：DSH 用 classic script + __ModuleLoader__ 加载它。
    check('产物调用 window.__ModuleLoader__.load',
      /window\.__ModuleLoader__\.load\(/.test(source));
    check('产物导出 apply', /exports\.apply\s*=/.test(source));
    check('产物导出 inject', /exports\.inject\s*=/.test(source));
    // 模块 id 必须等于包名（DSH 以包名作 graph row id）。
    check('模块 id 等于包名', source.includes(JSON.stringify(pkg.name)),
      `期望 ${pkg.name}`);
    // 前端半边不应引用 Node 内置（浏览器里会直接炸）。
    check('产物未引用 node: 内置模块', !/require\(["']node:/.test(source));
    // 产物不应依赖相对 import（自定义壳里没有 ESM 解析）。
    check('产物无残留 ESM import 语句', !/^\s*import\s/m.test(source));
  }
}

// ④ files 白名单必须包含产物，否则发布后前端 404。
const files = pkg.files ?? [];
if (files.length > 0 && typeof clientRel === 'string') {
  const rel = clientRel.replace(/^\.\//, '');
  check('files 白名单包含前端产物', files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, '') + '/')),
    `files = ${JSON.stringify(files)}`);
}

// ⑤ 宿主半边入口也必须存在且可解析（否则整行挂不上）。
const mainEntry = pkg.main ?? pkg.exports?.['.']?.default;
check('声明了宿主入口 main/exports["."]', typeof mainEntry === 'string');
if (typeof mainEntry === 'string') {
  check('宿主入口文件存在', existsSync(join(pkgDir, mainEntry)), mainEntry);
}

// ⑥ bundle patch 必须存在（否则 profile 里不会出现本行）。
const patchRel = pkg.dsh?.bundle?.patch;
check('声明了 dsh.bundle.patch', typeof patchRel === 'string');
if (typeof patchRel === 'string') {
  check('bundle patch 文件存在', existsSync(join(pkgDir, patchRel)), patchRel);
}

// ⑦ 版本闸门：DSH 启动时会拒绝 peerDependencies 与运行时 dsh 不兼容的插件，
//    表现是**静默跳过整行**（日志一行 skipping profile bundle），前端什么都看不到。
//    本仓踩过一次：`^0.1.5-rc.1` 的 caret 范围**不含 0.2.x**，插件被整行丢弃，
//    而所有"文件是否存在"的静态检查当时全是绿的 ⇒ 需要这一条才能真正兜住。
const peers = pkg.peerDependencies ?? {};
// 运行时依赖可能在两处：profile 的 node_modules（已安装），或本仓的 node_modules（开发时）。
// 两个都试 —— 否则"已安装"这一最常见的情形会静默跳过这段最重要的检查。
const runtimeRoots = [
  // 已安装：<home>/profiles/<name>/node_modules/dsh-plugin-… ⇒ 上三级是 <home>/profiles/…
  join(pkgDir, '..', '..', '..', 'node_modules', '@deepseek-ai'),
  // 开发：本仓 node_modules（用 junction 链到 profile 的包）
  join(pkgDir, 'node_modules', '@deepseek-ai'),
  // 兜底：<home>/profiles/node_modules（共享安装锚点）
  join(pkgDir, '..', '..', '..', 'profiles', 'node_modules', '@deepseek-ai'),
].filter((p) => existsSync(p));

let peersChecked = 0;
for (const [depName, range] of Object.entries(peers)) {
  if (depName === 'react') continue; // react 由前端模块壳提供，不经 dsh 运行时校验
  const shortName = depName.replace('@deepseek-ai/', '');
  let depPkg;
  for (const root of runtimeRoots) {
    const candidate = join(root, shortName, 'package.json');
    if (existsSync(candidate)) { depPkg = candidate; break; }
  }
  if (depPkg === undefined) continue;
  const actual = JSON.parse(readFileSync(depPkg, 'utf8')).version;
  peersChecked += 1;
  check(
    `peer ${depName}@${range} 覆盖运行时 ${actual}`,
    satisfiesRange(actual, range),
    `不覆盖 ⇒ DSH 会整行跳过本插件（前端完全看不到）。range=${range}，运行时=${actual}`,
  );
}
if (peersChecked === 0) {
  console.log('  ..   未找到运行时依赖（未安装到 profile？）—— 跳过版本闸门核对');
}

console.log(`\n${failed === 0 ? '契约全部满足' : `${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);
