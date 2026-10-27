/**
 * dsh-plugin-retry-backoff — host half.
 *
 * 让"模型请求出现 429 / 限流等**可通过重试解决**的失败时，按用户在设置面板里
 * 自定义的**指数退避**延长重试轮次与等待时间，直到请求成功"。
 *
 * ## 它挂在哪
 *
 * Agent loop 在模型请求以失败分片终止时，会在**打开步骤的扩展点**
 * `agent/request-error` 上跑一条 waterfall（见 `dsh-agent-loop` 的
 * `dispatch.waterfall("agent/request-error", …)`），载荷携带
 * `{ turn, step, provider, failure, retryPolicy, signal }`。
 * waterfall 的返回值只要是 `{ kind: 'retry' }`，loop 就会在**同一个打开的轮次内**
 * 重跑失败步骤。
 *
 * 官方 `@deepseek-ai/dsh-llm-retry` 也监听同一座位，并按**提供方路由自己的**
 * `retryPolicy`（normal 有界 / always 无界）决定是否重试。本插件**不替换**它，
 * 而是与它**按 waterfall 顺序组合**：
 *
 *   · 本插件把自己登记在 llm-retry **之前**（`ctx.on` 的登记顺序就是 waterfall 顺序），
 *     因此先在**自己的预算**内用**用户自定义的退避曲线**重试；
 *   · 本插件的轮次耗尽（或用户禁用 / 失败码不在集合内）时，调 `next()`
 *     把决定权**原样交回**下游——即官方策略照常生效。
 *
 * 这个分工正是"延长轮次和时间"的字面语义：官方策略负责它自己的那份，
 * 本插件负责**追加**用户要求的那一份。禁用本插件 = 逐字节回到今天的行为。
 *
 * ## 关键设计
 *
 * 1. **先持久、后等待**：每次计划的重试在任何定时器启动**之前**就追加一条
 *    非 surface 的会话事件，因此崩溃或取消不会留下不可见的待处理重试。
 * 2. **可取消**：退避等待监听传入的 `signal` 与本插件的 lifetime，
 *    任一 abort 都立刻结束等待并归还（不吞掉取消）。
 * 3. **纯函数退避**：曲线计算全部走 `settings-schema.js` 的 `backoffDelay`，
 *    与浏览器侧预览、测试共用同一条公式。
 * 4. **预算持久**：轮次计数从会话日志（`llmRetryBackoff` 投影）读出，
 *    所以重连 / 恢复后不会把预算清零重来。
 */

import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import {
  DEFAULTS,
  LIMITS,
  SETTINGS_VERSION,
  backoffDelay,
  sanitizeSettings,
} from './settings-schema.js';
import { registerSettingsRoutes } from './routes.js';

/** 插件名（cordis 行的 id 与本对象同名，日志前缀同源）。 */
export const name = 'retry-backoff';

/**
 * 依赖声明。
 *
 * `agents` 与 `sessionProjections` 是**必需**的：没有 agent loop 就没有
 * `agent/request-error` 座位，本插件无事可做。
 *
 * `webServer` 也必须是**硬依赖**（与 wallpaper-engine 同一写法）。这一点是实测
 * 得出的：cordis 的 `ctx.get(name)` 默认 `strict = true`，而严格模式**只返回
 * 提供方 fiber 已激活（state === 2）的服务**。`apply` 跑在插件挂载期，此时
 * webServer 往往还没激活 ⇒ `ctx.get('webServer')` 静默返回 undefined，
 * 设置路由**永远不会注册**（表现为路由 404、日志无错，最难查的一类）。
 * 写进 inject 让 Loader 等到服务就绪再加载本行，问题从根上消失。
 *
 * 代价是：没有 HTTP 服务的 headless profile 不会加载本插件（也就没有自定义
 * 退避）。这是有意的取舍 —— 设置面板是本插件的核心诉求，而在没有 webServer 的
 * profile 里它无论如何都画不出来；官方 llm-retry 仍照常工作。
 */
export const inject = ['agents', 'sessionProjections', 'webServer'];

/** 本插件的设置命名空间。 */
export const SETTINGS_NS = 'retry-backoff';

/**
 * 运行时 schema：本插件**没有**行内配置。
 *
 * 全部可调项都住在用户设置里（`settings.yaml` 的 `retry-backoff` 段），
 * 因为需求就是"允许用户在设置面板自定义"。行内 config 只用于拒绝误配置。
 */
export const Config = z.object({});

/**
 * 设置命名空间 schema。
 *
 * 用 schemastery 声明（与 DSH 其他命名空间一致），让官方设置界面也能读改；
 * 本插件自己的面板走 HTTP 路由（见 routes.js）以便同时支持网页端与桌面端。
 *
 * ⚠️ 必须声明在 `apply` **之前**：`apply` 在注册时立即引用它，而 `const`
 * 声明存在 TDZ —— 放在函数后面会在插件加载瞬间抛 ReferenceError。
 */
export const SettingsSchema = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  maxRounds: z.number().step(1).min(0).max(LIMITS.maxRounds.max).default(DEFAULTS.maxRounds),
  initialDelayMs: z.number().min(LIMITS.initialDelayMs.min).max(LIMITS.initialDelayMs.max).default(DEFAULTS.initialDelayMs),
  multiplier: z.number().min(LIMITS.multiplier.min).max(LIMITS.multiplier.max).default(DEFAULTS.multiplier),
  maxDelayMs: z.number().min(LIMITS.maxDelayMs.min).max(LIMITS.maxDelayMs.max).default(DEFAULTS.maxDelayMs),
  jitterRatio: z.number().min(LIMITS.jitterRatio.min).max(LIMITS.jitterRatio.max).default(DEFAULTS.jitterRatio),
  retryableCodes: z.array(z.string()).default([...DEFAULTS.retryableCodes]),
  respectProviderRetryAfter: z.boolean().default(DEFAULTS.respectProviderRetryAfter),
  settingsVersion: z.number().default(SETTINGS_VERSION),
});

/**
 * 持久预算的投影 schema。
 *
 * 形状：`{ [provider]: { round, retryId } }` —— 按提供方路由分别计数，
 * 与官方 llm-retry 按 `[provider, policyKey]` 计数同一思路（本插件的策略来自
 * 用户设置而非路由，所以键只需 provider）。
 */
const backoffStateSchema = zod.record(
  zod.string(),
  zod.object({
    round: zod.number().int().nonnegative(),
    retryId: zod.string(),
  }),
);

/** 退避状态在会话投影里的键。 */
const PROJECTION_KEY = 'llmRetryBackoff';

/**
 * 校验行内 config：非空即报错（防止用户把设置错写进行内 config 后"看起来生效了"）。
 * @param {object} config - 行内配置。
 */
function validateConfig(config) {
  const key = Object.keys(config ?? {})[0];
  if (key !== undefined) {
    throw new Error(
      `retry-backoff: unknown inline key "${key}" — configure this plugin in user settings (namespace "${SETTINGS_NS}"), not inline`,
    );
  }
}

/**
 * 可取消的等待。
 * @param {number} delayMs - 等待毫秒数。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<boolean>} true = 正常等完；false = 被取消。
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 判断一次失败是否属于"可重试解决"的一类。
 * @param {object} settings - 已消毒设置。
 * @param {object} failure - `LlmFailure`。
 * @returns {boolean} 是否应由本插件处理。
 */
function isEligible(settings, failure) {
  if (!settings.enabled) return false;
  if (settings.maxRounds <= 0) return false;
  const code = failure?.code;
  if (typeof code !== 'string') return false;
  return settings.retryableCodes.includes(code);
}

/**
 * 决定这一轮的等待时长：提供方 `Retry-After` 与本地曲线取更**尊重指令**的一个。
 *
 * 语义（与用户选择"尊重提供方 Retry-After"一致）：
 *   · 关：恒用本地指数退避曲线；
 *   · 开：提供方给了有效且**不超过上限**的等待 ⇒ 用它（服务器比我们更清楚何时能好）；
 *         提供方给的等待超过上限      ⇒ 用本地曲线（不盲从一个离谱的值）。
 * @param {object} settings - 已消毒设置。
 * @param {object} failure - `LlmFailure`。
 * @param {number} round - 轮次。
 * @returns {{ delayMs: number, source: string }} 等待毫秒数与来源（诊断用）。
 */
function planDelay(settings, failure, round) {
  const local = backoffDelay(settings, round);
  const provider = failure?.providerRetryAfterMs;
  if (
    settings.respectProviderRetryAfter
    && typeof provider === 'number'
    && Number.isFinite(provider)
    && provider > 0
  ) {
    if (provider <= settings.maxDelayMs) return { delayMs: Math.round(provider), source: 'provider' };
    // 提供方要等的时间超过我们愿意等的最长间隔 ⇒ 退回本地曲线（但仍会重试）。
    return { delayMs: local, source: 'local(provider-over-max)' };
  }
  return { delayMs: local, source: 'local' };
}

/**
 * 挂载本插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - 行内配置（必须为空）。
 */
export function apply(ctx, config = {}) {
  validateConfig(config);

  // ── 持久预算投影：轮次计数跟随会话日志，重连不清零 ──────────────────────
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: backoffStateSchema,
    init: () => ({}),
    apply: (state, event) => {
      // 新的一步或轮次结束 = 上一段失败已经过去，预算归零。
      if (event.type === 'step/start' || event.type === 'turn/end') return {};
      if (event.type !== 'llm/retry-backoff') return state;
      const provider = event.data.provider;
      const entry = state[provider];
      if (entry?.round === event.data.round && entry.retryId === event.data.retryId) return state;
      return { ...state, [provider]: { round: event.data.round, retryId: event.data.retryId } };
    },
  });

  // ── 设置（可选服务，但要能"迟到激活"）─────────────────────────────────
  //
  // 为什么不用 `ctx.get('settings')`：它默认 strict=true，只返回**已激活**的服务；
  // 而 `apply` 跑在挂载期，设置提供方可能还没激活 ⇒ 拿到 undefined，命名空间
  // 永远不注册（症状：面板"只读"、保存返回 503，而日志里没有错误）。
  // 实测在同一个 profile 里，裸 Node 宿主是 undefined、完整 Electron 宿主是可用
  // —— 这正是"时序竞争"的典型表现，不能靠 strict=false 硬取（`_getImpl` 在服务
  // 尚未 provide 时依然返回 undefined）。
  //
  // 正确做法：用 `ctx.inject(['settings'], …)` 起一个**子插件**，它由 cordis 在
  // settings 就绪后才调用。于是"设置晚到"变成正常路径，而不是失败路径。
  let scope = null;
  const readSettings = () => sanitizeSettings(scope ? scope.get() : DEFAULTS);

  ctx.inject(['settings'], (settingsCtx) => {
    const settingsService = settingsCtx.get('settings');
    if (settingsService === undefined || typeof settingsService.register !== 'function') {
      settingsCtx.logger.warn('retry-backoff: settings service has no register(); panel stays read-only');
      return;
    }
    // register 是**挂 fiber 的效果**：卸载即移除命名空间与观察者。
    scope = settingsService.register(SETTINGS_NS, SettingsSchema, { applies: 'live' });
    scope.watch((next) => {
      const resolved = sanitizeSettings(next);
      settingsCtx.logger.info(
        'retry-backoff: settings updated (rounds=%d, base=%dms, x%s, cap=%dms, jitter=%s)',
        resolved.maxRounds,
        resolved.initialDelayMs,
        resolved.multiplier,
        resolved.maxDelayMs,
        resolved.jitterRatio,
      );
    });
  });

  const lifetime = new AbortController();
  const active = new Set();

  /** 跟踪进行中的委派恢复，释放时排空。 */
  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  /**
   * 执行一次退避：先写持久事件，再等待，再写"已开始"事件。
   */
  async function backoff(agent, turn, step, provider, failure, round, retryId, delayMs, source, signal) {
    const fused = AbortSignal.any([signal, lifetime.signal]);
    if (fused.aborted) return undefined;

    // 先持久、后等待：任何定时器启动之前，计划就已落到会话日志。
    agent.session.append('llm/retry-backoff', {
      retryId,
      turn,
      step,
      provider,
      round,
      maxRounds: readSettings().maxRounds,
      delayMs,
      delaySource: source,
      failure,
    });

    const waited = await cancellableDelay(delayMs, fused);
    if (!waited) return undefined;

    agent.session.append('llm/retry-backoff-started', { retryId, turn, step, round });
    return { kind: 'retry' };
  }

  /**
   * waterfall 监听器：先用自己的预算与曲线重试，耗尽后把决定权交回下游。
   */
  async function recover({ agent, turn, step, provider, failure, signal }, next) {
    const settings = readSettings();
    if (!isEligible(settings, failure)) return next();
    if (signal?.aborted || lifetime.signal.aborted) return undefined;

    const previous = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)[provider];
    const previousRound = previous?.round ?? 0;
    if (previousRound >= settings.maxRounds) {
      // 本插件预算耗尽 ⇒ 交回下游（官方策略照常生效），不是"直接失败"。
      return next();
    }

    const round = previousRound + 1;
    const retryId = previous?.retryId ?? crypto.randomUUID();
    const { delayMs, source } = planDelay(settings, failure, round);

    return backoff(agent, turn, step, provider, failure, round, retryId, delayMs, source, signal);
  }

  // 登记顺序 = waterfall 顺序：本监听器先跑，下游是官方 llm-retry。
  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next));
  });

  ctx.effect(() => async () => {
    disposeListener?.();
    lifetime.abort(new Error('retry-backoff plugin disposed'));
    await Promise.allSettled([...active]);
  }, 'retry-backoff: abort and drain active backoff waits');

  // ── HTTP 设置界面 ─────────────────────────────────────────────────────────
  //
  // 浏览器半边（网页端与桌面端共用同一个前端）通过这三条同源路由读写设置。
  // 走 HTTP 而不是只依赖内置设置界面，是因为需求要求"设置面板里可自定义"，
  // 而面板要同时服务网页端与桌面端 —— 同源路由是唯一在两种宿主里都成立的通路。
  //
  // `webServer` 是 inject 里的硬依赖，所以这里它必定已激活（见 inject 的注释：
  // 用 `ctx.get` 会在挂载期拿到 undefined 而静默丢路由）。
  const disposeRoutes = registerSettingsRoutes(ctx, ctx.webServer, { scope, readSettings });
  ctx.effect(() => () => disposeRoutes(), 'retry-backoff: unregister settings routes');
}

export { sanitizeSettings, backoffDelay };