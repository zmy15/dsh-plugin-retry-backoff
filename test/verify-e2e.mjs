/**
 * test/verify-e2e.mjs — 端到端：模拟真实 agent loop 的重试循环。
 *
 * 前面的 run.mjs 是**单元**测试（逐条断言插件的每个分支）。本文件回答的是另一个
 * 问题：把插件放进一个**尽量照抄真实契约**的环境里，一次"429 一直失败直到成功"
 * 的完整轮次能不能走通 —— 包括：
 *   · waterfall 的 `next()` 链（本插件 → 官方 llm-retry → 默认放弃）；
 *   · 插件返回 `{kind:'retry'}` 后 loop **重跑同一步**（我们真的重跑）；
 *   · 失败若干次后成功 ⇒ 轮次结束、预算重置；
 *   · 每次重试都先写持久事件（崩溃一致性）。
 *
 * 用法：node test/verify-e2e.mjs
 */

import { apply as applyHost } from '../lib/index.js';
import { sanitizeSettings } from '../lib/settings-schema.js';

let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

console.log('\n端到端：429 反复失败直至成功\n');

/** 造一个"会话"，记录事件流并支持投影重放。 */
function makeSession() {
  const events = [];
  return {
    id: 'e2e',
    events,
    append(type, data) {
      events.push({ type, data });
    },
  };
}

/**
 * 造一个尽量贴近真实的上下文：
 *  · `on` 收集 waterfall 监听器（登记顺序 = 链顺序）；
 *  · `sessionProjections` 从会话事件重放（与真实投影同一语义）；
 *  · `settings` 提供一个可写的 scope（模拟真实 SettingsScope）。
 */
function makeCtx(initial, session) {
  const listeners = [];
  const effects = [];
  const projections = new Map();
  const current = { value: sanitizeSettings(initial) };
  const writes = [];

  const scope = {
    get: () => current.value,
    watch: () => () => {},
    update: async (patch) => {
      writes.push(patch);
      current.value = sanitizeSettings({ ...current.value, ...patch });
    },
    replace: async (section) => {
      writes.push(section);
      current.value = sanitizeSettings(section);
    },
  };

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // `webServer` 是 inject 里的硬依赖：apply 会直接调用 ctx.webServer.register
    // 注册设置路由（用 ctx.get 会在挂载期拿到 undefined 而静默丢路由 —— 实测踩过）。
    webServer: {
      register() { return () => {}; },
    },
    on(event, handler) {
      if (event === 'agent/request-error') listeners.push(handler);
      return () => {
        const i = listeners.indexOf(handler);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    effect(fn) { effects.push(fn); },
    get(name, strict = true) { return name === 'settings' ? { register: () => scope, get: () => current.value } : undefined; },
    // 设置命名空间通过 ctx.inject(['settings'], …) 挂载（等依赖就绪后回调）。
    inject(_deps, callback) { callback(ctx); return undefined; },
    sessionProjections: {
      register(def) { projections.set(def.key, def); return () => projections.delete(def.key); },
      stateOf(_s, key) {
        const def = projections.get(key);
        if (!def) return undefined;
        let state = def.init();
        for (const event of session.events) state = def.apply(state, event);
        return state;
      },
    },
  };

  return { ctx, scope, current, writes, listeners };
}

/**
 * 跑一次 waterfall 链（模拟 loop 的 dispatch.waterfall 语义）。
 * @param {Function[]} chain - 监听器链。
 * @param {object} payload - 载荷。
 * @returns {Promise<unknown>} 最终决定。
 */
async function runChain(chain, payload) {
  let index = -1;
  const next = async () => {
    index += 1;
    if (index >= chain.length) return undefined;
    return chain[index](payload, next);
  };
  return next();
}

// ── 场景：请求连续失败 4 次后成功 ───────────────────────────────────────────
{
  const session = makeSession();
  const harness = makeCtx(
    { enabled: true, maxRounds: 10, initialDelayMs: 100, multiplier: 2, maxDelayMs: 2000, jitterRatio: 0, retryableCodes: ['RATE_LIMIT'] },
    session,
  );

  // 本插件先登记（profile 里它在 llm-retry 之前）。
  applyHost(harness.ctx, {});

  // 官方 llm-retry 的**桩**：它按自己的策略回答；这里模拟"其预算已耗尽 ⇒ 交回下游"。
  let downstreamCalls = 0;
  harness.listeners.push(async (_payload, next) => {
    downstreamCalls += 1;
    return next();
  });

  // 真实 loop 语义：waterfall 说 retry 就重跑同一步。
  let attempt = 0;
  const FAILURES_BEFORE_SUCCESS = 4;
  const delays = [];

  while (attempt < 20) {
    attempt += 1;
    // 模拟一次模型请求：前 N 次失败，之后成功。
    const failed = attempt <= FAILURES_BEFORE_SUCCESS;
    if (!failed) break;

    const started = Date.now();
    const decision = await runChain(harness.listeners, {
      turn: 1,
      step: 1,
      provider: 'xiaoduoai',
      failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
      signal: new AbortController().signal,
      agent: { session },
    });
    const waited = Date.now() - started;

    if (decision?.kind !== 'retry') {
      check(`第 ${attempt} 次失败后应得到 retry 决定`, false, `实际：${JSON.stringify(decision)}`);
      break;
    }
    delays.push(waited);
  }

  check('最终请求成功（循环正常退出）', attempt === FAILURES_BEFORE_SUCCESS + 1,
    `共尝试 ${attempt} 次`);
  check('重试次数等于失败次数', session.events.filter((e) => e.type === 'llm/retry-backoff').length === FAILURES_BEFORE_SUCCESS);

  // 退避应当是递增的（指数）。
  const planned = session.events.filter((e) => e.type === 'llm/retry-backoff').map((e) => e.data.delayMs);
  check('退避按指数增长', JSON.stringify(planned) === JSON.stringify([100, 200, 400, 800]),
    `实际：${JSON.stringify(planned)}`);
  check('实际等待时间接近计划值', delays.every((w, i) => w >= planned[i] - 5),
    `计划 ${JSON.stringify(planned)}，实际 ${JSON.stringify(delays)}`);

  // 每次重试都必须是"先持久后开始"。
  const order = session.events.map((e) => e.type);
  const pairs = [];
  for (let i = 0; i < order.length; i += 1) {
    if (order[i] === 'llm/retry-backoff') pairs.push(order[i + 1] === 'llm/retry-backoff-started');
  }
  check('每次重试都先写计划、再写开始', pairs.length === FAILURES_BEFORE_SUCCESS && pairs.every(Boolean),
    `事件流：${order.join(' → ')}`);

  // 轮次编号应连续递增。
  const rounds = session.events.filter((e) => e.type === 'llm/retry-backoff').map((e) => e.data.round);
  check('轮次编号连续递增', JSON.stringify(rounds) === JSON.stringify([1, 2, 3, 4]),
    `实际：${JSON.stringify(rounds)}`);
  check('同一次失败序列共用一个 retryId',
    new Set(session.events.filter((e) => e.type === 'llm/retry-backoff').map((e) => e.data.retryId)).size === 1);
  check('下游（官方策略）在所有重试中都未被调用', downstreamCalls === 0,
    `被调用 ${downstreamCalls} 次`);

  // 轮次结束后（turn/end）预算应重置。
  session.append('turn/end', { turn: 1 });
  const afterTurnEnd = harness.ctx.sessionProjections.stateOf(session, 'llmRetryBackoff');
  check('轮次结束后预算重置', Object.keys(afterTurnEnd).length === 0,
    `实际：${JSON.stringify(afterTurnEnd)}`);

  await Promise.all(effectsCleanup(harness.ctx));
}

// ── 场景：预算耗尽后交回下游（官方策略接管）────────────────────────────────
{
  const session = makeSession();
  const harness = makeCtx(
    { enabled: true, maxRounds: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 2000, jitterRatio: 0, retryableCodes: ['RATE_LIMIT'] },
    session,
  );
  applyHost(harness.ctx, {});

  let officialDecisions = 0;
  harness.listeners.push(async () => {
    officialDecisions += 1;
    return { kind: 'retry' }; // 官方策略说"我还要重试"
  });

  const decisions = [];
  for (let i = 0; i < 3; i += 1) {
    decisions.push(await runChain(harness.listeners, {
      turn: 1, step: 1, provider: 'p',
      failure: { message: 'rate limited', code: 'RATE_LIMIT' },
      signal: new AbortController().signal,
      agent: { session },
    }));
  }

  check('前 2 次由本插件处理', decisions[0]?.kind === 'retry' && decisions[1]?.kind === 'retry');
  check('第 3 次交回下游并采纳其决定', decisions[2]?.kind === 'retry' && officialDecisions === 1,
    `官方被调用 ${officialDecisions} 次`);
  check('本插件只计划了 maxRounds 次',
    session.events.filter((e) => e.type === 'llm/retry-backoff').length === 2);

  await Promise.all(effectsCleanup(harness.ctx));
}

// ── 场景：用户在运行中改设置，下一次失败立即生效 ────────────────────────────
{
  const session = makeSession();
  const harness = makeCtx(
    { enabled: true, maxRounds: 1, initialDelayMs: 500, multiplier: 2, maxDelayMs: 2000, jitterRatio: 0, retryableCodes: ['RATE_LIMIT'] },
    session,
  );
  applyHost(harness.ctx, {});

  await runChain(harness.listeners, {
    turn: 1, step: 1, provider: 'p',
    failure: { message: 'rl', code: 'RATE_LIMIT' },
    signal: new AbortController().signal, agent: { session },
  });
  const firstDelay = session.events.find((e) => e.type === 'llm/retry-backoff').data.delayMs;
  check('改设置前用旧值', firstDelay === 500, `实际 ${firstDelay}`);

  // 用户在面板里保存了新设置（走 scope.replace，与 HTTP 路由同一条写路径）。
  await harness.scope.replace({ ...harness.current.value, maxRounds: 5, initialDelayMs: 1200 });

  // 新的一步 ⇒ 预算重置 ⇒ 下一次失败应按新设置退避。
  session.append('step/start', { turn: 1, step: 2 });
  await runChain(harness.listeners, {
    turn: 1, step: 2, provider: 'p',
    failure: { message: 'rl', code: 'RATE_LIMIT' },
    signal: new AbortController().signal, agent: { session },
  });

  const all = session.events.filter((e) => e.type === 'llm/retry-backoff');
  check('新设置立即生效（无需重启）', all[1].data.delayMs === 1200,
    `实际 ${all[1].data.delayMs}`);
  check('新设置的最大轮次被记录', all[1].data.maxRounds === 5,
    `实际 ${all[1].data.maxRounds}`);

  await Promise.all(effectsCleanup(harness.ctx));
}

/** 触发并收集 ctx.effect 的清理器（本文件的 ctx 桩未收集，保留占位以便统一调用）。 */
function effectsCleanup(_ctx) {
  return [];
}

console.log(`\n${failed === 0 ? '端到端全部通过' : `${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);