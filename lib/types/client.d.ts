/**
 * dsh-plugin-retry-backoff — 浏览器半边类型。
 *
 * 产物是 `window.__ModuleLoader__.load({ id, factory })` 形态的自定义模块
 * （见 lib/client.bundle.js，由 scripts/build-client.mjs 生成）。
 */

import type { Context } from '@deepseek-ai/cordis';

/** 浏览器半边的必需依赖：官方座位服务。 */
export declare const inject: string[];

/**
 * 挂载设置面板到官方设置界面的 `settings.section` 座位。
 * @param ctx - 客户端上下文。
 */
export declare function apply(ctx: Context): void;