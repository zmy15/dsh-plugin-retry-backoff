/**
 * settings-store.js — 本插件设置的**唯一持久化层**（宿主侧）。
 *
 * 为什么不再依赖 `ctx.settings`：
 *   · DSH 0.1.x 的 settings 服务提供 `register(namespace, schema)`，本插件曾用它把
 *     设置写进 `settings.yaml`；
 *   · DSH 0.2.x（当前桌面端 0.2.1-rc.2）把该服务改成了「profile 里插件 Config 的
 *     表单投影」——**没有 `register`**。继续等待它只会永远等到 `undefined`：
 *     `ctx.inject(['settings'])` 回调里 `register` 不存在，scope 永远为 null，
 *     面板按钮永久只读（这正是用户看到的"设置服务尚未就绪"）。
 *
 * 因此设置改为**插件自有 JSON 文件**（与 wallpaper-engine 同一模式）：
 *   · 与宿主版本无关：0.1.x / 0.2.x / 未来版本行为一致；
 *   · 与端口无关：桌面端每次重启换随机回环端口也不影响；
 *   · 写入原子（同目录 tmp + rename），并发写串行化，不会留下半截文件。
 *
 * 路径：`$DSH_HOME/retry-backoff/settings.json`（`DSH_HOME` 缺省为 `~/.dsh`）。
 * 可用 `DSH_RETRY_BACKOFF_SETTINGS` 覆盖（测试与高级用户用）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULTS, sanitizeSettings } from './settings-schema.js';

/**
 * 解析设置文件路径。
 * @returns {string} 绝对路径。
 */
export function resolveSettingsPath() {
  const override = process.env.DSH_RETRY_BACKOFF_SETTINGS?.trim();
  if (override) return override;
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, 'retry-backoff', 'settings.json');
}

/**
 * 创建设置存储。
 *
 * @param {object} [options] - 选项。
 * @param {string} [options.filePath] - 覆盖文件路径（缺省走 `resolveSettingsPath()`）。
 * @param {{ warn?: Function }} [options.logger] - 只用于"文件坏了/读不了"的告警。
 * @returns {{
 *   filePath: string,
 *   exists: () => boolean,
 *   get: () => object,
 *   save: (next: object) => Promise<object>,
 *   reset: () => Promise<object>,
 * }} 存储句柄。
 */
export function createSettingsStore({ filePath = resolveSettingsPath(), logger = null } = {}) {
  /** 写队列：并发 PUT 串行化，后写者不会基于旧快照吞掉先写者。 */
  let queue = Promise.resolve();
  /** 临时文件名序号（同一进程内不共用同一 tmp 路径）。 */
  let seq = 0;
  /** 坏文件的告警只打一次，避免每次重试都刷屏。 */
  let warnedCorrupt = false;

  /**
   * 读设置。每次都读盘 —— 用户手改文件、测试写文件都能立即生效；
   * 文件很小，且只在失败重试/面板请求时读，开销可忽略。
   * @returns {object} 已消毒设置；文件缺失或损坏时回落默认值。
   */
  function read() {
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return sanitizeSettings(DEFAULTS);
      logger?.warn?.('retry-backoff: cannot read settings file %s: %o', filePath, error);
      return sanitizeSettings(DEFAULTS);
    }

    try {
      const parsed = JSON.parse(text);
      warnedCorrupt = false;
      return sanitizeSettings(parsed);
    } catch {
      if (!warnedCorrupt) {
        warnedCorrupt = true;
        logger?.warn?.('retry-backoff: settings file %s is not valid JSON; using defaults', filePath);
      }
      return sanitizeSettings(DEFAULTS);
    }
  }

  /**
   * 原子写：同目录 tmp → rename。Windows 上 rename 覆盖目标由 libuv 的
   * MoveFileExW(REPLACE_EXISTING) 保证；跨设备等极端情形退回直接覆盖。
   * @param {object} settings - 已消毒设置。
   */
  function writeAtomic(settings) {
    mkdirSync(dirname(filePath), { recursive: true });
    seq += 1;
    const tmp = `${filePath}.${process.pid}.${seq}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    try {
      renameSync(tmp, filePath);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp 清理失败不掩盖原始错误。
      }
      throw error;
    }
  }

  /**
   * 把任务排进串行队列；前一个失败不阻塞后一个。
   * @param {() => unknown} task - 任务。
   * @returns {Promise<unknown>} 任务结果。
   */
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    filePath,
    exists: () => existsSync(filePath),
    get: read,
    /**
     * 保存完整设置快照（先消毒，再原子落盘）。
     * @param {object} next - 完整设置对象。
     * @returns {Promise<object>} 已写入的消毒后设置。
     */
    save(next) {
      const settings = sanitizeSettings(next);
      return enqueue(() => {
        writeAtomic(settings);
        return settings;
      });
    },
    /**
     * 恢复默认：删除用户设置文件（下次读即继承默认值）。
     * @returns {Promise<object>} 默认设置。
     */
    reset() {
      return enqueue(() => {
        try {
          unlinkSync(filePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        return sanitizeSettings(DEFAULTS);
      });
    },
  };
}
