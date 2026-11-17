# 能力包（Capability Kits）设计

日期：2026-11-18
状态：已实现（P1 工具箱）
相关：[2026-11-09-whalebuddy-design.md](2026-11-09-whalebuddy-design.md)

## 问题

此前每个同事的预设 = 当前默认预设的全部插件行 + 记忆行。结果：

- 七个同事全带着同一套工具，与岗位无关；
- 改一次默认预设，所有同事跟着变；
- 技能目录与工具目录在全员的会话里重复付费。

## 平台事实（决定方案边界）

- 预设是 Cordis 组合（`config.plugins` 行列表，支持 group / isolate / disabled）。
- 会话首轮后预设锁定（`agent-preset/locked`），不能中途热插拔。
- 技能注册表按 scope 分层：全局 provider 先铺，预设层同名覆盖。
- `ctx.tools.restrict({ allow, deny })` 只在 agent scope 生效，按 scope 链求交；scope 内注册的工具不受影响。

## 方案

一个同事 = 记忆目录 + **kit（能力包 id 列表）**。kit 编译成她的预设：

1. 模板预设行只保留被选中包 `include` 的；`exclude` 剔除；包自己的 `rows` 追加。
2. 模板一行都没匹配上时退回整份模板（自定义预设安全网）。
3. 未选中包登记过的工具 → `deny`，由预设里的 whalebuddy 副本调用 `tools.restrict` 隐藏。
4. 没归过类的工具保持可见（fail-open），新装插件不会把同事锁死。
5. `skill-filesystem` 行自动追加 `~/.dsh/whalebuddy/<slug>/skills`。
6. 工具面注入：注册预设时用 kit 生成一段「有 / 没有」清单，随记忆段之后注入；没发的工具不再靠猜或硬调。

内置包：core / shell / research / schedule / delegate / browser / review / office / plugins。角色给默认 kit；`/colleague kit <slug> set|add|rm|reset` 与控制台「工具箱」页修改。

## 生命周期

- profile 级实例在 `agentPresets` 可用后按 kit 注册每个同事的预设，disposer 按 slug 保存。
- 改 kit：`store.setKit` → dispose 旧预设 → 重新编译注册。旧 revision 在已有会话用着时由注册表保留；新会话拿新 revision。
- 控制台路由 `POST /api/whalebuddy/kit` 与命令共用同一个写入函数。

## 失败与安全

- 包 YAML 损坏：跳过该文件并告警，其余包照常。
- 工具服务未就绪：`knownToolNames()` 为空 → 首次注册 deny 为空；`tools/change` 触发重算并只重注册 deny 集合变化的同事，启动顺序造成的漏项会收敛。
- 限制调用失败（未知工具）：整次 fail-open 并告警，不阻断会话。
- 不能移除 core；空 kit 被拒绝。

## 非目标（下一阶段）

- 会话中途换 kit（平台禁止；需要开新会话）。
- 按包裁剪全局技能目录（需要改 profile 的 skill-filesystem 政策或引入 skill gate；会写入长期配置，另议）。
- 工单会话（`/colleague open --kit`）：用任务预设开新会话，属于 P2。

## 验收

- `node --test` 全绿（含 packs / kit 端到端）。
- 真实 ops-ptc 模板下：美术/视频/资料 = core+research+browser（17 行），开发 = core+shell+research+review（17 行），审 = core+research+review（15 行），统筹 = core+shell+schedule+delegate+research（21 行）；满模板 23 行。
- 本机 7 位同事的 kit 已写入 state.json：蓝鲸 19 行、弓头 15、逆戟 15、一角 17、座头 18、抹香 15、小白 18。
- 控制台「工具箱」勾选后下一次新会话生效。
