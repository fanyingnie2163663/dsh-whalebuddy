# 同事花名册（公共协作层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个同事开场就拿到一张全员共享的职责表，知道有哪些同事、各自吃什么交什么、该找谁。

**Architecture:** 花名册是 `_shared/roster.md`，属于公共层（与 `memory/` 私有记忆物理分离）。`inject.js` 的 `assembleMemory` 新增一个「同事」段，位置在「身份」之后、「默契」之前，预算 700 字；`index.js` 读文件并传入，文件不存在则整段不渲染。

**Tech Stack:** Node 22 ESM，零运行时依赖（`yaml`、`schemastery` 已有），测试用 `node --test`。

**Spec:** `docs/superpowers/specs/2026-11-13-colleague-roster-design.md`

## Global Constraints

- 花名册只放职能与协议，**不放任何人的私有记忆内容**
- 花名册只写"吃什么/出什么/不管什么"，**不写模型名、插件名**（为跨模型留口子）
- 硬上限 700 字，超出按句子边界截断，复用 `truncateToBudget`
- 文件不存在时不渲染空标题
- 不 patch DSH 本体，只改插件内部

## Review Focus

- 花名册里混进私房默契（最可能发生，因为写的人是我）
- 空文件 / 只有标题的文件导致空段落
- 700 字上限在中文长句上截断到句子中间
- 同事的 `hot.md` 指向了不存在的位置
- 注入后总长度膨胀，挤掉「近况」

---

### Task 1: 注入层支持「同事」段

**Files:**
- Modify: `lib/inject.js`（typedef、DEFAULT_MEMORY_BUDGET、limits、sections）
- Test: `test/inject.test.js`

**Interfaces:**
- Consumes: `truncateToBudget(text, limit)`、`renderSection(title, body)`（同文件已有）
- Produces: `MemoryFiles.roster?: string`；`MemoryBudget.roster: number`（默认 700）；注入里多一段 `### 同事`

- [ ] **Step 1: 写失败测试** — 三条：段落在身份与默契之间；没有花名册不渲染标题；超预算在句号处截断
- [ ] **Step 2: 跑测试确认失败** — `node --test test/inject.test.js`
- [ ] **Step 3: 实现** — typedef 加 `roster`，预算加 `roster: 700`，`limits` 加一项，`sections` 在「身份」后插入 `renderSection('同事', …)`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

### Task 2: 宿主读取花名册并传入

**Files:**
- Modify: `lib/index.js:62-63`（新增常量）、`lib/index.js:272-282`（`readMemoryFiles`）

**Interfaces:**
- Consumes: `readMemoryText(store, slug, rel)`、`SHARED_SLUG`
- Produces: `readMemoryFiles()` 返回值多一个 `roster` 字段

- [ ] **Step 1: 加常量** `const SHARED_ROSTER_FILE = 'roster.md'`
- [ ] **Step 2: 加读取** `Promise.all` 里加 `readMemoryText(store, SHARED_SLUG, SHARED_ROSTER_FILE)`，解构并在 `return` 里带出
- [ ] **Step 3: 跑全量测试** — `npm test`
- [ ] **Step 4: 提交**

### Task 3: 花名册文件与指向

**Files:**
- Create: `~/.dsh/whalebuddy/_shared/roster.md`
- Modify: 三个同事的 `memory/hot.md`

- [ ] **Step 1: 写花名册** — 三段：`## 同事` / `## 怎么找` / `## 怎么交接`
- [ ] **Step 2: 三个 hot.md 各加一行** `你的职责与协作方式见 _shared/roster.md`
- [ ] **Step 3: 人工验收** — 起一个会话看注入里有没有「同事」段

### Task 4: 收尾

- [ ] **Step 1: `npm test` 全绿**
- [ ] **Step 2: 检查花名册里没有出现任何人的私房默契**
- [ ] **Step 3: 报告改动与测试结果**
