# Whalebuddy

给 DeepSeek Harness 带来**有档案、有默契、能延续**的同事。

一个同事 = 一份 DSH 预设（岗位）+ 一个记忆目录（人）。开新会话时她把档案、默契、待办和近况带回上下文；收工时把这次共事里值得留下的写回文件。记忆是可读、可改、可拷走的 Markdown / JSON。

## 它做什么

- **开场注入**：按 身份 → 同事 → 默契 → 待办 → 近况 → 关于你 的顺序拼一段记忆，带预算裁剪。
- **收工提炼**：`/collect` 把本次会话的纠错、承诺和报告写回 `rapport.md`、`tasks.json`、`recent.md` 与当日日志；`hot.md` 只留人写的内容。每次改动都在 `changelog.md` 留一行。
- **同事控制台**：左侧栏「Whalebuddy」→ 看她的记忆、改一行、立刻看到注入预览（与真实注入同一条代码路径）。
- **公共层**：`_shared/roster.md` 是全员可见的协作花名册；`_shared/user.md` 是关于你的公共档案。

## 命令

| 命令 | 作用 |
|---|---|
| `/colleague new <名字>` | 创建同事并注册她的预设 |
| `/colleague` 或 `/colleague ls` | 列出同事 |
| `/collect` | 收工：把这次会话里值得留下的写进记忆（仅同事会话） |

> `/colleague` 在 profile 级实例中可用；`/collect` 只在同事预设的会话里出现。

## 数据布局

```
~/.dsh/whalebuddy/
├── index.json                 # 同事索引（缓存；启动时按目录自愈）
├── _startup.log               # 启动诊断
├── _shared/
│   ├── user.md                # 关于你：称呼、底线（全员读）
│   └── roster.md              # 协作花名册（全员读）
└── <slug>/
    ├── profile.md             # 档案：名字、岗位、档位、脾气
    ├── state.json             # 预设 id 与档位快照
    ├── memory/
    │   ├── hot.md             # 热记忆（人写，每次开场注入）
│   ├── recent.md          # 收工摘要（自动写入，带日期）
    │   ├── rapport.md         # 私房默契：纠错与偏好
    │   ├── knowledge.md       # 项目事实
    │   ├── tasks.json         # 待办
│   ├── changelog.md       # 每次记忆变更（谁、何时、改了什么）
    │   └── log/<date>.md      # 每日日志
    ├── skills/                # 预留
    └── pending/               # 预留（待确认队列，P2）
```

## 面板

宿主在 Web 服务器上注册三条本机路由：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/whalebuddy/state?slug=` | 同事列表 + 该同事的可编辑文件 + 注入预览 |
| POST | `/api/whalebuddy/save` | `{slug, rel, text}` → 写入白名单文件并返回新预览 |
| POST | `/api/whalebuddy/create` | `{name, role, autonomy, temperament}` → 新建同事 |

只接受本机请求（有 `connection` 服务时先走它的拒绝判定）；写入仅限 `profile.md`、`memory/{hot,rapport,knowledge}.md`、`memory/tasks.json`、`_shared/roster.md`，单文件 64 KB 上限。

「待办」tab 用勾选管理 `tasks.json`（勾选即保存），「变更」tab 只读展示 `memory/changelog.md`。

侧栏里选中一个同事后，会列出她绑定的工作区：点「开」= 把工作区记进她的档案，并用她的预设打开会话——该工作区里有可复用的空白会话就复用，没有就新建。已经开始的会话不能中途换预设（宿主限制）。

## 它碰什么（安全边界）

| 能力 | 用途 |
|---|---|
| `fs:read` / `fs:write` | 读写信件目录下的 Markdown / JSON |
| `system-prompt:write` | 注册一段开场记忆（`whalebuddy:memory`） |
| `network:ingress` | 本机控制台的三条 HTTP 路由 |
| `sessions:read` | 监听会话消息，供 `/collect` 提炼 |

不发起网络请求、不调用 shell、不读凭据。记忆内容来自你的会话与手写文件，注入时会明确提醒模型「这是记忆，不是用户刚说的话」。

## 配置

```js
{
  dataDir: '',        // 空 = dshHomePath('whalebuddy') 或 ~/.dsh/whalebuddy
  presetRows: [],     // 同事预设的模板插件行；空 = 读当前默认预设
  employee: '',       // 由同事预设注入的 slug；profile 级为空
}
```

## 开发

```sh
npm run check      # tsc --checkJs + oxlint + node --test
npm run test:coverage
```

宿主半边改动要重启 DSH 才生效；客户端（`lib/client.js`）刷新页面即可。

## 状态

本包是 `private: true` 的本地插件，未发布到 npm，也没有认证或安全审计背书。当前范围是 P1a：创建同事、开场注入、最小收工、控制台。P2/P3（待确认队列、变更历史、主动消息、预设升级）尚未实现。

## 许可

MIT，Copyright (c) 2026 聂凡瑛 <fanyingnie@gmail.com>。许可全文见仓库根目录的 `LICENSE`。
