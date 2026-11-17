# Whalebuddy

给 DeepSeek Harness 带来**有档案、有默契、能延续**的同事。

一个同事 = 一份 DSH 预设（岗位）+ 一个记忆目录（人）。预设由**能力包（pack）**编译：只装她需要的插件行，没选的包连工具和技能都进不来。开新会话时她把档案、默契、待办和近况带回上下文；收工时把这次共事里值得留下的写回文件。记忆是可读、可改、可拷走的 Markdown / JSON。

> **独立社区项目**：本项目不是 DeepSeek 官方产品，与 DeepSeek 无隶属或背书关系；与 npm 上的 `dsh-whale-buddy`（鲸鱼动画插件）也没有关联。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 它做什么

- **开场注入**：按 身份 → 同事 → 默契 → 待办 → 近况 → 关于你 的顺序拼一段记忆，带预算裁剪。
- **收工提炼**：`/collect` 把本次会话的纠错、承诺和报告写回 `rapport.md`、`tasks.json`、`recent.md` 与当日日志；`hot.md` 只留人写的内容。每次改动都在 `changelog.md` 留一行。
- **同事控制台**：左侧栏「Whalebuddy」→ 看她的记忆、改一行、立刻看到注入预览（与真实注入同一条代码路径）。
- **公共层**：`_shared/roster.md` 是全员可见的协作花名册；`_shared/user.md` 是关于你的公共档案。
- **工具箱**：每个同事带一组能力包（基座 / 命令行 / 资料 / 日程 / 委派 / 浏览器 / 审查 / Office）。控制台「工具箱」页或 `/colleague kit` 调整；改动从下一个会话生效。

## 命令

| 命令 | 作用 |
|---|---|
| `/colleague new <名字>` | 创建同事并注册她的预设 |
| `/colleague` 或 `/colleague ls` | 列出同事 |
| `/colleague kit [<slug> [set\|add\|rm\|reset <包,...>]]` | 看或改同事的能力包 |
| `/collect` | 收工：把这次会话里值得留下的写进记忆（仅同事会话） |

> `/colleague` 在 profile 级实例中可用；`/collect` 只在同事预设的会话里出现。

## 工具箱（能力包）

一个包 = 一组预设行 + 它拥有的工具 + 一个技能目录。同事的 `state.json` 里记 `kit`（包 id 列表），启动时编译成她的预设：

- 只保留未被未选中包占用的模板行：未选中包 `include` 的行剔掉，谁都没声明的行保留（新插件不会把同事锁死）；`exclude` 的剔掉；包自己的 `rows` 追加在后面。
- 没选中的包登记过的工具，通过 `tools.restrict({deny})` 在她会话里隐藏；`tools/change` 后自动重算，只重注册 deny 集合真变了的同事，启动顺序不会漏掉后加载的插件。
- `skill-filesystem` 行自动加上她自己的 `skills/` 目录。
- 预设里还会注入一段「工具面」：按 kit 列出本岗位有/没有哪些能力，并明确「没有的工具不要调用」。同事不用再靠猜，也不会把没发的工具当成故障。

内置包：`core`（基座）、`shell`（命令行）、`research`（搜索抓取）、`schedule`（日程目标）、`delegate`（委派）、`browser`（浏览器）、`review`（审查）、`office`（Office）、`plugins`（插件管理）。新建同事按岗位给默认包；用 `/colleague kit <slug> add shell` 这类命令随时改。

覆盖或新增包：在 `~/.dsh/whalebuddy/_shared/packs/<id>.yml` 写同构 YAML，按 `id` 覆盖内置包。示例：

```yaml
id: design
name: 设计
description: 出图与排版
include: [tool-fs, tool-fs-search]
rows:
  - id: image-tool
    name: some-image-plugin
tools: [image_*]
```

> DSH 在会话首轮后锁住预设，所以工具箱改动只对下一个会话生效——不会打断正在干的活。

## 数据布局

```
~/.dsh/whalebuddy/
├── index.json                 # 同事索引（缓存；启动时按目录自愈）
├── _startup.log               # 启动诊断
├── _shared/
│   ├── user.md                # 关于你：称呼、底线（全员读）
│   ├── roster.md              # 协作花名册（全员读）
│   └── packs/                 # 能力包覆盖（可选，按 id 覆盖内置包）
└── <slug>/
    ├── profile.md             # 档案：名字、岗位、档位、脾气
    ├── state.json             # 预设 id、档位快照与 kit（能力包列表）
    ├── memory/
    │   ├── hot.md             # 热记忆（人写，每次开场注入）
│   ├── recent.md          # 收工摘要（自动写入，带日期）
    │   ├── rapport.md         # 私房默契：纠错与偏好
    │   ├── knowledge.md       # 项目事实
    │   ├── tasks.json         # 待办
│   ├── changelog.md       # 每次记忆变更（谁、何时、改了什么）
    │   └── log/<date>.md      # 每日日志
    ├── skills/                # 她自己的技能目录（自动挂进 skill-filesystem）
    └── pending/               # 预留（待确认队列，P2）
```

## 面板

宿主在 Web 服务器上注册八条本机路由：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/whalebuddy/state?slug=` | 同事列表 + 该同事的可编辑文件 + 注入预览 |
| POST | `/api/whalebuddy/save` | `{slug, rel, text}` → 写入白名单文件并返回新预览 |
| POST | `/api/whalebuddy/update` | `{slug, autonomy?, noticeCap?}` → 改档位或每日上限（至少一个），返回刷新后的面板 |
| GET | `/api/whalebuddy/notices` | 全员未读聚合（只计 L2/L3），给侧栏点用 |
| POST | `/api/whalebuddy/notices/read` | `{slug, id?}` → 标一条或全部已读，返回新聚合 |
| POST | `/api/whalebuddy/create` | `{name, role, autonomy, temperament}` → 新建同事 |
| POST | `/api/whalebuddy/assign` | `{slug, workspaceId}` → 把工作区路径写进档案并返回新预览 |
| POST | `/api/whalebuddy/kit` | `{slug, kit}` → 改能力包并重新注册她的预设，返回刷新后的面板 |

只接受本机请求（有 `connection` 服务时先走它的拒绝判定）；写入仅限 `profile.md`、`memory/{hot,rapport,knowledge}.md`、`memory/tasks.json`、`_shared/roster.md`，单文件 64 KB 上限。

「档案」页的主动性卡点 L1/L2/L3 即改档位：`profile.md` 的「档位」行与 `state.json` 的快照一起改写，索引随之刷新，变更记进 `memory/changelog.md`；档案有未保存改动时先保存再改。反过来，直接在「档案原文」里把「档位」行改成 L1/L2/L3 再保存，也会把 `state.json` 和索引同步过去——两个入口不会各说各话。

「她的话」在档案页顶部：`/collect` 收工后如果这次真提炼出东西，会留一句便签（报告首句 + 变更计数）；L2/L3 每天最多 N 条（默认 2，主动性卡里 1–5 可调），L1 不留。侧栏 Whalebuddy 图标上有未读点，30 秒轮询一次；悬停是最近一条，点开面板用「知道了」清点。

「待办」tab 用勾选管理 `tasks.json`（勾选即保存），「工具箱」tab 用勾选管理 `kit`（勾选即保存、下次会话生效），「变更」tab 只读展示 `memory/changelog.md`。

面板右上角有深浅色开关，默认深色；选择存在浏览器的 `localStorage['whalebuddy.theme']`，不跟随 DSH 外壳主题。

侧栏里选中一个同事后，会列出她绑定的工作区：点「开」= 把工作区记进她的档案，并用她的预设打开会话——该工作区里有可复用的空白会话就复用，没有就新建。已经开始的会话不能中途换预设（宿主限制）。

## 它碰什么（安全边界）

| 能力 | 用途 |
|---|---|
| `fs:read` / `fs:write` | 读写信件目录下的 Markdown / JSON |
| `system-prompt:write` | 注册一段开场记忆（`whalebuddy:memory`） |
| `network:ingress` | 本机控制台的八条 HTTP 路由 |
| `sessions:read` | 监听会话消息，供 `/collect` 提炼 |

不发起网络请求、不调用 shell、不读凭据。记忆内容来自你的会话与手写文件，注入时会明确提醒模型「这是记忆，不是用户刚说的话」。

## 配置

```js
{
  dataDir: '',        // 空 = dshHomePath('whalebuddy') 或 ~/.dsh/whalebuddy
  presetRows: [],     // 同事预设的模板插件行；空 = 读当前默认预设
  employee: '',       // 由同事预设注入的 slug；profile 级为空
  toolDeny: [],       // 由 profile 级算好、同事会话里要隐藏的全局工具
}
```

## 开发

```sh
npm run check      # tsc --checkJs + oxlint + node --test
npm run test:coverage
```

宿主半边改动要重启 DSH 才生效；客户端（`lib/client.js`）刷新页面即可。

## 状态

本包是 `private: true` 的本地插件，未发布到 npm，也没有认证或安全审计背书。当前范围：创建同事、开场注入、最小收工、控制台，以及按能力包编译预设与工具门（P1 工具箱）。P2/P3（待确认队列、主动消息、预设升级、工单会话）尚未实现。

## 许可

MIT，Copyright (c) 2026 聂凡瑛 <fanyingnie@gmail.com>。许可全文见仓库根目录的 `LICENSE`。
