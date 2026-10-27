/**
 * dsh-plugin-retry-backoff — 宿主半边类型。
 *
 * @module dsh-plugin-retry-backoff
 */

import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

/** 插件名（cordis 行 id 同源）。 */
export declare const name: 'retry-backoff';

/** 必需服务依赖。 */
export declare const inject: string[];

/** 本插件的设置命名空间。 */
export declare const SETTINGS_NS: 'retry-backoff';

/** 行内配置 schema（必须为空；全部可调项在用户设置里）。 */
export declare const Config: z<Record<string, never>>;

/** 用户设置值。 */
export interface RetryBackoffSettings {
  /** 总开关；关闭 = 完全回到 DSH 原生重试行为。 */
  enabled: boolean;
  /** 本插件最多追加的重试轮次；0 = 不介入。 */
  maxRounds: number;
  /** 首次退避基数（毫秒）。 */
  initialDelayMs: number;
  /** 退避倍率；1 = 固定间隔。 */
  multiplier: number;
  /** 单轮退避上限（毫秒）。 */
  maxDelayMs: number;
  /** 对称抖动比例（0–1）。 */
  jitterRatio: number;
  /** 触发本插件重试的失败码集合。 */
  retryableCodes: string[];
  /** 是否在提供方 Retry-After 不超上限时优先采用它。 */
  respectProviderRetryAfter: boolean;
  /** 设置形状版本。 */
  settingsVersion: number;
}

/** 设置命名空间 schema。 */
export declare const SettingsSchema: z<RetryBackoffSettings>;

/**
 * 挂载本插件：在 `agent/request-error` waterfall 上按用户设置做有界指数退避重试。
 * @param ctx - 插件上下文。
 * @param config - 行内配置（必须为空）。
 */
export declare function apply(ctx: Context, config?: Record<string, never>): void;

/** 把任意输入整理成合法设置。 */
export declare function sanitizeSettings(input: unknown): RetryBackoffSettings;

/** 计算第 `round` 轮的退避毫秒数。 */
export declare function backoffDelay(
  settings: RetryBackoffSettings,
  round: number,
  random?: () => number,
): number;