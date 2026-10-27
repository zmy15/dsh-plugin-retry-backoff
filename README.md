# dsh-plugin-retry-backoff

DSH 插件：**模型请求遇到 429 / 限流等"可通过重试解决"的失败时，按你在设置面板里
自定义的指数退避，延长重试轮次与等待时间，直到请求成功。**

同时支持**网页端**与**桌面端** —— 宿主半边负责重试，前端半边提供设置界面，
两侧共用同一份设置真源。

---

## 它解决什么问题

DSH 内置只对可重试失败做**有界**重试（默认最多 5 次、退避 0.5s→10s）。遇到
网关限流（429）持续几十秒到几分钟时，5 次用尽后整个轮次就以失败告终，你只能手动重发。

本插件**追加**一层由你掌控的退避预算：

- 轮次可调到 200 次；
- 首次等待、倍率、单轮上限、抖动全部可调；
- 面板里直接看到整条退避曲线的柱状图与累计最长等待；
- 轮次用尽后**交回 DSH 原生策略**（不会直接失败），所以"延长"是真延长，不是替换。

---

## 安装后的样子

设置界面里会多出一节「**重试退避**」（在官方设置面板的左侧导航里），包含：

| 控件 | 默认 | 说明 |
|---|---|---|
| 启用本插件 | 开 | 关闭 = 完全回到 DSH 原生行为 |
| 延长轮次 | 8 | 本插件最多追加多少次重试；0 = 不介入 |
| 首次等待 | 2000 ms | 第 1 轮退避时长；不会超过单轮上限 |
| 退避倍率 | 2 | 每轮等待 ×N；1 = 固定间隔 |
| 单轮上限 | 60000 ms | 任何一轮都不会等超过它；拉低时首次等待会一起跟到该值 |
| 抖动比例 | 0.2 | ±20% 随机，避免多会话同时重试撞在一起 |
| 尊重 Retry-After | 开 | 提供方给的等待（不超上限时）优先于本地曲线 |
| 重试哪些失败码 | 见下 | 默认限流 / 服务端 / 超时 / 传输四类 |

失败码默认集合刻意**不含** `AUTH` / `QUOTA` / `INVALID_REQUEST` / `CONTEXT` ——
这些重试解决不了，重试只会拿你的额度或时间去撞一堵不会开的墙。需要时可以手动勾上。

### 设置存在哪

设置保存在插件自己的文件里，**不依赖 DSH 的 settings 服务**（0.2.x 已移除插件注册
命名空间的接口）：

```
$DSH_HOME/retry-backoff/settings.json     # 缺省 ~/.dsh/retry-backoff/settings.json
```

- 写入是原子的（同目录 tmp + rename），并发保存会排队；
- 想手改或备份直接编辑这个 JSON 即可，下一次重试/面板请求就会读到；
- 可用 `DSH_RETRY_BACKOFF_SETTINGS` 指向别的文件（测试或便携场景）。

---

## 它怎么工作（实现要点）

### 挂在官方扩展点上，与官方策略**组合**而非竞争

Agent loop 在模型请求以失败分片终止时，跑一条 `agent/request-error` waterfall。
返回值是 `{ kind: 'retry' }` 就在**同一个打开的轮次内**重跑失败步骤。

官方 `@deepseek-ai/dsh-llm-retry` 监听同一座位，按各提供方路由的 `retryPolicy`
决策。本插件把自己登记在它**之前**（登记顺序即 waterfall 顺序）：

```
失败 → 本插件（用户自定义退避，自己的预算）
        ├─ 还有预算 → 等待 → 返回 retry
        └─ 预算耗尽 / 已禁用 / 码不在集合 → next() → 官方策略照常接管
```

这条分工是"**延长**"的字面语义：官方策略负责它那份，本插件负责追加你要求的这份。
禁用本插件 = 逐字节回到今天的行为。

### 三条不变量

1. **先持久、后等待** —— 每次计划的重试在任何定时器启动前就追加一条非 surface
   的会话事件（`llm/retry-backoff`），因此崩溃或取消不会留下不可见的待处理重试。
2. **可取消** —— 退避等待同时监听 loop 的 `signal` 与本插件的生命周期，
   取消立刻归还；插件卸载会中止等待并排空。
3. **预算持久** —— 轮次计数从会话日志（`llmRetryBackoff` 投影）读出，
   所以重连或恢复后不会把预算清零重来。`step/start` 与 `turn/end` 会重置预算。

---

## 目录结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半边：waterfall 监听器、退避决策、持久事件 |
| `lib/routes.js` | 宿主半边：设置 HTTP 路由（GET / PUT / reset） |
| `lib/settings-schema.js` | **设置唯一真源**：默认值、量程、消毒、退避公式（两侧共用） |
| `lib/settings-store.js` | 设置持久化：插件自有 JSON 文件，原子写 + 写队列串行化 |
| `lib/client.js` | 前端半边源码：官方 `settings.section` 座位上的设置面板 |
| `lib/client.bundle.js` | 前端产物（由构建脚本生成，勿手改） |
| `scripts/build-client.mjs` | 把前端源码包成 DSH 的 `__ModuleLoader__` 形态并内联共享 schema |
| `cordis.patch.yml` | bundle 层：往 profile 插件树插入一行宿主半边 |
| `test/` | 全部验证脚本（见下） |

---

## 构建与验证

首次克隆后先链接运行时依赖（不联网，只建链接）：

```bash
node scripts/link-deps.mjs      # 从已安装的 DSH profile 链接 schemastery / cordis / zod
```

日常：

```bash
node scripts/build-client.mjs   # 重新生成 lib/client.bundle.js（改前端后必须跑）
node test/all.mjs               # 跑完整套验证
```

`test/all.mjs` 依次跑七组：

1. **单元测试**（42 项）—— 退避公式（含封顶、抖动、深轮次不溢出）、设置消毒
   （越界回落默认而非夹边界）、每个重试分支（429 接住、轮次递增、预算耗尽交回
   下游、取消、禁用、提供方 Retry-After 的三种情形）、HTTP 路由（含 400/405/413/500）、
   **前端产物真实渲染**（递归执行组件，能抓到"导航有、点进去空白"那类渲染期异常）。
2. **端到端** —— 照抄真实 loop 语义跑"连续失败 4 次后成功"，断言退避按
   `100→200→400→800` 递增、每次先持久后开始、轮次结束预算重置，以及
   **运行中改设置下一次失败立即生效**。
3. **版本闸门判定** —— 钉死 semver 语义（prerelease 序、caret 上界）。这条防的是
   "插件装上了却被 DSH 整行跳过"。
4. **前端契约** —— 复刻 `dsh-client-modules` 的解析规则，断言 `dsh.client.platform`
   为 `web`、`exports["./client"]` 存在、产物真实存在且是可加载形态，并把每个
   peer 范围与**实际安装的运行时版本**逐个比对。
5. **profile 组合** —— 调用 DSH **自己的** `dsh-app-boot` 加载并组合 profile，
   断言本行真的进了最终的挂载列表，且官方 `llm-retry` 仍在树里。

---

## 仓库结构

```
dsh-plugin-retry-backoff/
├── lib/
│   ├── index.js              宿主半边：waterfall 监听、退避决策、持久事件
│   ├── routes.js             宿主半边：设置 HTTP 路由
│   ├── settings-schema.js    设置唯一真源（宿主与前端共用）
│   ├── settings-store.js     设置文件存储（原子写 / 串行化）
│   ├── client.js             前端半边源码：settings.section 座位上的面板
│   ├── client.bundle.js      前端产物（生成物，改 client.js 后重跑 build）
│   └── types/                类型声明
├── scripts/
│   ├── build-client.mjs      打包前端半边 + 内联共享 schema
│   └── link-deps.mjs         从已安装 profile 链接测试依赖
├── test/
│   ├── all.mjs               一次跑完全部验证
│   ├── run.mjs               单元测试
│   ├── verify-e2e.mjs        端到端重试循环
│   ├── verify-semver.mjs     版本闸门判定
│   ├── semver.mjs            极简 semver 实现（供契约检查）
│   ├── verify-client-contract.mjs  前端契约 + peer 版本比对
│   └── verify-profile.mjs    profile 组合验证
├── cordis.patch.yml          bundle 层：插入宿主半边
└── package.json
```

---

## 安装到 profile

插件按 bundle 渠道装载。两个 profile 都已登记：

```jsonc
// ~/.dsh/profiles/<name>/package.json
"dsh": { "profile": { "bundles": [ ..., "dsh-plugin-retry-backoff" ] } }
```

包本体放在 `<profile>/node_modules/dsh-plugin-retry-backoff`。

⚠️ **改完必须重启 DSH**：宿主半边是启动期挂载的 bundle 行，热重载不会把它带进来
（前端半边在刷新后才会重新注入）。

### 版本闸门（安装期最容易被静默卡住的一步）

DSH 启动时会校验插件的 `peerDependencies` 与本机运行时是否兼容，**不兼容就整行跳过**
（日志只有一行 `skipping profile bundle "…"`，前端完全看不到面板，而文件检查全绿）。

本插件最初就踩了这个坑：`peerDependencies` 写成 `^0.1.5-rc.1`，而 caret 在 semver 下
**不含 `0.2.x`**，于是运行时更新到 `0.2.1-rc.2` 后插件被整行丢弃。

现在的写法与官方/其他第三方插件一致 —— 用**开放下界**：

```jsonc
"engines":        { "dsh": ">=0.1.5-rc.1" },
"peerDependencies": { "@deepseek-ai/dsh-agent": ">=0.1.5-rc.1", ... }
```

`node test/verify-client-contract.mjs <包目录>` 会把每个 peer 范围与**实际安装的运行时
版本**逐个比对，`test/verify-semver.mjs` 则钉死 semver 语义（含 prerelease 序与 caret 上界），
让这类"装上了却不加载"在安装期就变成红字。

---

## 设置面板按钮点不动？

「保存 / 恢复默认」变灰（disabled）时，面板下方会给出原因。1.0.3 起设置存在插件自己的
文件里，正常情况下按钮始终可用；只有**宿主写不了那个文件**（目录权限等）才会只读：

- 点面板里的「**重新检测**」重读一次；
- 仍不行：查看宿主日志里的 `retry-backoff: settings write failed`，确认
  `$DSH_HOME/retry-backoff` 可写，然后重启 DSH。

> **历史修复**：
> - 1.0.1 在注册路由时快照了尚未就绪的 settings scope，两个按钮永久禁用；
> - 1.0.2 改为惰性读取 scope，但 DSH **0.2.x 的 settings 服务已没有 `register()`**
>   —— 桌面端因此仍永远等不到 scope；
> - 1.0.3 不再依赖 settings 服务，改为插件自有 JSON 文件（与 wallpaper-engine 同一模式），
>   网页端 / 桌面端 / 0.1.x / 0.2.x 行为一致。

---

## 已知限制

- **只覆盖 agent 轮次边界**。直接调 `ctx.llm.stream()` 的消费方仍是一次性尝试
  （原始流无法持久地区分已发出的分片）—— 与官方 `llm-retry` 同一约束。
- **每次重试都是一次真实请求**，会重复计费输入 token。轮次与上限调大前请确认
  自己的额度承受范围。
- **不判断"值不值得等"**：若你把 `AUTH` 之类加进集合，插件会忠于你的选择一直重试；
  默认集合刻意排除这些码就是为了避免这件事。
- 预算按 **provider** 分别计数；同一 provide 上的多个模型共用一份预算。

## License

MIT