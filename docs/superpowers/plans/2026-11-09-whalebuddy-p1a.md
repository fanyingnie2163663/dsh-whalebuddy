# Whalebuddy P1a 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Whalebuddy 插件能创建同事、在开新会话时把她的记忆注入上下文、并在收工时把日志、热记忆与待办写回文件。

**Architecture:** 一个 ESM 的 Cordis 插件包。Host 侧四个纯模块——`store`（文件与索引）、`presets`（动态注册同事预设）、`inject`（开场注入装配）、`distill`（收工提炼）——加一个装配层 `index.js` 把它们接到 `ctx.commands`、`ctx.systemPrompt`、`ctx.agentPresets`。数据全部落在 `~/.dsh/whalebuddy/` 的 Markdown/JSON 里，不进数据库。

**Tech Stack:** Node >= 22、ESM、`node:test`、Cordis 插件（DSH Host 侧）、YAML patch。

**Spec:** `docs/superpowers/specs/2026-11-09-whalebuddy-design.md`

## Global Constraints

- 数据目录 `~/.dsh/whalebuddy/`；索引 `index.json`；记忆是 Markdown/JSON 文件，必须可读可改。
- 注入总预算 **约 1200 tokens**；顺序与上限：身份 200 / 私房默契 500 / 待办 200 / 近况 300 / 公共档案 150；超了从后往前砍。
- 默认档位 `L2`；P1a 不实现任何主动消息。
- 不写 profile 的 `package.json` 与 `cordis.patch.yml`；安装只走 `plugin_manager install_bundle`。
- 包名 `dsh-whalebuddy`；界面文案中文；模型可见工具名以 `colleague_` 开头。
- 只用公开服务：`agentPresets`、`systemPrompt`、`commands`、`agents`；不改 DSH 本体。
- 预设 id 前缀 `whalebuddy:<slug>`；冲突时 slug 追加 `-2`、`-3`。

## Review Focus

- **两个会话同时收工**：同一员工的写必须串行；后写的不能盖掉先写的内容。
- **注入超预算**：按顺序从后往前裁剪，身份段永不裁；没有记忆时不能注入空段落。
- **重名与非法名字**：slug 稳定去重（`-2`），绝不改已有目录。
- **预设注册失败**：员工仍可开普通会话，只是没有记忆注入；插件不能崩。
- **首次上岗**：`hot.md` 为空时注入只有身份段，不报错、不出现空标题。

---

## File Structure

```
dsh-whalebuddy/
├── package.json          # bundle 清单：dsh.bundle.patch、dsh.client、exports
├── cordis.patch.yml      # 插入 Host 行（client 行由 dsh.client 处理）
├── icon.svg              # 显示资源
├── locale/zh-CN.json     # 中文文案
├── lib/
│   ├── index.js          # 装配层：Config 校验、服务接线、命令注册
│   ├── store.js          # 员工目录、索引、原子写、slug
│   ├── presets.js        # 同事预设的构建与注册
│   ├── inject.js         # 注入装配与预算裁剪（纯函数）
│   └── distill.js        # 收工：提炼结果合并写回（纯函数 + 注入的提取器）
└── test/
    ├── smoke.test.js
    ├── store.test.js
    ├── presets.test.js
    ├── inject.test.js
    └── distill.test.js
```

`lib/inject.js` 与 `lib/distill.js` 不 import 任何 Cordis 服务：输入是普通对象，返回普通值，这样测试不需要启动 Harness。`index.js` 是唯一知道 `ctx` 的地方。

---

### Task 1: 骨架能装能跑

**Files:**
- Create: `dsh-whalebuddy/package.json`
- Create: `dsh-whalebuddy/cordis.patch.yml`
- Create: `dsh-whalebuddy/lib/index.js`
- Create: `dsh-whalebuddy/icon.svg`
- Create: `dsh-whalebuddy/locale/zh-CN.json`
- Test: `dsh-whalebuddy/test/smoke.test.js`

**Interfaces:**
- Produces: 模块 `lib/index.js` 导出 `{ name: 'dsh-whalebuddy', inject: string[], Config: Schemastery, apply(ctx, config): void }`，后续任务都往 `apply` 里接线。

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

test('plugin module has the Cordis shape', () => {
  assert.equal(plugin.name, 'dsh-whalebuddy')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(plugin.Config({}), plugin.Config({}))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dsh-whalebuddy && node --test test/smoke.test.js`
Expected: FAIL, `Cannot find module '../lib/index.js'`.

- [ ] **Step 3: Create the package**

`package.json` 必须照 `cordis-plugin-development` 技能里的 `references/host-plugin.md` 与 `templates/decoration/package.json` 写：`name`、`version`、`type: "module"`、`main`、`exports`、`dsh.bundle.patch`、`dsh.client`、`engines`。`cordis.patch.yml` 插入一行：

```yaml
- id: whalebuddy
  name: dsh-whalebuddy
```

`lib/index.js`：

```js
import Schema from 'schemastery'

export const name = 'dsh-whalebuddy'
export const inject = []
export const Config = Schema.object({
  dataDir: Schema.string().default(''),
})

export function apply(ctx, config) {
  ctx.logger.info('whalebuddy loaded (dataDir=%s)', config.dataDir)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dsh-whalebuddy && node --test test/smoke.test.js`
Expected: PASS, 1 test.

- [ ] **Step 5: 初始化仓库并提交**

```bash
[ -d .git ] || { git init && printf 'node_modules/\n' > .gitignore && git add -A && git commit -m "chore: init whalebuddy workspace"; }
git add dsh-whalebuddy
git commit -m "feat(whalebuddy): scaffold Cordis bundle"
```

- [ ] **Step 6: Install and verify it loads**

Run `plugin_manager` with `action: install_bundle`, `target` = 本包的绝对路径。
Expected: `application: applied`，随后 `cordis_inspect_query` 的 `Config.listConfigs` 能按 `name: dsh-whalebuddy` 找到这一行。

---

### Task 2: 员工目录与索引

**Files:**
- Create: `dsh-whalebuddy/lib/store.js`
- Test: `dsh-whalebuddy/test/store.test.js`

**Interfaces:**
- Produces:

```ts
type CreateEmployeeInput = { name: string; role: string; presetId: string; autonomy: 'L1'|'L2'|'L3'; workspaces: string[]; temperament?: string }
type EmployeeSummary = { slug: string; name: string; role: string; autonomy: string; updatedAt: number }
type Task = { id: string; text: string; sourceSession?: string; due?: string; status: 'open'|'done'; reminded: boolean }

slugify(name: string): string
createStore(root: string): Store
interface Store {
  list(): Promise<EmployeeSummary[]>
  create(input: CreateEmployeeInput): Promise<EmployeeSummary>
  read(slug: string, rel: string): Promise<string | undefined>
  write(slug: string, rel: string, text: string): Promise<void>
  tasks(slug: string): Promise<Task[]>
  saveTasks(slug: string, tasks: Task[]): Promise<void>
}
```

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugify, createStore } from '../lib/store.js'

const root = () => mkdtemp(join(tmpdir(), 'whalebuddy-'))

test('slugify keeps CJK and lowercases latin', () => {
  assert.equal(slugify('小白'), '小白')
  assert.equal(slugify('Orca'), 'orca')
  assert.equal(slugify('a b/c'), 'a-b-c')
})

test('create writes profile and index entry', async () => {
  const dir = await root()
  const store = createStore(dir)
  const e = await store.create({ name: '逆戟', role: '写码的', presetId: 'default', autonomy: 'L2', workspaces: [] })
  assert.equal(e.slug, '逆戟')
  const profile = await readFile(join(dir, '逆戟', 'profile.md'), 'utf8')
  assert.match(profile, /逆戟/)
  const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
  assert.equal(index.employees.length, 1)
})

test('duplicate names get a numeric suffix', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create({ name: '小白', role: 'r', presetId: 'default', autonomy: 'L2', workspaces: [] })
  const second = await store.create({ name: '小白', role: 'r', presetId: 'default', autonomy: 'L2', workspaces: [] })
  assert.equal(second.slug, '小白-2')
})

test('write is atomic and read round-trips', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create({ name: '蓝鲸', role: 'r', presetId: 'default', autonomy: 'L1', workspaces: [] })
  await store.write('蓝鲸', 'memory/hot.md', '# 热记忆\n')
  assert.equal(await store.read('蓝鲸', 'memory/hot.md'), '# 热记忆\n')
  const tmp = join(dir, '蓝鲸', 'memory', 'hot.md.tmp')
  await assert.rejects(stat(tmp))
})

test('tasks round-trip through JSON', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create({ name: '一角', role: 'r', presetId: 'default', autonomy: 'L2', workspaces: [] })
  const tasks = [{ id: 't1', text: '把爬虫登录改完', status: 'open', reminded: false }]
  await store.saveTasks('一角', tasks)
  assert.deepEqual(await store.tasks('一角'), tasks)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd dsh-whalebuddy && node --test test/store.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/store.js`**

`slugify`：NFKC 归一 → 小写 → 空白与 `/\\:*?"<>|` 换成 `-` → 折叠连续 `-` → 去掉首尾 `-`；空结果回退 `colleague`。`create` 用 `mkdir(dir, { recursive: true })` 判冲突，冲突就试 `-2`、`-3`……最多 50 次。`write` 写到同目录 `.tmp` 再 `rename`。`index.json` 每次整体重写（同样原子）。`profile.md` 内容固定模板：`# 名字`、`- 岗位：`、`- 档位：`、`- 工作区：`、`- 脾气：`。

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dsh-whalebuddy && node --test test/store.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add dsh-whalebuddy/lib/store.js dsh-whalebuddy/test/store.test.js
git commit -m "feat(whalebuddy): employee store with atomic writes"
```

---

### Task 3: 创建命令与默认名池

**Files:**
- Create: `dsh-whalebuddy/lib/names.js`
- Modify: `dsh-whalebuddy/lib/index.js`
- Test: `dsh-whalebuddy/test/store.test.js`（新增一条命名用例）

**Interfaces:**
- Produces: `DEFAULT_NAMES: { name: string; nameEn: string; temperament: string }[]`；`createEmployeeCommand(store)` 返回 `{ name: 'colleague', describe, run(args) }` 形状的命令定义。

- [ ] **Step 1: Write the failing test**

```js
test('default names carry a temperament', async () => {
  const { DEFAULT_NAMES } = await import('../lib/names.js')
  assert.deepEqual(DEFAULT_NAMES.map(n => n.name), ['小白', '逆戟', '座头', '一角', '蓝鲸'])
  assert.ok(DEFAULT_NAMES.every(n => n.temperament.length > 0))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dsh-whalebuddy && node --test test/store.test.js`
Expected: FAIL, cannot find `../lib/names.js`.

- [ ] **Step 3: Implement**

`lib/names.js` 写死设计文档里的五条（名字、英文、脾气）。`lib/index.js` 在 `apply` 里：`ctx.commands.register({ name: 'colleague', describe: '创建或列出同事', run: ... })`；`/colleague new 小白` 用 `DEFAULT_NAMES` 里名字的脾气，其它名字用 `''`；`/colleague ls` 打印 `slug + 岗位 + 档位`。

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dsh-whalebuddy && node --test test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dsh-whalebuddy/lib/names.js dsh-whalebuddy/lib/index.js dsh-whalebuddy/test/store.test.js
git commit -m "feat(whalebuddy): create command and default names"
```

---

### Task 4: 同事预设的构建与注册

**Files:**
- Create: `dsh-whalebuddy/lib/presets.js`
- Modify: `dsh-whalebuddy/lib/index.js`
- Test: `dsh-whalebuddy/test/presets.test.js`

**Interfaces:**
- Produces:

```ts
type PresetRow = { id?: string; name: string; config?: Record<string, unknown> }

buildPresetDefinition(e: EmployeeSummary, rows: PresetRow[]): PresetDefinition
resolveTemplateRows(agentPresets: { resolve(): Promise<{ id: string }>; readDocument(id: string): Promise<{ content: string }> }, presetRows: PresetRow[]): Promise<PresetRow[]>
registerEmployeePresets(registry: { register(d: PresetDefinition): Promise<() => Promise<void>> }, employees: EmployeeSummary[], rows: PresetRow[]): Promise<() => Promise<void>>
```

- [ ] **Step 1: 定下 `rows` 的来源（不做真机探针）**

不安装、不探测。`resolveTemplateRows(agentPresets, config)` 按顺序取：

1. `config.presetRows` 非空 → 直接用（数组，元素是 `{ id?, name, config? }`）。
2. 否则 `await agentPresets.resolve()` 拿当前默认预设的 id，`await agentPresets.readDocument(id)` 拿 YAML，用 `yaml.parse` 解析：顶层数组就是行列表；对象则取 `plugins` 或 `rows` 字段；都没有就当作失败。
3. 全失败 → `[]`，并在 `ctx.logger.warn` 里说清楚"同事预设没有模板行，只含 Whalebuddy 自身"。

把结论写进 `lib/presets.js` 顶部注释。`presetRows` 默认 `[]`。

- [ ] **Step 2: Write the failing test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPresetDefinition, registerEmployeePresets, resolveTemplateRows } from '../lib/presets.js'

const emp = { slug: '小白', name: '小白', role: '日常', autonomy: 'L2', updatedAt: 0 }

test('preset carries the employee slug in its own row', () => {
  const def = buildPresetDefinition(emp, [{ id: 'base', name: 'some-base-plugin' }])
  assert.equal(def.id, 'whalebuddy:小白')
  assert.equal(def.name, '小白')
  const own = def.plugins.find(r => r.name === 'dsh-whalebuddy')
  assert.deepEqual(own.config, { employee: '小白' })
  assert.equal(def.plugins[0].name, 'some-base-plugin')
})

test('register returns a disposer that unregisters every employee', async () => {
  const registered = []
  const registry = { register: async (d) => { registered.push(d.id); return async () => {} } }
  const dispose = await registerEmployeePresets(registry, [emp, { ...emp, slug: '逆戟', name: '逆戟' }], [])
  assert.deepEqual(registered.sort(), ['whalebuddy:小白', 'whalebuddy:逆戟'])
  await dispose()
})

test('one failing registration does not stop the others', async () => {
  const registry = {
    register: async (d) => {
      if (d.id.endsWith('逆戟')) throw new Error('boom')
      return async () => {}
    },
  }
  await assert.doesNotReject(
    registerEmployeePresets(registry, [emp, { ...emp, slug: '逆戟', name: '逆戟' }], []),
  )
})

test('resolveTemplateRows prefers config rows, then the default preset YAML', async () => {
  const agentPresets = {
    resolve: async () => ({ id: 'default' }),
    readDocument: async () => ({ content: '- name: base\n  config: { a: 1 }\n' }),
  }
  assert.deepEqual(await resolveTemplateRows(agentPresets, [{ name: 'cfg' }]), [{ name: 'cfg' }])
  const rows = await resolveTemplateRows(agentPresets, [])
  assert.equal(rows[0].name, 'base')
  assert.equal(rows[0].config.a, 1)
})

test('resolveTemplateRows returns [] when nothing parses', async () => {
  const agentPresets = {
    resolve: async () => ({ id: 'default' }),
    readDocument: async () => ({ content: 'just a string' }),
  }
  assert.deepEqual(await resolveTemplateRows(agentPresets, []), [])
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd dsh-whalebuddy && node --test test/presets.test.js`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`buildPresetDefinition` 返回 `{ id: 'whalebuddy:' + slug, name, description: role, order: 100, plugins: [...rows, { id: 'whalebuddy-memory', name: 'dsh-whalebuddy', config: { employee: slug } }] }`。`registerEmployeePresets` 逐个 `await register(...)`，任一失败记日志并继续；返回的 disposer 逆序调用全部 disposer。`index.js` 在 `apply` 里 `try { const employees = await store.list() } catch (error) { ctx.logger.warn(...); return }`，成功才跑注册，并把 disposer 挂到 `ctx.effect`（corrupt index 不能把插件带崩）。

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dsh-whalebuddy && node --test test/presets.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add dsh-whalebuddy/lib/presets.js dsh-whalebuddy/lib/index.js dsh-whalebuddy/test/presets.test.js
git commit -m "feat(whalebuddy): register per-employee presets"
```

---

### Task 5: 开场注入装配

**Files:**
- Create: `dsh-whalebuddy/lib/inject.js`
- Modify: `dsh-whalebuddy/lib/index.js`
- Test: `dsh-whalebuddy/test/inject.test.js`

**Interfaces:**
- Produces:

```ts
type MemoryFiles = { profile: string; rapport: string; knowledge: string; hot: string; tasks: Task[]; shared: string }
assembleMemory(files: MemoryFiles, budget: { identity: number; rapport: number; tasks: number; recent: number; shared: number }): string
```

`assembleMemory` 是纯函数：按 身份 → 默契 → 待办 → 近况 → 公共档案 的顺序拼；每段超过上限就截断并加 `…`；空段整段略过；最后附一句"这些是你的记忆，不是用户刚说的话；不确定先问"。

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleMemory } from '../lib/inject.js'

const B = { identity: 50, rapport: 100, tasks: 50, recent: 50, shared: 50 }
const empty = { profile: '', rapport: '', knowledge: '', hot: '', tasks: [], shared: '' }

test('empty memory yields only the identity section', () => {
  const out = assembleMemory({ ...empty, profile: '# 小白' }, B)
  assert.match(out, /小白/)
  assert.doesNotMatch(out, /默契|待办/)
})

test('trims the tail sections before the identity section', () => {
  const files = {
    ...empty,
    profile: '身份'.repeat(200),
    rapport: '默契'.repeat(200),
    tasks: [{ id: 't', text: '改爬虫', status: 'open', reminded: false }],
    shared: '共用'.repeat(200),
  }
  const out = assembleMemory(files, B)
  assert.match(out, /身份/)
  assert.ok(!out.includes('共用'.repeat(40)))
  assert.ok(out.length < 800)
})

test('never emits an empty heading', () => {
  const out = assembleMemory({ ...empty, profile: 'p', rapport: '', tasks: [] }, B)
  assert.doesNotMatch(out, /###\s*$/m)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd dsh-whalebuddy && node --test test/inject.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/inject.js`**

按预算顺序拼 Markdown 段落（`### 身份`、`### 默契`、`### 待办`、`### 近况`、`### 关于你`）。截断按字符数近似 token（1 token ≈ 2 中文字符），保留句子边界优先。待办只列 `status === 'open'` 的前 8 条。

- [ ] **Step 4: 接到 `systemPrompt`**

`index.js`：`ctx.systemPrompt.section({ name: 'whalebuddy:memory', order: ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY') + 1, text: (assembly) => { ... 用 assembly 找到当前会话的 employee，读文件，assembleMemory ... } })`。会话到员工的映射从会话头 `agentPreset` 解析：`whalebuddy:<slug>`；不是我们的预设就返回空字符串。文件读取失败时返回空字符串并记日志，不抛。

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd dsh-whalebuddy && node --test test/inject.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add dsh-whalebuddy/lib/inject.js dsh-whalebuddy/lib/index.js dsh-whalebuddy/test/inject.test.js
git commit -m "feat(whalebuddy): memory injection with budget"
```

---

### Task 6: 最小收工

**Files:**
- Create: `dsh-whalebuddy/lib/distill.js`
- Modify: `dsh-whalebuddy/lib/index.js`
- Test: `dsh-whalebuddy/test/distill.test.js`

**Interfaces:**
- Produces:

```ts
type Extraction = { report?: string; promises?: string[]; corrections?: string[]; facts?: string[] }
type Extractor = (transcript: string, previous: { hot: string; rapport: string }) => Promise<Extraction>
mergeExtraction(prev: { hot: string; rapport: string; tasks: Task[] }, x: Extraction, now: string): { hot: string; rapport: string; tasks: Task[]; logEntry: string }
createQueue(): { push(slug: string, task: () => Promise<void>): Promise<void> }
ruleExtractor(transcript: string): Extraction
```

`mergeExtraction` 是纯函数：`report` 进当日日志；`corrections` 进 `rapport.md`（`- [日期] 纠错：…`）；`promises` 生成 `status: 'open'` 的待办；`facts` 进 `knowledge.md` 的追加段；`hot.md` 只保留最近 800 字。

`ruleExtractor` 是 P1a 的确定性提取器（不调模型）：按 `。！？\n` 切句；含 `别` / `不要` / `以后` 的句子进 `corrections`；含 `答应` / `记得` / `帮我` 的句子进 `promises`；`report` 取最后一段 assistant 文本的前 200 字。模型提取器留到 P2。

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeExtraction, ruleExtractor, createQueue } from '../lib/distill.js'

const prev = { hot: '', rapport: '', tasks: [] }

test('promises become open tasks', () => {
  const out = mergeExtraction(prev, { promises: ['周五前把登录改完'] }, '2026-11-09')
  assert.equal(out.tasks.length, 1)
  assert.equal(out.tasks[0].status, 'open')
  assert.equal(out.tasks[0].text, '周五前把登录改完')
})

test('corrections land in rapport with a date', () => {
  const out = mergeExtraction(prev, { corrections: ['别用反问句'] }, '2026-11-09')
  assert.match(out.rapport, /2026-11-09.*别用反问句/)
})

test('hot memory keeps the newest 800 characters', () => {
  const out = mergeExtraction({ ...prev, hot: '旧'.repeat(800) }, { report: '新'.repeat(100) }, '2026-11-09')
  assert.ok(out.hot.length <= 800)
  assert.ok(out.hot.includes('新'))
})

test('an empty extraction changes nothing', () => {
  const out = mergeExtraction(prev, {}, '2026-11-09')
  assert.deepEqual({ hot: out.hot, rapport: out.rapport, tasks: out.tasks }, prev)
})

test('rule extractor pulls corrections and promises', () => {
  const x = ruleExtractor('以后别用反问句。答应我周五前改完登录。')
  assert.deepEqual(x.corrections, ['以后别用反问句'])
  assert.deepEqual(x.promises, ['答应我周五前改完登录'])
})

test('the queue serializes two writes for the same employee', async () => {
  const events = []
  const q = createQueue()
  await Promise.all([
    q.push('小白', async () => { events.push('a1'); await new Promise(r => setTimeout(r, 10)); events.push('a2') }),
    q.push('小白', async () => { events.push('b1') }),
  ])
  assert.deepEqual(events, ['a1', 'a2', 'b1'])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd dsh-whalebuddy && node --test test/distill.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `mergeExtraction`、`ruleExtractor`、`createQueue`**

三个都是纯函数/内存结构，无 I/O。日志条目格式：`## 2026-11-09\n- 做了什么…`。`createQueue` 内部 `Map<slug, Promise>`，`push` 把任务串到该 slug 的链尾，返回该任务自己的 Promise。

- [ ] **Step 4: 接到命令与写回**

`index.js` 注册 `/收工`：取当前会话的 employee；把本会话的 `user/message` 与 `assistant/message` 文本拼起来（上限 8000 字）；`await ruleExtractor(transcript)` 得到 `Extraction`；用**同一员工的队列**包住「读三个文件 → `mergeExtraction` → 原子写回」——`queue.push(slug, async () => { ... })`。

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd dsh-whalebuddy && node --test test/distill.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add dsh-whalebuddy/lib/distill.js dsh-whalebuddy/lib/index.js dsh-whalebuddy/test/distill.test.js
git commit -m "feat(whalebuddy): minimal end-of-session distillation"
```

---

### Task 7: 端到端验收

**Files:**
- Modify: `docs/superpowers/plans/2026-11-09-whalebuddy-p1a.md`（只更新本节的验收记录）

- [ ] **Step 1: 创建同事**

在一个新会话里执行 `/colleague new 小白`。
Expected: `~/.dsh/whalebuddy/小白/profile.md` 与 `index.json` 出现；`agentPresets` 列表里出现 `whalebuddy:小白`。

- [ ] **Step 2: 开她的会话并留下记忆**

用 `whalebuddy:小白` 预设开新会话，说一句"以后别用反问句"，然后 `/收工`。
Expected: `memory/rapport.md` 出现当天的纠错条目；`memory/log/` 出现当天文件。

- [ ] **Step 3: 新会话验证注入**

再开一个新会话（同一预设），问"我们说过什么"。
Expected: 她的回答里带着刚才那条纠错；会话的系统提示里能看到 `whalebuddy:memory` 段。

- [ ] **Step 4: 验证失败路径**

把 `~/.dsh/whalebuddy/小白/memory/hot.md` 改成不可读（或删掉整个 `memory/`），再开一个会话。
Expected: 会话正常打开，只有身份段；日志里有读取失败的警告，没有崩溃。

- [ ] **Step 5: 记录结果并提交**

```bash
git add docs/superpowers/plans/2026-11-09-whalebuddy-p1a.md
git commit -m "docs(whalebuddy): P1a acceptance notes"
```

---

## 后续（不在本计划内）

- **P1b**：侧边栏员工列表、创建向导、详情页——单独一份计划。
- **P2 及以后**：完整提炼管线、待确认队列、公共档案编辑、L2 调度、L3、召回；各自成计划。
