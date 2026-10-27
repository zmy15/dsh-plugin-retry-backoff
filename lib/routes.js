/**
 * routes.js — 本插件的 **HTTP 设置界面**（宿主侧）。
 *
 * 为什么走 HTTP 而不是只依赖 DSH 内置设置界面：需求要求设置能在**面板里**自定义，
 * 而这个面板必须同时服务**网页端**（浏览器打开 `http://127.0.0.1:<port>`）与
 * **桌面端**（Electron 壳内嵌同一份前端）。同源 HTTP 路由是唯一在两种宿主形态里
 * 都成立的通路 —— 浏览器半边不必知道自己是跑在壳里还是浏览器里。
 *
 * 路由（都在 BASE 前缀下，与插件同源）：
 *   GET  <BASE>/settings  → { settings, defaults, limits, codes, version, runtime }
 *   PUT  <BASE>/settings  → 写入（经 sanitize；无 settings 服务时返回 503）
 *   POST <BASE>/reset     → 恢复默认值
 *
 * 不变量：
 *   · 读取永远返回**消毒后**的值 ⇒ 前端拿到的量与宿主真正拿去算退避的量同源。
 *   · 写入路径先 sanitize 再落盘：脏值不会进 `settings.yaml`。
 *   · 请求体有**上限**，超限即 413 并断开（不无限收体）。
 */

import {
  DEFAULTS,
  LIMITS,
  RETRYABLE_CODE_CHOICES,
  SETTINGS_VERSION,
  backoffCurve,
  sanitizeSettings,
} from './settings-schema.js';

/** 本插件 HTTP 面的前缀（与 `dsh.client` 里前端取的路径同源）。 */
export const BASE = '/retry-backoff';

/** 设置体上限：这是一份小 JSON 对象，16KB 远超正常值。 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * 手动收体（带上限），避免 `express.json()` 依赖与无界缓冲。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<{ ok: boolean, value?: unknown, tooLarge?: boolean }>} 解析结果。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ ok: false });
      }
    });
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * 发一份 JSON 应答。
 * @param {import('node:http').ServerResponse} res - 应答。
 * @param {number} code - 状态码。
 * @param {unknown} payload - JSON 载荷。
 */
function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

/**
 * 组装 GET 应答的完整载荷（面板据此渲染，无需再猜任何量）。
 * @param {object} deps - 依赖。
 * @returns {object} JSON 载荷。
 */
function settingsPayload(deps) {
  const settings = deps.readSettings();
  return {
    settings,
    defaults: sanitizeSettings(DEFAULTS),
    limits: LIMITS,
    codes: RETRYABLE_CODE_CHOICES,
    version: SETTINGS_VERSION,
    // 预览曲线：面板展示"第 1…N 轮各等多久"，与宿主真正用的是同一条公式。
    curve: backoffCurve(settings, settings.maxRounds),
    // 运行时可观测事实：设置是否真的能写（没有 settings 服务时只能读默认值）。
    runtime: {
      writable: deps.scope !== null,
      namespace: 'retry-backoff',
    },
  };
}

/**
 * 注册本插件的设置路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} webServer - `ctx.webServer`。
 * @param {{ scope: object|null, readSettings: () => object }} deps - 设置读/写依赖。
 * @returns {() => void} 一次性注销全部路由。
 */
export function registerSettingsRoutes(ctx, webServer, deps) {
  const disposers = [];

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/settings`,
    handler: async (req, res) => {
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET') {
        sendJson(res, 200, settingsPayload(deps));
        return;
      }
      if (method !== 'PUT') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, PUT');
        res.end('method not allowed');
        return;
      }
      if (deps.scope === null) {
        sendJson(res, 503, { error: 'settings service unavailable; cannot persist' });
        return;
      }

      const body = await readJsonBody(req);
      if (body.tooLarge) {
        sendJson(res, 413, { error: 'settings body too large' });
        return;
      }
      if (!body.ok) {
        sendJson(res, 400, { error: 'malformed JSON body' });
        return;
      }

      const next = sanitizeSettings(body.value);
      try {
        // replace 而不是 update：面板每次都提交**完整**设置对象，
        // 而 update 是合并语义 —— 用户把一个键改回默认值时，
        // 合并会留下旧值（"改了没生效"那一类 bug）。完整快照必须整段替换。
        await deps.scope.replace(stripVersion(next));
        sendJson(res, 200, settingsPayload(deps));
      } catch (error) {
        ctx.logger.warn('retry-backoff: settings write rejected: %o', error);
        sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/reset`,
    handler: async (req, res) => {
      const method = (req.method ?? 'POST').toUpperCase();
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end('method not allowed');
        return;
      }
      if (deps.scope === null) {
        sendJson(res, 200, settingsPayload(deps));
        return;
      }
      try {
        // replace({}) 让每个键重新继承 schema 默认值（= 完整重置）。
        await deps.scope.replace({});
        sendJson(res, 200, settingsPayload(deps));
      } catch (error) {
        ctx.logger.warn('retry-backoff: settings reset rejected: %o', error);
        sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    },
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 注销失败不该影响卸载流程本身。
      }
    }
  };
}

/**
 * 去掉不该由用户层携带的键（形状版本由代码盖）。
 * @param {object} settings - 已消毒设置。
 * @returns {object} 可写入用户层的副本。
 */
function stripVersion(settings) {
  const { settingsVersion: _ignored, ...rest } = settings;
  return rest;
}