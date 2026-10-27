/**
 * test/run.mjs — 本插件的自动化验证。
 *
 * 用**真实的插件模块**（不是副本）配一个最小 cordis 桩，验证四件事：
 *   ① 退避曲线是用户设置驱动的指数退避（含上限、抖动、倍率边界）；
 *   ② 429（RATE_LIMIT）会被接住并返回 `{ kind: 'retry' }`，且**先持久后等待**；
 *   ③ 轮次预算耗尽后调 `next()` 把决定权交回下游（不是直接失败）；
 *   ④ 取消、禁用、非集合内失败码、提供方 Retry-After 的分支都符合契约。
 *
 * 全部断言打印 `ok`/`FAIL`，任一 FAIL 决定退出码。
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULTS,
  backoffCurve,
  backoffDelay,
  sanitizeSettings,
} from '../lib/settings-schema.js';
import { apply as applyHost } from '../lib/index.js';
import { registerSettingsRoutes, BASE } from '../lib/routes.js';
import { createSettingsStore, resolveSettingsPath } from '../lib/settings-store.js';

let passed = 0;
let failed = 0;

/**
 * 跑一条测试。
 * @param {string} label - 用例名。
 * @param {() => void|Promise<void>} fn - 用例体。
 */
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

/** 快速等待（避免测试真等几秒）。 */
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 造一个最小 cordis ctx 桩，只提供插件真正用到的那几个面。
 *
 * 关键点：`ctx.on('agent/request-error', …)` 的登记顺序就是 waterfall 顺序，
 * 桩据此把多个监听器串成一条链 —— 于是"预算耗尽后交回下游"能被真正测到。
 */
function makeCtx({ settings: initialSettings, home } = {}) {
  const ownsHome = home === undefined;
  const testHome = home ?? mkdtempSync(join(tmpdir(), 'dsh-rb-test-'));
  const settingsPath = join(testHome, 'retry-backoff', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  // 首次造 harness 时写入初始设置；复用同一个 home（持久化测试）时不覆盖。
  if (initialSettings !== undefined || !existsSync(settingsPath)) {
    writeFileSync(settingsPath, `${JSON.stringify(sanitizeSettings(initialSettings ?? DEFAULTS), null, 2)}\n`, 'utf8');
  }
  // `apply` 在挂载时解析路径；用环境变量把它钉到本用例的临时文件，
  // 绝不碰真实的 ~/.dsh/retry-backoff/settings.json。
  process.env.DSH_RETRY_BACKOFF_SETTINGS = settingsPath;

  const log = [];
  const listeners = new Map();
  const effects = [];
  const projections = new Map();
  /** 会话事件日志（桩里的"会话"）。 */
  const events = [];

  const session = {
    id: 'test-session',
    append(type, data) {
      events.push({ type, data });
    },
  };

  /** 收集 apply 期间注册的 HTTP 路由（键：kind:path）。 */
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route.handler);
      return () => routes.delete(`${route.kind}:${route.path}`);
    },
  };

  const ctx = {
    logger: {
      info: (...args) => log.push(['info', args]),
      warn: (...args) => log.push(['warn', args]),
      error: (...args) => log.push(['error', args]),
    },
    webServer,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const list = listeners.get(event);
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(fn) {
      effects.push(fn);
      return () => {};
    },
    sessionProjections: {
      register(definition) {
        projections.set(definition.key, definition);
        return () => projections.delete(definition.key);
      },
      /** 从会话事件重放一份状态（模拟投影语义）。 */
      stateOf(_session, key) {
        const definition = projections.get(key);
        if (!definition) return undefined;
        let state = definition.init();
        for (const event of events) state = definition.apply(state, event);
        return state;
      },
    },
  };

  /**
   * 跑一次 `agent/request-error` waterfall。
   * @param {object} payload - waterfall 载荷。
   * @returns {Promise<unknown>} waterfall 最终返回值。
   */
  async function runWaterfall(payload) {
    const chain = listeners.get('agent/request-error') ?? [];
    let index = -1;
    const next = async () => {
      index += 1;
      if (index >= chain.length) return undefined;
      return chain[index](payload, next);
    };
    return next();
  }

  /** 跑一次卸载（触发 ctx.effect 收集到的清理器）。 */
  async function dispose() {
    for (const effect of effects) {
      const cleaner = effect();
      if (typeof cleaner === 'function') await cleaner();
    }
    if (ownsHome) rmSync(testHome, { recursive: true, force: true });
  }

  return {
    ctx, session, events, log, routes, webServer,
    runWaterfall, dispose,
    settingsPath,
    testHome,
    /** 直接改盘（模拟用户手改设置文件），下一次读取即生效。 */
    setSettings: (s) => writeFileSync(settingsPath, `${JSON.stringify(sanitizeSettings(s), null, 2)}\n`, 'utf8'),
    readSettingsFile: () => JSON.parse(readFileSync(settingsPath, 'utf8')),
  };
}

/** 造一个用于 waterfall 的失败载荷。 */
function failurePayload(session, overrides = {}) {
  return {
    turn: 1,
    step: 1,
    provider: 'test-provider',
    failure: { message: 'rate limited', code: 'RATE_LIMIT' },
    signal: new AbortController().signal,
    // `agent` 是真实 waterfall 载荷的一部分（loop 传的是 agent 实例）；
    // 插件从 `agent.session` 追加持久事件，所以桩必须提供它。
    agent: { session },
    ...overrides,
  };
}

console.log('\n── 1. 退避曲线（纯函数）──');

await test('默认曲线是指数增长且被上限封顶', () => {
  const settings = sanitizeSettings(DEFAULTS);
  const curve = backoffCurve(settings, 8);
  assert.equal(curve[0], 2000, '第 1 轮应等于首次等待');
  assert.equal(curve[1], 4000, '第 2 轮应翻倍');
  assert.equal(curve[2], 8000);
  assert.equal(curve[3], 16000);
  assert.equal(curve[4], 32000);
  assert.equal(curve[5], 60000, '应被 maxDelayMs 封顶');
  assert.equal(curve[6], 60000, '封顶后保持');
});

await test('倍率为 1 时退避恒定（固定间隔）', () => {
  const settings = sanitizeSettings({ multiplier: 1, initialDelayMs: 3000, maxDelayMs: 60000 });
  const curve = backoffCurve(settings, 4);
  assert.deepEqual(curve, [3000, 3000, 3000, 3000]);
});

await test('倍率与基数改变曲线', () => {
  const settings = sanitizeSettings({ multiplier: 3, initialDelayMs: 1000, maxDelayMs: 60000 });
  assert.deepEqual(backoffCurve(settings, 4), [1000, 3000, 9000, 27000]);
});

await test('抖动在 ±ratio 内且不越过上限', () => {
  const settings = sanitizeSettings({ jitterRatio: 0.3, initialDelayMs: 1000, maxDelayMs: 10000, multiplier: 2 });
  const low = backoffDelay(settings, 1, () => 0);
  const mid = backoffDelay(settings, 1, () => 0.5);
  const high = backoffDelay(settings, 1, () => 1);
  assert.equal(low, 700, '下界 = 基数 ×(1-ratio)');
  assert.equal(mid, 1000, '中值 = 基数');
  assert.equal(high, 1300, '上界 = 基数 ×(1+ratio)');
  // 封顶轮：抖动不得把等待推过 maxDelayMs。
  const capped = backoffDelay(settings, 10, () => 1);
  assert.equal(capped, 10000, '抖动后仍不得超过单轮上限');
});

await test('深轮次不溢出（指数被夹住）', () => {
  const settings = sanitizeSettings({ initialDelayMs: 1000, maxDelayMs: 60000, multiplier: 10 });
  const value = backoffDelay(settings, 500, () => 0.5);
  assert.equal(value, 60000, '极深轮次仍等于上限，而不是 Infinity/NaN');
});

console.log('\n── 2. 设置消毒（脏值不得进决策）──');

await test('越界值回落默认，而不是被悄悄夹到边界', () => {
  const settings = sanitizeSettings({ maxRounds: 99999, initialDelayMs: -5, multiplier: 100 });
  assert.equal(settings.maxRounds, DEFAULTS.maxRounds);
  assert.equal(settings.initialDelayMs, DEFAULTS.initialDelayMs);
  assert.equal(settings.multiplier, DEFAULTS.multiplier);
});

await test('非法输入不抛异常且给出合法对象', () => {
  for (const bad of [null, undefined, 42, 'x', [], { retryableCodes: 'nope' }]) {
    const settings = sanitizeSettings(bad);
    assert.equal(typeof settings.maxRounds, 'number');
    assert.ok(Array.isArray(settings.retryableCodes) && settings.retryableCodes.length > 0);
  }
});

await test('失败码白名单过滤未知码并去重', () => {
  const settings = sanitizeSettings({
    retryableCodes: ['RATE_LIMIT', 'RATE_LIMIT', 'NOT_A_REAL_CODE', 'SERVER'],
  });
  assert.deepEqual(settings.retryableCodes, ['RATE_LIMIT', 'SERVER']);
});

await test('空失败码集合回落默认（否则插件静默失效）', () => {
  const settings = sanitizeSettings({ retryableCodes: [] });
  assert.deepEqual(settings.retryableCodes, DEFAULTS.retryableCodes);
});

await test('上限低于基数时只把基数跟到上限（不弹回默认的 1 分钟）', () => {
  // 回归：把「单轮上限」滑到最左（100ms）时，旧实现会把两个值一起重置成默认
  // （60s），于是滑杆跳到"1 分钟"。现在只做行为等价的归一化：基数跟到上限。
  const settings = sanitizeSettings({ initialDelayMs: 50000, maxDelayMs: 1000 });
  assert.equal(settings.maxDelayMs, 1000, '用户设的上限必须保留');
  assert.equal(settings.initialDelayMs, 1000, '基数跟到上限');

  const left = sanitizeSettings({ maxDelayMs: 100 });
  assert.equal(left.maxDelayMs, 100, '滑到最左应保持 100ms');
  assert.equal(left.initialDelayMs, 100, '基数跟到 100ms');
  assert.equal(backoffDelay(left, 1, () => 0.5), 100, '第 1 轮按上限等 100ms');

  // 归一化前后每一轮的实际等待完全相同（上限本来就封顶）。
  const base = sanitizeSettings({ initialDelayMs: 50000, maxDelayMs: 1000 });
  assert.deepEqual(
    backoffCurve(base, 5),
    backoffCurve({ ...base, initialDelayMs: 1000 }, 5),
    '归一化不得改变退避曲线',
  );
});

console.log('\n── 3. 宿主半边：429 被接住并按设置退避 ──');

await test('RATE_LIMIT 触发重试，且先持久后等待', async () => {
  const harness = makeCtx({ settings: { initialDelayMs: 100, multiplier: 2, maxRounds: 3, jitterRatio: 0 } });
  applyHost(harness.ctx, {});

  const result = await harness.runWaterfall(failurePayload(harness.session));

  assert.deepEqual(result, { kind: 'retry' }, '应返回 retry 决定');
  const planned = harness.events.filter((e) => e.type === 'llm/retry-backoff');
  assert.equal(planned.length, 1, '应写入一条计划事件');
  assert.equal(planned[0].data.round, 1);
  assert.equal(planned[0].data.delayMs, 100, '第 1 轮等待应等于首次等待');
  assert.equal(planned[0].data.provider, 'test-provider');
  assert.equal(planned[0].data.failure.code, 'RATE_LIMIT');
  // 先持久后等待：计划事件必须排在"已开始"事件之前。
  const startedIndex = harness.events.findIndex((e) => e.type === 'llm/retry-backoff-started');
  const plannedIndex = harness.events.findIndex((e) => e.type === 'llm/retry-backoff');
  assert.ok(plannedIndex >= 0 && startedIndex > plannedIndex, '计划事件必须先于开始事件');

  await harness.dispose();
});

await test('轮次递增使用指数退避（第 2 轮更久）', async () => {
  const harness = makeCtx({ settings: { initialDelayMs: 400, multiplier: 3, maxRounds: 5, jitterRatio: 0 } });
  applyHost(harness.ctx, {});

  await harness.runWaterfall(failurePayload(harness.session));
  await harness.runWaterfall(failurePayload(harness.session));

  const planned = harness.events.filter((e) => e.type === 'llm/retry-backoff');
  assert.equal(planned.length, 2);
  assert.equal(planned[0].data.delayMs, 400);
  assert.equal(planned[1].data.delayMs, 1200, '第 2 轮 = 400×3');
  assert.equal(planned[1].data.round, 2);

  await harness.dispose();
});

await test('预算耗尽后调 next() 交回下游（不是直接失败）', async () => {
  const harness = makeCtx({ settings: { initialDelayMs: 100, maxRounds: 2, jitterRatio: 0 } });
  applyHost(harness.ctx, {});

  // 下游（官方 llm-retry 位置）返回一个可识别的决定。
  const downstream = [];
  harness.ctx.on('agent/request-error', async () => {
    downstream.push('called');
    return { kind: 'retry' };
  });

  const first = await harness.runWaterfall(failurePayload(harness.session));
  const second = await harness.runWaterfall(failurePayload(harness.session));
  const third = await harness.runWaterfall(failurePayload(harness.session));

  assert.deepEqual(first, { kind: 'retry' });
  assert.deepEqual(second, { kind: 'retry' });
  assert.deepEqual(third, { kind: 'retry' }, '第 3 次应由下游回答');
  assert.equal(downstream.length, 1, '下游只应在预算耗尽后被调用一次');
  assert.equal(
    harness.events.filter((e) => e.type === 'llm/retry-backoff').length,
    2,
    '本插件只应计划 2 次（= maxRounds）',
  );

  await harness.dispose();
});

await test('maxRounds=0 时完全不介入（等价于关闭）', async () => {
  const harness = makeCtx({ settings: { maxRounds: 0 } });
  applyHost(harness.ctx, {});
  const downstream = [];
  harness.ctx.on('agent/request-error', async () => { downstream.push(1); return undefined; });

  const result = await harness.runWaterfall(failurePayload(harness.session));
  assert.equal(result, undefined);
  assert.equal(downstream.length, 1, '应立刻交回下游');
  assert.equal(harness.events.length, 0, '不应写任何事件');
  await harness.dispose();
});

await test('enabled=false 时不介入', async () => {
  const harness = makeCtx({ settings: { enabled: false } });
  applyHost(harness.ctx, {});
  const result = await harness.runWaterfall(failurePayload(harness.session));
  assert.equal(result, undefined, '禁用后应交回下游');
  assert.equal(harness.events.length, 0);
  await harness.dispose();
});

await test('集合外的失败码不重试（如 AUTH）', async () => {
  const harness = makeCtx({ settings: { maxRounds: 5 } });
  applyHost(harness.ctx, {});
  const result = await harness.runWaterfall(failurePayload(harness.session, {
    failure: { message: 'bad key', code: 'AUTH' },
  }));
  assert.equal(result, undefined, 'AUTH 不该被本插件重试');
  assert.equal(harness.events.length, 0);
  await harness.dispose();
});

await test('用户把码加进集合后即生效', async () => {
  const harness = makeCtx({ settings: { maxRounds: 2, retryableCodes: ['AUTH'], initialDelayMs: 100, jitterRatio: 0 } });
  applyHost(harness.ctx, {});
  const result = await harness.runWaterfall(failurePayload(harness.session, {
    failure: { message: 'bad key', code: 'AUTH' },
  }));
  assert.deepEqual(result, { kind: 'retry' });
  await harness.dispose();
});

await test('提供方 Retry-After 在开关打开且不超上限时被采用', async () => {
  const harness = makeCtx({
    settings: { maxRounds: 3, initialDelayMs: 100, maxDelayMs: 60000, respectProviderRetryAfter: true, jitterRatio: 0 },
  });
  applyHost(harness.ctx, {});
  await harness.runWaterfall(failurePayload(harness.session, {
    failure: { message: 'rate limited', code: 'RATE_LIMIT', providerRetryAfterMs: 7000 },
  }));
  const planned = harness.events.find((e) => e.type === 'llm/retry-backoff');
  assert.equal(planned.data.delayMs, 7000, '应采用提供方给出的等待');
  assert.equal(planned.data.delaySource, 'provider');
  await harness.dispose();
});

await test('提供方等待超过单轮上限时退回本地曲线（仍会重试）', async () => {
  const harness = makeCtx({
    settings: { maxRounds: 3, initialDelayMs: 200, maxDelayMs: 5000, respectProviderRetryAfter: true, jitterRatio: 0 },
  });
  applyHost(harness.ctx, {});
  await harness.runWaterfall(failurePayload(harness.session, {
    failure: { message: 'rate limited', code: 'RATE_LIMIT', providerRetryAfterMs: 999999 },
  }));
  const planned = harness.events.find((e) => e.type === 'llm/retry-backoff');
  assert.equal(planned.data.delayMs, 200, '应退回本地第 1 轮等待');
  assert.match(String(planned.data.delaySource), /^local/);
  await harness.dispose();
});

await test('关闭 Retry-After 开关时忽略提供方指令', async () => {
  const harness = makeCtx({
    settings: { maxRounds: 3, initialDelayMs: 150, respectProviderRetryAfter: false, jitterRatio: 0 },
  });
  applyHost(harness.ctx, {});
  await harness.runWaterfall(failurePayload(harness.session, {
    failure: { message: 'rate limited', code: 'RATE_LIMIT', providerRetryAfterMs: 5000 },
  }));
  const planned = harness.events.find((e) => e.type === 'llm/retry-backoff');
  assert.equal(planned.data.delayMs, 150);
  await harness.dispose();
});

console.log('\n── 4. 取消与生命周期 ──');

await test('等待期间取消 ⇒ 不重试、不写开始事件', async () => {
  const harness = makeCtx({ settings: { maxRounds: 3, initialDelayMs: 5000, jitterRatio: 0 } });
  applyHost(harness.ctx, {});

  const controller = new AbortController();
  const pending = harness.runWaterfall(failurePayload(harness.session, { signal: controller.signal }));
  await tick(10);
  controller.abort();
  const result = await pending;

  assert.equal(result, undefined, '取消后不应返回 retry 决定');
  assert.equal(
    harness.events.filter((e) => e.type === 'llm/retry-backoff-started').length,
    0,
    '取消后不应写"已开始"事件',
  );
  await harness.dispose();
});

await test('已取消的信号进入时立刻归还', async () => {
  const harness = makeCtx({ settings: { maxRounds: 3, initialDelayMs: 100 } });
  applyHost(harness.ctx, {});
  const controller = new AbortController();
  controller.abort();
  const result = await harness.runWaterfall(failurePayload(harness.session, { signal: controller.signal }));
  assert.equal(result, undefined);
  await harness.dispose();
});

await test('卸载会中止进行中的等待并排空', async () => {
  const harness = makeCtx({ settings: { maxRounds: 3, initialDelayMs: 5000, jitterRatio: 0 } });
  applyHost(harness.ctx, {});
  const pending = harness.runWaterfall(failurePayload(harness.session));
  await tick(10);
  await harness.dispose();
  const result = await pending;
  assert.equal(result, undefined, '卸载后退避应被中止');
});

await test('按提供方分别计算预算', async () => {
  const harness = makeCtx({ settings: { maxRounds: 1, initialDelayMs: 100, jitterRatio: 0 } });
  applyHost(harness.ctx, {});
  const downstream = [];
  harness.ctx.on('agent/request-error', async () => { downstream.push(1); return undefined; });

  const a = await harness.runWaterfall(failurePayload(harness.session, { provider: 'provider-a' }));
  const b = await harness.runWaterfall(failurePayload(harness.session, { provider: 'provider-b' }));
  const aAgain = await harness.runWaterfall(failurePayload(harness.session, { provider: 'provider-a' }));

  assert.deepEqual(a, { kind: 'retry' }, 'provider-a 第 1 次应重试');
  assert.deepEqual(b, { kind: 'retry' }, 'provider-b 有自己的一份预算');
  assert.equal(aAgain, undefined, 'provider-a 预算已耗尽');
  assert.equal(downstream.length, 1);
  await harness.dispose();
});

await test('新步骤重置预算（step/start 清空投影）', async () => {
  const harness = makeCtx({ settings: { maxRounds: 1, initialDelayMs: 100, jitterRatio: 0 } });
  applyHost(harness.ctx, {});
  harness.ctx.on('agent/request-error', async () => undefined);

  await harness.runWaterfall(failurePayload(harness.session));
  const exhausted = await harness.runWaterfall(failurePayload(harness.session));
  assert.equal(exhausted, undefined, '预算应已耗尽');

  // 新的一步开始 ⇒ 投影清空 ⇒ 预算恢复。
  harness.session.append('step/start', { turn: 1, step: 2 });
  const fresh = await harness.runWaterfall(failurePayload(harness.session));
  assert.deepEqual(fresh, { kind: 'retry' }, '新步骤应有新的预算');
  await harness.dispose();
});

await test('行内 config 非空即报错（防止设置写错位置）', () => {
  const harness = makeCtx();
  assert.throws(
    () => applyHost(harness.ctx, { maxRounds: 3 }),
    /unknown inline key/,
    '行内 config 必须被拒绝',
  );
});

/**
if (failed > 0) process.exit(1);

console.log('\n── 5. 设置 HTTP 路由 ──');
//
// 这一节**不自己造 webServer 再调 registerSettingsRoutes**，而是走 `apply`：
// 路由必须由插件挂载时自己注册，否则"插件装了但面板 404"这类真实故障测不出来
// （这正是最初用 `ctx.get('webServer')` 时踩到的坑）。

/** 造一对假的 req/res，收集应答。 */
function makePair({ method = 'GET', body } = {}) {
  const chunks = [];
  const listeners = {};
  const req = {
    method,
    on(event, fn) { (listeners[event] ??= []).push(fn); return req; },
    destroy() {},
  };
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    end(payload) { chunks.push(payload ?? ''); },
  };
  // 异步派发请求体，模拟真实流。
  queueMicrotask(() => {
    if (body !== undefined) {
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      for (const fn of listeners.data ?? []) fn(buf);
    }
    for (const fn of listeners.end ?? []) fn();
  });
  return { req, res, body: () => chunks.join('') };
}

/** 挂载插件并取回它注册的路由处理器。 */
function mountAndGetRoute(initialSettings) {
  const harness = makeCtx({ settings: initialSettings });
  applyHost(harness.ctx, {});
  const handler = harness.routes.get(`exact:${BASE}/settings`);
  const reset = harness.routes.get(`exact:${BASE}/reset`);
  return { harness, handler, reset };
}

await test('apply 自己注册了 GET/PUT 与 reset 路由（面板不会 404）', async () => {
  const { harness, handler, reset } = mountAndGetRoute();
  assert.ok(handler, `apply 应注册 exact:${BASE}/settings`);
  assert.ok(reset, `apply 应注册 exact:${BASE}/reset`);
  await harness.dispose();
});

await test('GET 返回设置、默认值、量程与预览曲线', async () => {
  const { harness, handler } = mountAndGetRoute({ maxRounds: 4, initialDelayMs: 1000, multiplier: 2 });
  const { req, res, body } = makePair({ method: 'GET' });
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(body());
  assert.equal(payload.settings.maxRounds, 4);
  assert.equal(payload.curve.length, 4, '曲线长度 = 轮次');
  assert.equal(payload.curve[0], 1000);
  assert.equal(payload.curve[1], 2000);
  assert.ok(payload.limits?.maxRounds, '应带出量程供面板渲染');
  assert.ok(Array.isArray(payload.codes) && payload.codes.length > 0, '应带出可选失败码');
  assert.equal(payload.runtime.writable, true);
  await harness.dispose();
});

await test('PUT 写入经消毒后的完整快照', async () => {
  const { harness, handler } = mountAndGetRoute();
  const { req, res, body } = makePair({
    method: 'PUT',
    body: { maxRounds: 12, initialDelayMs: 3000, multiplier: 1.5, maxDelayMs: 45000, jitterRatio: 0.1 },
  });
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(body());
  assert.equal(payload.settings.maxRounds, 12, '写入应生效');
  assert.equal(payload.curve.length, 12);
  await harness.dispose();
});

await test('PUT 拒绝越界值（回落默认而非夹到边界）', async () => {
  const { harness, handler } = mountAndGetRoute();
  const { req, res, body } = makePair({ method: 'PUT', body: { maxRounds: -100 } });
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(body()).settings.maxRounds, DEFAULTS.maxRounds, '越界值应回落默认');
  await harness.dispose();
});

await test('PUT 单轮上限拉到最小（100ms）不会被重置回默认', async () => {
  const { harness, handler } = mountAndGetRoute();
  const { req, res, body } = makePair({ method: 'PUT', body: { maxDelayMs: 100 } });
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(body());
  assert.equal(payload.settings.maxDelayMs, 100, '上限必须保留 100ms');
  assert.equal(payload.settings.initialDelayMs, 100, '基数跟到上限');
  assert.equal(payload.curve[0], 100, '首轮等待按 100ms 预览');
  assert.equal(payload.curve.at(-1), 100, '所有轮都不超过 100ms');
  await harness.dispose();
});

await test('PUT 坏 JSON ⇒ 400；超限 ⇒ 413；非 GET/PUT ⇒ 405', async () => {
  const { harness, handler } = mountAndGetRoute();

  const bad = makePair({ method: 'PUT', body: '{not json' });
  await handler(bad.req, bad.res);
  assert.equal(bad.res.statusCode, 400, '坏 JSON 应 400');

  const huge = makePair({ method: 'PUT', body: JSON.stringify({ pad: 'x'.repeat(40 * 1024) }) });
  await handler(huge.req, huge.res);
  assert.equal(huge.res.statusCode, 413, '超限应 413');

  const wrong = makePair({ method: 'DELETE' });
  await handler(wrong.req, wrong.res);
  assert.equal(wrong.res.statusCode, 405, '其他方法应 405');

  await harness.dispose();
});

await test('POST /reset 让设置回默认', async () => {
  const { harness, reset } = mountAndGetRoute({ maxRounds: 99 });
  const { req, res, body } = makePair({ method: 'POST' });
  await reset(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(body()).settings.maxRounds, DEFAULTS.maxRounds, '重置后应回默认');
  await harness.dispose();
});

await test('没有 settings 服务也报告可写（设置存在插件自己的文件里）', async () => {
  // 回归：DSH 0.2.x 的 settings 服务没有 register()。旧实现会永远只读，
  // 面板两个按钮永久 disabled（用户看到"点了没反应"）。
  const harness = makeCtx();
  applyHost(harness.ctx, {});
  const handler = harness.routes.get(`exact:${BASE}/settings`);

  const get = makePair({ method: 'GET' });
  await handler(get.req, get.res);
  const payload = JSON.parse(get.body());
  assert.equal(get.res.statusCode, 200);
  assert.equal(payload.runtime.writable, true, '文件存储必须报告可写');
  assert.equal(payload.runtime.storage, 'file');
  assert.equal(payload.runtime.path, harness.settingsPath);

  await harness.dispose();
});

await test('PUT 原子落盘，重挂载后仍是保存值', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rb-persist-'));
  const harness = makeCtx({ home });
  applyHost(harness.ctx, {});
  const handler = harness.routes.get(`exact:${BASE}/settings`);

  const put = makePair({
    method: 'PUT',
    body: { maxRounds: 7, initialDelayMs: 2500, multiplier: 3, maxDelayMs: 30000, jitterRatio: 0 },
  });
  await handler(put.req, put.res);
  assert.equal(put.res.statusCode, 200);

  // 磁盘上真的写了（且是消毒后的完整快照）。
  const onDisk = harness.readSettingsFile();
  assert.equal(onDisk.maxRounds, 7);
  assert.equal(onDisk.initialDelayMs, 2500);
  assert.ok(onDisk.settingsVersion >= 1);
  assert.equal(existsSync(`${harness.settingsPath}.tmp`), false, '不应留下 tmp 文件');

  // 同一个 home 重新挂载（模拟 DSH 重启）⇒ 设置从文件读回。
  await harness.dispose();
  const second = makeCtx({ home });
  applyHost(second.ctx, {});
  const get = makePair({ method: 'GET' });
  await second.routes.get(`exact:${BASE}/settings`)(get.req, get.res);
  assert.equal(JSON.parse(get.body()).settings.maxRounds, 7, '重启后设置必须还在');
  await second.dispose();
  rmSync(home, { recursive: true, force: true });
});

await test('POST /reset 删除设置文件并回默认', async () => {
  const { harness, reset } = mountAndGetRoute({ maxRounds: 99 });
  assert.equal(harness.readSettingsFile().maxRounds, 99, '前置：文件里应是自定义值');

  const { req, res, body } = makePair({ method: 'POST' });
  await reset(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(body()).settings.maxRounds, DEFAULTS.maxRounds, '重置后应回默认');
  assert.equal(existsSync(harness.settingsPath), false, 'reset 应删掉用户设置文件');
  await harness.dispose();
});

await test('设置文件损坏时回落默认值（不崩、不把坏值带进决策）', async () => {
  const { harness, handler } = mountAndGetRoute();
  writeFileSync(harness.settingsPath, '{ this is not json', 'utf8');

  const get = makePair({ method: 'GET' });
  await handler(get.req, get.res);
  assert.equal(get.res.statusCode, 200);
  assert.equal(JSON.parse(get.body()).settings.maxRounds, DEFAULTS.maxRounds);
  assert.ok(harness.log.some(([level]) => level === 'warn'), '坏文件应告警一次');
  await harness.dispose();
});

await test('写盘失败 ⇒ 500（存储问题不是请求非法）', async () => {
  const harness = makeCtx();
  applyHost(harness.ctx, {});
  const handler = harness.routes.get(`exact:${BASE}/settings`);
  // 直接测路由的错误分支：写依赖抛错时应 500，而不是 400/崩溃。
  const server = {
    routes: new Map(),
    register({ kind, path, handler: h }) {
      server.routes.set(`${kind}:${path}`, h);
      return () => {};
    },
  };
  registerSettingsRoutes(harness.ctx, server, {
    readSettings: () => sanitizeSettings(DEFAULTS),
    writeSettings: async () => { throw new Error('disk full'); },
    resetSettings: async () => { throw new Error('disk full'); },
    settingsPath: '/nonexistent/settings.json',
  });
  const failHandler = server.routes.get(`exact:${BASE}/settings`);
  const failReset = server.routes.get(`exact:${BASE}/reset`);

  const put = makePair({ method: 'PUT', body: { maxRounds: 3 } });
  await failHandler(put.req, put.res);
  assert.equal(put.res.statusCode, 500, '写盘失败应 500');

  const post = makePair({ method: 'POST' });
  await failReset(post.req, post.res);
  assert.equal(post.res.statusCode, 500, '重置失败也应 500');
  await harness.dispose();
});


await test('设置存储只写消毒后的值，且并发保存按顺序完成', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rb-store-'));
  const filePath = join(home, 'settings.json');
  const store = createSettingsStore({ filePath });

  // 越界值先消毒再落盘：磁盘上不能出现 99999。
  await store.save({ maxRounds: 99999, initialDelayMs: -1 });
  assert.equal(store.get().maxRounds, DEFAULTS.maxRounds);
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).maxRounds, DEFAULTS.maxRounds);

  // 并发写：最后一个请求的结果应成为最终值（不被旧快照吞掉）。
  await Promise.all([
    store.save({ maxRounds: 3 }),
    store.save({ maxRounds: 4 }),
    store.save({ maxRounds: 5 }),
  ]);
  assert.equal(store.get().maxRounds, 5, '串行化后应是最后一次写入');
  assert.equal(existsSync(`${filePath}.tmp`), false);

  await store.reset();
  assert.equal(store.get().maxRounds, DEFAULTS.maxRounds);
  assert.equal(existsSync(filePath), false);
  rmSync(home, { recursive: true, force: true });
});

await test('DSH_RETRY_BACKOFF_SETTINGS 覆盖设置文件路径', () => {
  const previous = process.env.DSH_RETRY_BACKOFF_SETTINGS;
  process.env.DSH_RETRY_BACKOFF_SETTINGS = 'C:\\tmp\\rb-settings.json';
  try {
    assert.equal(resolveSettingsPath(), 'C:\\tmp\\rb-settings.json');
  } finally {
    if (previous === undefined) delete process.env.DSH_RETRY_BACKOFF_SETTINGS;
    else process.env.DSH_RETRY_BACKOFF_SETTINGS = previous;
  }
});


if (failed > 0) process.exit(1);
console.log('\n── 6. 浏览器半边产物 ──');

await test('client bundle 是合法的 __ModuleLoader__ 模块且能挂载面板', async () => {
  const require = createRequire(import.meta.url);
  const { readFileSync } = require('node:fs');
  const source = readFileSync(new URL('../lib/client.bundle.js', import.meta.url), 'utf8');

  assert.match(source, /window\.__ModuleLoader__\.load\(/, '必须是自定义模块壳形态');
  assert.match(source, /exports\.apply\s*=/, '必须导出 apply');
  assert.match(source, /exports\.inject\s*=/, '必须导出 inject');

  // 用假的 window / React 真正执行一遍，验证挂载逻辑（而不是只做文本匹配）。
  const registered = [];
  let stylesInjected = 0;
  let rendered = 0;
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };

  /**
   * 极简渲染器：递归执行**函数组件**，把元素树真正走一遍。
   *
   * 这是本文件里最关键的一段：DSH 的座位只接受一个"返回元素的函数"，
   * 而静态检查无法发现组件内部在渲染期抛错（那在浏览器里表现为空白面板）。
   * 所以这里手动调用每个函数组件，让 `(React, props)` 这类签名错误当场暴露。
   *
   * @param {unknown} node - 元素 / 数组 / 基本值。
   * @param {number} depth - 递归深度上限保护。
   * @returns {number} 成功渲染的节点数。
   */
  function renderTree(node, depth = 0) {
    if (depth > 40) throw new Error('renderTree: 递归过深（组件可能在自渲染）');
    if (node === null || node === undefined || typeof node === 'boolean') return 0;
    if (Array.isArray(node)) {
      return node.reduce((sum, child) => sum + renderTree(child, depth + 1), 0);
    }
    if (typeof node !== 'object') return 1;
    if (typeof node.type === 'function') {
      // 关键：React 只会传**一个** props 参数。
      const out = node.type(node.props ?? {});
      return 1 + renderTree(out, depth + 1);
    }
    return 1 + (node.children ?? []).reduce(
      (sum, child) => sum + renderTree(child, depth + 1),
      0,
    );
  }

  const fakeDocument = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => { stylesInjected += 1; } },
  };
  const windowStub = {
    __ModuleLoader__: {
      load({ id, factory }) {
        registered.push({ id, factory });
      },
    },
    __RB_REACT__: fakeReact,
  };
  globalThis.window = windowStub;
  globalThis.document = fakeDocument;

  try {
    // 在受控全局里执行产物（这正是前端加载它的方式）。
    const fn = new Function('window', 'document', `${source}`);
    fn(windowStub, fakeDocument);

    assert.equal(registered.length, 1, '应注册一个模块');
    assert.equal(registered[0].id, 'dsh-plugin-retry-backoff');

    const exports = registered[0].factory((name) => (name === 'react' ? fakeReact : undefined));
    assert.equal(typeof exports.apply, 'function');
    assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots'));

    // 挂载：应注册到 settings.section 座位。
    const injectCalls = [];
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      slots: {
        inject: (seat, cb) => { injectCalls.push(seat); return cb(); },
        register: (options, render) => {
          injectCalls.push(options);
          assert.equal(options.name, 'settings.section');
          assert.equal(typeof render, 'function', '应提供渲染函数');
          const element = render();
          assert.ok(element, '渲染函数应返回元素');
          // ⚠️ 只断言"返回了元素"是不够的：React 只会**渲染时**才调用组件函数。
          // 本仓真实踩过：Panel 的签名写成 (React, props)，createElement 只传一个
          // props 参数 ⇒ 第二个形参 undefined ⇒ 解构抛错 ⇒
          // "设置导航里有这一行、点进去右侧全白"。所以这里必须真正**执行**组件。
          rendered = renderTree(element, 0);
          assert.ok(rendered > 0, '组件应能成功渲染出内容（不能抛错）');
          return () => {};
        },
      },
    };
    exports.apply(ctx);
    assert.ok(injectCalls.includes('settings.section'), '应登记到 settings.section 座位');
    assert.equal(stylesInjected, 1, '应注入一次面板样式');
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

await test('共享 schema 未被复制（两侧同源）', async () => {
  const { readFileSync } = await import('node:fs');
  const bundle = readFileSync(new URL('../lib/client.bundle.js', import.meta.url), 'utf8');
  // 内联证据：客户端 bundle 里应出现 schema 的公式，而不是重新实现一份。
  assert.match(bundle, /jitterRatio/, '应内联共享 schema 的字段');
  assert.match(bundle, /RETRYABLE_CODE_CHOICES/, '应内联失败码白名单');
});

console.log(`\n${'─'.repeat(52)}`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
