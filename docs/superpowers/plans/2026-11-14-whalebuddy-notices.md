# 她来找你（门缝便签）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收工后同事在侧栏图标上留一个点、在面板里留一句话；L2/L3 每天最多 N 条（N 默认 2，可调 1–5）。

**Architecture:** 新增纯逻辑模块 `lib/notices.js`；`/collect` 成功后写 `memory/notices.json`；宿主新增聚合/已读两条路由，`update` 扩一个 `noticeCap`；客户端在图标 SVG 里画点，用一个不依赖 React 的 30s 轮询刷新它，面板加「她的话」卡与上限步进器。

**Tech Stack:** Node 24、`node --test`、Cordis 插件（host + browser）、单文件无构建客户端、DSH `--dsw-*` 主题变量。

**Spec:** [docs/superpowers/specs/2026-11-14-whalebuddy-notices-design.md](../../specs/2026-11-14-whalebuddy-notices-design.md)

## Global Constraints

- 不新增依赖、不加构建步骤；客户端仍是一个 IIFE 文件。
- 便签只在 `/collect` 成功、且本次提炼非空时写；失败只 warn。
- L1 不生成便签；L2/L3 上限 N ∈ 1..5，缺省 2；同一份 N 两档共用。
- 只统计当前档位为 L2/L3 的同事；L1 的未读不点亮。
- 所有文件写入走 `store.write`（原子）；`notices.json` 坏掉当空数组，绝不抛进收工或路由。
- 路由保持现有风格：本机 guard、400/404/405、`cache-control: no-store`。
- 文案里出现的「N」必须是当前值，不写死。

## Review Focus

1. `notices.json` 缺失/损坏/不是数组 → 当作空，收工与面板都不报错。
2. `state.json` 缺失/损坏 → 档位回退 profile、上限回退 2，不中断。
3. 同一天第 N+1 次收工 → 记忆照写、便签不写、不排队。
4. 切到 L1 后未读点隐藏；切回 L2 时未读仍在（不丢）。
5. 测试/无 DOM 环境 → watcher 不启动，图标仍渲染，apply 不抛。
6. 两个窗口同时标已读 → 幂等写，不互相覆盖成未读。

---

### Task 1: 便签纯逻辑

**Files:**
- Create: `dsh-whalebuddy/lib/notices.js`
- Test: `dsh-whalebuddy/test/notices.test.js`

**Interfaces:**
- Produces:
  ```js
  NOTICE_FILE = 'memory/notices.json'
  DEFAULT_NOTICE_CAP = 2
  parseNotices(text) => Notice[]
  isNoticeCap(value) => boolean          // Number.isInteger && 1..5
  noticeCapFromState(text) => number     // 坏/缺省 => 2
  todayCount(notices, now) => number     // 本地日期
  collectNotice(extraction, summary, at, id) => Notice | null
  appendWithinCap(notices, notice, cap, at) => Notice[] | null
  markRead(notices, id | undefined, at) => Notice[]
  aggregateNotices(entries) => { unread, latest, bySlug }
  ```
  `Notice = { id: string, at: number, kind: 'collect', text: string, detail: string, readAt?: number }`

- [ ] **Step 1: 写失败测试**（`test/notices.test.js`）

  - `parseNotices('{not json')` → `[]`；`parseNotices(JSON.stringify({}))` → `[]`；
  - `isNoticeCap(0|6|1.5|'2')` 全 false，`isNoticeCap(1|2|5)` true；
  - `noticeCapFromState('{ "autonomy": "L2" }')` → 2；`'{"noticeCap":4}'` → 4；
  - `collectNotice({ report: '改完了。还有尾巴。' }, '待办 +1', 1000, 'x')` → text === '改完了。'、detail === '待办 +1'；
  - 空 extraction + 空 summary → null；
  - `appendWithinCap`：今天已有 N 条返回 null，否则返回追加后的数组；跨天的旧便签不计数；
  - `markRead(list, 'id', 2000)` 只改那一条；不传 id 全部标已读；
  - `aggregateNotices([{slug:'a',name:'A',autonomy:'L2',notices:[未读]},{slug:'b',name:'B',autonomy:'L1',notices:[未读]}])` → unread 1、latest 来自 a、bySlug 里没有 b。

- [ ] **Step 2: 跑测试确认失败** — `cd dsh-whalebuddy && node --test test/notices.test.js`，期望 module not found。
- [ ] **Step 3: 实现 `lib/notices.js`** — 纯函数，无 I/O、无时钟（`now` 作参数）；`collectNotice` 取 report 第一句（`/[。！？\n]/u` 切，trim，≤80 字），否则用 summary。
- [ ] **Step 4: 跑测试确认通过** — 同命令，期望 PASS。
- [ ] **Step 5: 提交** — `git add lib/notices.js test/notices.test.js && git commit -m "feat(whalebuddy): notices 纯逻辑"`。

### Task 2: state.json 里的上限

**Files:**
- Modify: `dsh-whalebuddy/lib/store.js`
- Test: `dsh-whalebuddy/test/store.test.js`

**Interfaces:**
- Produces: `store.setNoticeCap(slug: string, cap: number) => Promise<void>`（非法 cap 抛 TypeError；缺同事抛 Error；保留 state 里其它键）。
- Consumes: Task 1 的 `isNoticeCap`。

- [ ] **Step 1: 失败测试** — create 后 `setNoticeCap(slug, 4)`：state.json = {presetId, autonomy, noticeCap:4}；`setAutonomy` 后 cap 仍在；`setNoticeCap(slug, 0|6|1.5)` 拒绝且文件不变；`setNoticeCap('ghost', 2)` 拒绝。
- [ ] **Step 2: 跑失败** — `node --test test/store.test.js`。
- [ ] **Step 3: 实现** — 复用 `setAutonomy` 的读状态/写原子路径；只写 state.json，不动 profile/index。
- [ ] **Step 4: 跑通过**。
- [ ] **Step 5: 提交** — `feat(whalebuddy): 同事级便签上限`。

### Task 3: 面板数据与三条路由

**Files:**
- Modify: `dsh-whalebuddy/lib/host/panel-data.js`、`dsh-whalebuddy/lib/host/routes.js`
- Test: `dsh-whalebuddy/test/panel-data.test.js`、`dsh-whalebuddy/test/routes.test.js`、`dsh-whalebuddy/test/console-mount.test.js`

**Interfaces:**
- Produces:
  - `readColleague(...)` 额外返回 `notices: Notice[]`、`noticeCap: number`；
  - `changeNoticeCap(store, slug, cap) => {noticeCap, ...panelState}`，changelog 记 `上限 → N 条/天`；
  - `ROUTES.notices = '/api/whalebuddy/notices'`（GET，聚合）、`ROUTES.noticesRead = '/api/whalebuddy/notices/read'`（POST）；
  - `update` 收 `{slug, autonomy?, noticeCap?}`，至少一个；cap 非 1..5 整数 → 400。
- Consumes: Task 1 的 `parseNotices/noticeCapFromState/aggregateNotices/markRead/isNoticeCap`；Task 2 的 `setNoticeCap`。

- [ ] **Step 1: 失败测试**
  - panel-data：seed 后写一条 notices.json，`readColleague` 的 `notices[0].text` 对得上，`noticeCap` 缺省 2；`changeNoticeCap(store, slug, 3)` 后 panel 的 cap=3、changelog 含「上限 → 3」。
  - routes：GET notices 聚合（L1 同事不计）；POST read `{slug}` 全读；`{slug,id}` 单读；未知 slug 404；坏 JSON 400；GET read 405；update `{slug, noticeCap:0}` 400、`{slug}` 400（至少要一个）、`{slug, noticeCap:5}` 200 且响应带 `noticeCap:5`。
  - console-mount：路由数 5 → 7。
- [ ] **Step 2: 跑失败**。
- [ ] **Step 3: 实现** — panel-data 读 `memory/notices.json` 与 `state.json`；路由按现有 guard/readJsonObject 风格；聚合只读、不写盘。
- [ ] **Step 4: 跑通过**。
- [ ] **Step 5: 提交** — `feat(whalebuddy): 便签路由与上限调整`。

### Task 4: 收工写便签

**Files:**
- Modify: `dsh-whalebuddy/lib/index.js`
- Test: `dsh-whalebuddy/test/collect.test.js`

**Interfaces:**
- Consumes: `collectNotice/appendWithinCap/noticeCapFromState/parseNotices`、`store.read/write`、`store.list`。
- Produces: 无新导出；`createCollectCommand` 选项新增 `warn?: (message: string) => void`。

- [ ] **Step 1: 失败测试** — 直接构造 `createCollectCommand`：一次带 report 的 transcript → `memory/notices.json` 多一条、text 是 report 首句；同一天第二次在 N=1 时不再增加；L1 时不增加；空 extraction 不增加。
- [ ] **Step 2: 跑失败**。
- [ ] **Step 3: 实现** — 在 `appendChange` 之后、`refresh` 前后均可；整体 try/catch → `warn`；`update` 失败不影响收工结果。
- [ ] **Step 4: 跑通过**。
- [ ] **Step 5: 提交** — `feat(whalebuddy): 收工后留一张便签`。

### Task 5: 侧栏点与轮询

**Files:**
- Modify: `dsh-whalebuddy/lib/client.js`
- Test: `dsh-whalebuddy/test/client-bundle.test.js`

**Interfaces:**
- 图标新增：`<circle class="wb-iconDot" data-wb-dot ...>`（默认 hidden，CSS 在 `[data-unread="1"]` 时显示）+ `<title>`；
- watcher：apply 里创建，30s 一次 + 立即一次 + `visibilitychange` 时一次；无 `document`/timers 时不启动；`stop()` 进 disposers；面板标已读后 `refresh()`。

- [ ] **Step 1: 失败测试** — 图标含 `data-wb-dot` 且默认隐藏；传入假 document/timers 与返回未读的 fake fetch，tick 后点元素 `data-on` 变化、`<title>` 含同事名与时间；`stop()` 后不再 fetch。
- [ ] **Step 2: 跑失败**。
- [ ] **Step 3: 实现** — 只改自己 SVG 的属性；`querySelector('[data-wb-dot]')` 找不到就静默。
- [ ] **Step 4: 跑通过**。
- [ ] **Step 5: 提交** — `feat(whalebuddy): 侧栏未读点`。

### Task 6: 她的话卡片与上限步进器

**Files:**
- Modify: `dsh-whalebuddy/lib/client.js`
- Test: `dsh-whalebuddy/test/client-bundle.test.js`

**Interfaces:**
- Consumes: `state.colleague.notices`、`state.colleague.noticeCap`、`api.markRead`、`api.update({slug, noticeCap})`。
- Produces: `data-dsh-part="colleague-notices"` 卡片；`wb-capMinus`/`wb-capPlus` 按钮；`wb-noticeRead` 按钮。

- [ ] **Step 1: 失败测试** — 有未读时卡片出现时间/正文/「知道了」，点击发 `POST api/whalebuddy/notices/read`；空态文案两套（L2/L1）；L2 显示步进器、L1 隐藏；1 时 − 禁用、5 时 + 禁用；点 + 发 `update {slug, noticeCap:3}`。
- [ ] **Step 2: 跑失败**。
- [ ] **Step 3: 实现** — 卡片放 `profilePane` 顶部；步进器复用改档位的 busy/竞态保护；提示里的 N 用当前值。
- [ ] **Step 4: 跑通过**。
- [ ] **Step 5: 提交** — `feat(whalebuddy): 她的话与可调上限`。

### Task 7: 收尾

- [ ] README：路由表 5 → 7、面板段落补「她的话 / 上限」；设计文档状态改「已实现」。
- [ ] `npm run check` 全绿。
- [ ] 真实数据验证：跑一次 `/collect`（或临时造一条 notices.json）→ 侧栏点、面板条、标已读、上限 1/3 的行为。
- [ ] 提交 `docs(whalebuddy): 她来找你 v1 收尾`。
