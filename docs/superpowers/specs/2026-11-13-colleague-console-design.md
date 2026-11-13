# 同事控制台（UI）· 设计

- 日期：2026-11-13
- 状态：**待批准**（v2：入口改为左侧栏标签页）
- 决策：方案 B（能看能改）；A 否决，C 缓
- 相关：[2026-11-13-colleague-roster-design.md](2026-11-13-colleague-roster-design.md)

## 1 意图

现在测试同事，要么改 `~/.dsh/whalebuddy/` 下的文件，要么让我跑 node 脚本；改完还得重启。老板的原话：**"每次都要重新打代码"**。

要一个面板，把"看她的记忆 → 改一行 → 看注入变成什么样"变成一个动作。

## 2 目标 / 非目标 / 反目标

**目标**
1. 设置页里一页：左列同事、中间编辑、右侧注入预览。
2. 保存即落盘，预览跟着变——**不重启**。
3. 新建同事、改岗位、编花名册，全在面板里。

**非目标**
- 不做"以她的身份开会话"（方案 C）。
- 不做右栏在场状态/忙碌指示（P3 的事）。
- 不做多设备、不同步、不远程。

**反目标**（做到也算失败）
- 面板变成第二套真理：一切仍以磁盘文件为准，面板只是读写它。
- 面板能写坏文件：路径白名单 + 长度上限，非白名单一律拒绝。
- 注入预览和真实注入不一致：预览必须调**同一个** `assembleMemory`。

## 3 约束

- 客户端通过 **`dsh-better-sidebar` 暴露的 tab 服务**注册「同事」标签页（左侧栏），面板内容就长在那个栏里；host 走 `ctx.inject(['webServer'])` 注册路由。
- 不 patch DSH 本体，只在插件里加。
- 只监听 127.0.0.1（护栏：现有 webServer 就是本机）。

## 4 方案

| | 做法 | 取舍 |
|---|---|---|
| A 只读 | 列表 + 全文 + 预览，不写 | 治不了一半："看得见但还得改文件" |
| **B 看+改（选中）** | A + 编辑保存 + 新建 | 工作量约两倍；测试闭环 |
| C +开会话 | 面板里起会话看表现 | 要动 agents API，风险最高，这一版不需要 |

## 5 设计

### 5.1 界面（左侧栏「同事」标签页，三栏）

```
┌ 同事 ────────┬ 档案 / 热记忆 / 默契 / 知识 / 花名册 ┬ 她开场收到什么
│ ● 逆戟 视频   │                                      │ ### 身份
│ ● 一角 美术   │  # 逆戟                              │ ...
│ ● 小白 日常   │  - 岗位：视频                        │ ### 同事
│ + 新建        │  - 档位：L2                          │ - 逆戟 · 视频…
│               │  [保存] 已保存 · 128 字              │ ### 默契
```

- 左栏：同事列表（名字 + 岗位），底部"新建"。
- 中栏：五个 tab，一个文本框，底部保存按钮 + "已保存/失败"。
- 右栏：只读预览，等宽字体，保存后立刻重算。

### 5.2 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/whalebuddy/state?slug=` | 同事列表 + 该同事的五个文件 + roster 全文 |
| POST | `/whalebuddy/save` | `{slug, rel, text}` → 写入并返回新的注入预览 |
| POST | `/whalebuddy/update` | `{slug, autonomy}` → 改档位，写 profile.md 与 state.json，返回刷新后的面板 |
| POST | `/whalebuddy/assign` | `{slug, workspaceId}` → 把工作区路径写进档案并返回新预览 |
| POST | `/whalebuddy/create` | `{name, role, autonomy, temperament}` → 建人 |

档位不是一次性选择：档案页的主动性卡点 L1/L2/L3 即调，走 `update` 路由；`profile.md` 的「档位」行与 `state.json` 的快照同时改写，索引随之刷新（`store.setAutonomy`），变更记进 changelog。反过来，保存「档案原文」时若「档位」行变了，`saveFile` 也会把快照与索引对齐，两个入口不会各说各话。

`rel` 白名单：`profile.md`、`memory/hot.md`、`memory/rapport.md`、`memory/knowledge.md`、`memory/tasks.json`、`_shared/roster.md`（`_shared` 用固定 slug）。
路径校验复用 `store.employeeFile`（它已经挡了 `..` 和 `/`）。超长：单文件 64 KB 上限。

### 5.3 注入预览

服务端调 `assembleMemory({profile, rapport, knowledge, hot, tasks, shared, roster})` —— 和线上注入**同一条代码路径**。这是整个设计的核心保证：面板里看到的就是她真会收到的。

### 5.4 保存后的刷新

POST 返回 `{saved: true, preview: '<新注入>'}`，客户端直接替换右栏。不轮询、不重启、不 reload 页面。

## 6 改动清单

| 文件 | 改动 |
|---|---|
| `lib/host/panel-data.js` | 新建：读五文件 + roster、组装 state、调 `assembleMemory` 出预览 |
| `lib/host/routes.js` | 新建：三个路由 + 白名单校验 |
| `lib/index.js` | `ctx.inject(['webServer'])` 注册路由 |
| `lib/client.js` | 换成真客户端：三栏 + 编辑 + 保存 |
| `lib/client.css` | 有则加，没有就内联 style |
| `test/host-panel.test.js` | 新建：白名单、超长、预览一致、创建 |

## 7 验收

- [ ] 设置页出现「同事」一节，列出三个同事
- [ ] 点「逆戟」，中栏显示她的档案；右栏显示注入原文
- [ ] 改一行 hot.md → 保存 → 右栏立刻出现那行
- [ ] 试图写 `../../x` 被拒（403）
- [ ] 试图写 100 KB 被拒（413 或 400）
- [ ] 新建一个同事，左栏立刻出现
- [ ] `npm test` 全绿

## 8 留给实现者 / 风险

- ~~入口 API 没读到~~ **已解决**，签名确认如下（`lib/types/client/service.d.ts`）：服务发布为 `ctx.betterSidebar`，消费方在 `inject` 声明后调 `registerTab(descriptor)`（和 `registerFileViewer`），返回 disposer，cordis 在 fiber 销毁时自动调用（HMR 安全）。descriptor 支持 `dedupeKey`（单实例/按路径/按 id）、`createTab`、`badge`。
- 三栏在窄窗口会挤。第一版可以退成两栏（列表 + 编辑，预览折叠）。
- 保存策略：先用"整体覆盖写"，不做 diff/冲突检测——单人使用，够。

---

## 9 v3 · 已确认的 API 与进度（2026-11-13）

三个 API 全部拿到，来源是 `@linxin666/dsh-client-ui-skill-explorer` 与 `dsh-claude-style` 的**未压缩部分**：

- **左侧栏格子**：`ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name:"sidebar.panellist", id, order, label }, Icon))`
- **点开的页面**：`ctx.slots.inject("main", () => ctx.slots.register({ name:"main", key: id, inject: () => ({...}) }, Page))`
- **宿主路由**：`ctx.inject(['webServer'], (scope) => scope.webServer.register({ kind:'prefix', path:'/whalebuddy', handler:(req,res)=>… }))`，返回 disposer
- **守卫**：`ctx.get('connection')?.requestRejection(req)`，没有就自检 `req.socket.remoteAddress` + `Host`

**已落地**：`lib/host/panel-data.js` —— 读同事、拼注入预览（调同一个 `assembleMemory`）、白名单写入、保存后回传新预览。`test/panel-data.test.js` 8 个用例全绿。

**未定**：客户端 React 从哪来。几个插件的 client 都是压缩 bundle，DSH 本体在 `app.asar`（沙箱不跟随）。下一步用运行中的 GUI 实测 `globalThis.React` / `__ModuleLoader__` 的契约，再写 `lib/client.js`。

## 10 v4 · 官方路线（最重要的一条）

读了 <https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md> 和 `dsh-plugin-guide/docs/recipes.md`：

- **客户端插件必须是构建产物**：`exports["./client"]` 指向 built file；源码是 TSX，组件作为第二个参数传给 `ctx.slots.register(key, Component)`。**手写 client.js 不是一条路**——这就是为什么所有插件客户端都是压缩 bundle。
- 共享模块（React 等）走 `dsh.client.external` 的模块表。
- 官方工具链 `dsh-primer`（Apache-2.0、零依赖、无 install 脚本）：`new` 脚手架（tsdown + vitest + cordis.patch.yml）/ `check` / `verify` / `seams`。
- 本机 `npx dsh-primer@0.4.5 --help` 可用；**`seams` 子命令在安装路径含空格时会挂**（内部调用未给路径加引号）。

**下一步**：用 `dsh-primer new` 拿 tsdown 构建配置，搬进 `dsh-whalebuddy`，写 `src/client.tsx`，构建出 `lib/client.js`，再 `ctx.slots.inject('sidebar.panellist' | 'main', …)` 注册。宿主半边（`lib/host/panel-data.js`，8 测试全绿）已就绪。

---

## 11 v5 · 已实现（2026-11-13，新上下文续做）

**结论先说**：面板的宿主半边、浏览器半边、测试和挂载点全部落地，`npm run check`（tsc --checkJs + oxlint + 110 个测试）全绿。**剩下只有一步：重启 DSH 后刷新页面**——宿主代码在进程内，不重启不会生效。

### 11.1 为什么没用 `dsh-primer new`

`npx dsh-primer@0.4.5` 在这台机器上仍然挂（`--version` 都返回 126，和 `seams` 同一个「路径含空格」的原因），所以拿不到 tsdown 脚手架。改成读**已装插件里未压缩的产物**，把 loader 契约直接确认下来：

- `dsh-posterflow-ai` 的 `dsh.client` 只有 `platform: "web"`（没有 inject 列表），说明 inject 列表可省；
- 它的 client 是 `window.__ModuleLoader__.load({ id, factory(require) { return { name, inject, apply } } })`，React 由 `require('react')` 给；
- `@linxin666/dsh-client-ui-skill-explorer` 的 source map 带 `sourcesContent`，`native-panel.tsx` 就是 `slots.inject` 的完整用法。

结论：**不引构建链**。`lib/client.js` 直接手写成 loader 产物（ES2020 + `React.createElement`，无 JSX、零依赖）。省掉 tsdown/rolldown 一整套 devDependency，也不用再处理一次「装依赖/跑生命周期脚本」。代价是页面组件用 `h()` 而不是 JSX，读完一遍不算难。

### 11.2 落地清单

| 文件 | 内容 |
|---|---|
| `lib/host/routes.js` | 三个路由 + 护栏：`GET /api/whalebuddy/state`、`POST …/save`、`POST …/create`；fence 先走 `ctx.get('connection').requestRejection`，没有就回退 loopback；body 256 KB 上限、单文件 64 KB、405/403/404/413 分明 |
| `lib/index.js` | profile 级 `apply` 里 `ctx.inject(['webServer'], scope => scope.effect(…register…))`，随插件卸载释放；`onCreate` 复用 `/colleague new` 的预设注册回调 |
| `lib/client.js` | 真客户端：左侧栏「同事」行（`sidebar.panellist`, order 40）+ keyed `main` 页；三栏（同事列表 / 五 tab 编辑器 / 注入预览）；新建同事表单；切人时未保存会确认 |
| `test/routes.test.js` | 16 个用例，真 `node:http` 上跑：状态、按 slug 取、保存回新预览、403 白名单、413 超长、404 未知 slug、405、坏 JSON、新建落盘 + 预设回调、护栏 |
| `test/client-bundle.test.js` | 7 个用例，`node:vm` 里以 `window.__ModuleLoader__.load` 载入真实产物：id、inject、两个 slot 描述符、图标尺寸、首屏取数、保存 POST 后预览更新、无 slots 服务时不抛 |
| `test/console-mount.test.js` | 3 个用例：profile 级 apply 挂上三条路由、卸载时全部释放、同事级实例不挂 |

### 11.3 复用的既有保证

- 预览仍然调**同一个** `assembleMemory`（`panel-data.js`），所以「面板里看到的 = 她开场收到的」这条核心保证没变。
- 写入仍然只走 `WRITABLE` 白名单 + `store.employeeFile`，并在路由层多挡一道「slug 必须是已存在的同事」，避免写路径顺手建目录。

### 11.4 验收怎么做

1. 重启 DSH（宿主进程要重新 import `lib/index.js`），刷新 Web GUI。
2. 左侧栏应多出「同事」一行；点开是页面（不是浮层），三栏。
3. 点「逆戟」→ 中栏显示档案 → 右栏显示注入原文。
4. 改热记忆一行 → 保存 → 右栏立刻出现那一行，不刷新页面。
5. 底部「＋ 新建同事」→ 建完左栏立刻多一行。
6. 想证明护栏还在：DevTools 里 `fetch('api/whalebuddy/save', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({slug:'逆戟', rel:'../../x', text:'y'})})` 应回 403。

### 11.5 仍未做 / 已知取舍

- 保存是整文件覆盖，没有 diff/冲突检测（单人使用，够）。
- 三栏在窄窗口会挤；还没做两栏退化。
- 没有「以她身份开会话」（方案 C），没有右栏在场状态（P3）。
- 客户端没有 TSX 类型；`lib/client.js` 由 `tsc --checkJs` 兜底（`jsconfig` 走 `tsconfig.check.json`）。

---

## 12 v5.1 · 图标重画与插件清理（2026-11-13 晚）

- 侧栏「同事」图标换成**两个同事**：前一个完整、后一个从右侧探出半个头。24 网格、线宽 2（16px 下约 1.33px），只用 `currentColor`，跟随明暗主题。旧的小鲸鱼在 16px 只剩一团墨点，第一次实测没认出来，所以放弃鲸鱼、改用「人」的通用语义。
- `dsh-posterflow-ai`（侧栏「开启生图模式」那条）**已从 profile 彻底卸载**：`package.json`、`pnpm-lock.yaml`、`node_modules/` 三处都没有了；它的 bundle 行此前已经禁用，所以重启后不会再回来。
- 生效方式：客户端产物（图标）刷新页面即生效，必要时 Ctrl+Shift+R；宿主路由（面板数据）仍需重启 DSH 进程。这台机器上客户端模块是页面加载时从磁盘读的，所以不重启也能换图标——实测见 `_startup.log`（最近一次进程启动仍是 15:46）。
- 效果图：[assets/colleague-icon.png](assets/colleague-icon.png)。

---

## 13 v5.2 · 产品名定回 Whalebuddy（2026-11-13 晚）

产品名不是「同事」，是 **Whalebuddy**。改的是品牌面：

- 侧栏行 label、页面 `<h2>`、`locale/zh.json` + `locale/en.json` 的 `meta.title`、`package.json` 的 `description`（插件卡片/市场里显示的也是这条）。

「同事」保留为**实体**称呼，不跟着改：列表里的人、花名册节 `### 同事`、`/colleague` 命令及其文案、各种「还没有同事」的空态。也就是说：产品叫 Whalebuddy，里面装着你的同事。

图标继续用两人版。同一天又试了实心鲸鱼（尾部 + 喷水 + 眼睛两版），64px 像那么回事，**16px 仍是一团**；两人剪影在 16px 能认出来，配上 Whalebuddy 这个名字读作「两个 buddies」也成立。
