# 同事的「她来找你」· 第一版设计（门缝便签）

- 日期：2026-11-14
- 状态：**已批准**（2026-11-14，追加「L2 每日上限可调」）
- 关联：[2026-11-09-whalebuddy-design.md](2026-11-09-whalebuddy-design.md) §6 主动性、[2026-11-14-whalebuddy-console-visual-design.md](2026-11-14-whalebuddy-console-visual-design.md)
- 视觉探索：[presence.html](../../../designs/presence-hint/presence.html)（designs/ 不进仓库）

## 1 意图

档位现在能调，但「她到底怎么找我」没有答案：L1/L2/L3 只是档案里的字，没有任何代码读它做事。这一版给「主动」一个最小、诚实、能验收的形态——**她收工后留一句便签，侧栏图标上留一个小点，点开能看到原话**。不做弹窗，不做假状态。L2 的「每天最多几条」不再是写死的 2，而是同事级可调。

## 2 目标 / 非目标 / 反目标

**目标**

1. 侧栏 Whalebuddy 图标右上出现 5px 陶土点：有未读便签才亮，一眼可见。
2. 悬停看得到最近一条：`小白：收工：待办 +2（18:42）`。
3. 面板「档案」页顶部有「她的话」：时间、正文、未读点、「知道了」；空态「今天还没找过你」。
4. 档位真的决定有没有：L1 不生成；L2/L3 每人每天最多 N 条——**N 默认 2，可在主动性卡里调 1–5**。
5. 便签来自真实动作：`/collect` 收工后写入，正文取自这次提炼的真实结果。

**非目标（这一版不做）**

- 不做行旁浮出气泡（宿主侧栏行只给 16px 图标和 label，没有气泡位；锚定浮层留作实验）。
- 不做到点提醒：`tasks.json` 的 Task 目前没有结构化到期日（只有 id/text/status/reminded），编一个 due 就是造假。
- 不做 L3 审批空心圈：审批队列还是 P2 的 `pending/`，没有真实数据可显示。
- 不做全局默认上限（只做同事级；全局设置等有多人诉求再说）。
- 不做后台定时唤起模型、不做自动弹窗。

**反目标**

- 造假：点、条数、时间全部来自 `notices.json` 与真实收工，算不出就不显示。
- 骚扰：上限再调也只有 1–5，默认仍是 2；不做「10 秒自动缩回、过会儿再来」的敲门。
- 黑箱：便签可读、可点开、可标已读；没有「她删掉了自己的话」。

## 3 约束（宿主侧栏给不了什么）

- 行由壳渲染：我们只拿到 `{size, active}` 画图标；`label()` 是普通字符串且不保证刷新；描述符没有 badge 字段。
- 因此点只能画在**我们自己的 SVG** 里（5px 圆，右上角，留 1px 内边距），文案提示靠 SVG `<title>` 与面板。
- 客户端仍是单文件、无构建、无依赖；只读状态用 DOM 轮询，不依赖壳的重渲染。

## 4 方案与取舍

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A 门缝便签（选中）** | 图标点 + SVG title + 面板「她的话」+「知道了」 | 安静、像同事留纸条；5px 点容易错过；内容要进面板才看全 |
| B 敲一下门 | 行尾浮出卡片，[看看][过会儿]，10 秒缩回 | 最像真人；但锚定位置无官方支持，DOM/焦点/遮挡风险最高，也最容易变成 Clippy |
| C 门口值班牌 | `label()` 加「· 会来找你」+ 今日次数/配额 | 最透明；但只是说明书，不会真来找；「下次」没有任何真实数据 |

选 A：它是唯一不依赖宿主改行、又能真正「她来找你」的闭环。B 留作 spike，C 的档位说明并进「主动性」卡，不单独做。

## 5 设计

### 5.1 数据

新文件 `<slug>/memory/notices.json`（人类可读，不进注入）：

```json
[
  {
    "id": "b1f0c2a4-…",
    "at": 1794600000000,
    "kind": "collect",
    "text": "把登录页的爬虫改完了。",
    "detail": "待办 +2、知识 +1",
    "readAt": 1794600300000
  }
]
```

- `text`：收工报告的第一句（≤80 字）；没有报告就用 `describeExtraction` 的结果（如「待办 +2」）。
- `detail`：变更计数，面板里做次行小字。
- `readAt`：缺省即未读；只由「知道了」写入。

`state.json` 增加 `noticeCap`（1–5 的整数，缺省 2），跟着同事走；`profile.md` 的固定模板不动（现有测试继续成立）。

### 5.2 生成（只在 /collect 里）

`createCollectCommand` 写完全部记忆、`appendChange` 之后，追加一条便签：

1. 读该同事档位（`store.list()` 的 summary）与上限（`state.json.noticeCap`，缺省 2）。L1 → 直接跳过。
2. 数今天的便签（本地日期），已到 N 条 → 跳过（不排队，不补发）。
3. `summary === ''`（这次没提炼出任何东西）→ 不写便签，避免空响。

不改 `distill.js`；便签失败只 `warn`，不能把收工判失败。

### 5.3 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/whalebuddy/notices` | 全员聚合：`{ unread, latest: {slug,name,text,at}, bySlug }`；只统计当前 L2/L3 的同事 |
| POST | `/api/whalebuddy/notices/read` | `{ slug, id? }`；给 id 标一条，省略 id 标该同事全部；返回新的聚合 |
| POST | `/api/whalebuddy/update` | 扩成 `{ slug, autonomy?, noticeCap? }`；至少给一个；cap 必须是 1–5 的整数 |

- 聚合只读，不产生副作用；轮询不会写盘。
- 校验沿用现有 400/404/405 风格；只接受本机请求。

### 5.4 侧栏

- 图标：现有字形右上叠 5px 圆点，`fill: var(--wb-clay)`；未读为 0 时 `display:none`。
- 客户端轮询：`apply()` 里启动一个 **不依赖 React hooks** 的 watcher——立即拉一次，此后 30s 一次，窗口重新可见时再拉；结果直接改图标 SVG 的 `data-unread` 与 `<title>` 文本。面板标已读后立即手动刷新一次。
- 标题：`Whalebuddy` / `小白：收工：待办 +2（18:42）`。
- 测试窗口没有 `setInterval`/DOM 时，watcher 不启动，插件照常注册。

### 5.5 面板

「档案」页顶部新增一张小卡「她的话」：

```
她的话                      今天 1 条 · 未读 1
  18:42  把登录页的爬虫改完了。        ●未读  [知道了]
         待办 +2、知识 +1
```

- 列出最近 5 条（跨天也显示，日期写成「昨天 18:42」）。
- 「知道了」调 read 接口，成功后立刻刷新图标点与卡片。
- 空态：「今天还没找过你。」下面一行灰字：「L2 收工后留一句，每天最多 N 条。」
- L1 时卡片照常显示，但空态文案改为「现在是 L1：随叫随到，她不会主动找你。」

**主动性卡里的上限控件**（L2/L3 时显示，L1 隐藏）：

```
主动性
[ L1 随叫随到 ] [ L2 会来找你 ] [ L3 自己找活 ]
每天最多 [−] 2 [+] 条
```

- 点 − / + 直接调 `update {slug, noticeCap}`，成功后用返回的面板刷新（与改档位同一条路径、同样的竞态保护）。
- 1–5 的边界：到 1 时 − 禁用，到 5 时 + 禁用；没有「保存」，点即生效。
- 空态/说明里出现的「N」读的是当前值，不写死。

### 5.6 档位

| 档 | 便签 | 点 | 上限 |
|---|---|---|---|
| L1 | 不生成 | 不显示 | 不适用（控件隐藏） |
| L2 | 收工后生成 | 有未读才亮 | N 条/天（默认 2，可调 1–5） |
| L3 | 同 L2（审批圈等 P2 审批队列） | 同 L2 | 同 L2，同一份 N |

### 5.7 实现落点

- `lib/notices.js`（新）：纯函数——解析、追加、按天计数、标已读、聚合、读/写 cap 的辅助；文件读写在 `store` 上。
- `lib/store.js`：新增 `setNoticeCap(slug, cap)`（只改 state.json，保留 presetId/autonomy），与 `setAutonomy` 共用状态读写。
- `lib/index.js`：`createCollectCommand` 里追加便签。
- `lib/host/panel-data.js`：`readColleague` 增加 `notices` 与 `noticeCap`；新增 `changeNoticeCap`。
- `lib/host/routes.js`：GET notices、POST notices/read；update 接受 noticeCap。
- `lib/client.js`：图标点 + watcher + 「她的话」卡片 + 上限步进器。

## 6 改动清单

| 文件 | 改动 |
|---|---|
| `dsh-whalebuddy/lib/notices.js` | 新增：notices 纯逻辑与聚合 |
| `dsh-whalebuddy/lib/store.js` | setNoticeCap + 读状态辅助 |
| `dsh-whalebuddy/lib/index.js` | /collect 成功后追加便签 |
| `dsh-whalebuddy/lib/host/panel-data.js` | readColleague 带 notices/noticeCap；changeNoticeCap |
| `dsh-whalebuddy/lib/host/routes.js` | notices 两条；update 扩参数 |
| `dsh-whalebuddy/lib/client.js` | 图标点、watcher、她的话卡片、上限步进器 |
| `dsh-whalebuddy/test/*` | notices/路由/客户端/收集 |
| `dsh-whalebuddy/README.md` | 路由表与「她的话」「上限」说明 |

## 7 测试

- notices：追加、N 条/天上限（N=1/3/5 各一例）、L1 不生成、空 summary 不生成、坏 JSON 当空、标已读、聚合跳过 L1。
- store：setNoticeCap 保留 presetId/autonomy；非法 cap 拒绝；缺省读取为 2。
- routes：聚合 200、标已读 200、未知 slug 404、坏体 400、cap 0/6/1.5 400、update 同时给 autonomy+cap、GET read 405。
- panel-data：readColleague 带 cap；changeNoticeCap 记 changelog 并返回面板。
- client：图标带点元素且默认隐藏；watcher 拉到未读后显示点与 title；「知道了」发 POST 并清点；步进器在 L2 显示、L1 隐藏、边界禁用、点击发 update。
- index：一次 /collect 后 notices.json 多一条；L1 时不多；N=1 时第二条被挡。

## 8 风险与留白

1. **壳可能重建图标**：watcher 每 30s 重设一次属性；最坏情况点晚 30s 出现。
2. **DOM 直接改属性**：只改自己 SVG 上的 `data-unread` 与 `<title>`，不碰壳的元素；测试里无 document 则跳过。
3. **多窗口**：多个窗口各自轮询、各自标已读；标已读是幂等写（同一 readAt 覆盖），可接受。
4. **上限调高到 5**：仍有硬上限，但比默认更吵；这是用户的显式选择，文案里会把当前 N 写出来。
5. **将来**：tasks 有结构化 due 后补「到点提醒」；审批队列上线后补 L3 空心圈；锚定气泡 spike 通过后补 hover 卡。
