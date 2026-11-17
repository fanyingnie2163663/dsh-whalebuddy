/**
 * Capability packs: the colleague's toolkit as data.
 *
 * A pack is one reviewable unit binding plugin rows, the tools it owns, and the
 * skills directory a colleague may grow into. A colleague's kit is an ordered
 * list of pack ids; it compiles to the preset row list that session starts with.
 *
 * Two rules keep this safe:
 *
 * - A template row is dropped only when an unselected pack claims it (its
 *   `include`) or a selected pack excludes it. Unclassified rows stay, so a
 *   custom preset never loses rows this plugin does not know.
 * - Only tools a selected pack claims are allowed; unclassified global tools
 *   stay visible (fail-open), so a new host plugin can never lock a colleague
 *   out of her basic tools.
 *
 * @module dsh-whalebuddy/packs
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Where pack overrides live, relative to the whalebuddy data root. */
export const PACKS_DIR = join('_shared', 'packs')

/** The pack every kit carries; its rows are the base template selection. */
export const BASE_PACK = 'core'

/** Whalebuddy's own plugin row inside a colleague preset. */
const WHALEBUDDY_PLUGIN_NAME = '@fanyingnie/dsh-whalebuddy'

/**
 * @typedef {object} Pack
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string} [label]
 * @property {number} [order]
 * @property {string[]} [include]
 * @property {string[]} [exclude]
 * @property {import('./presets.js').PresetRow[]} [rows]
 * @property {string[]} [tools]
 */

/**
 * Built-in packs. `include`/`exclude` match a template row's id or plugin
 * name; `tools` matches global tool names. Patterns are globs (* and ?).
 * @type {readonly Pack[]}
 */
export const DEFAULT_PACKS = Object.freeze([
  {
    id: 'core',
    name: '基座',
    order: 0,
    description: '对话、文件读写、搜索、技能目录、收工与记忆',
    label: '基座（文件读写、搜索、技能、待办、交付）',
    include: [
      'persona',
      'agent-instructions',
      'time-context',
      'tool-fs',
      'tool-fs-search',
      'tool-jobs',
      'skill-filesystem',
      'tool-skill',
      'compaction',
      'planning',
    ],
    exclude: [],
    rows: [],
    tools: [],
  },
  {
    id: 'shell',
    name: '命令行',
    order: 10,
    description: 'bash / pwsh，以及已有的 shell 工具',
    label: '命令行（bash / pwsh）',
    include: ['tool-bash', 'tool-pwsh'],
    exclude: [],
    rows: [],
    tools: ['bash', 'pwsh', 'persistent-*', 'terminal*', 'ops_bash', 'ops_shell*'],
  },
  {
    id: 'research',
    name: '资料',
    order: 20,
    description: '联网搜索与抓取网页',
    label: '资料（web_search / web_fetch）',
    include: ['tool-web'],
    exclude: [],
    rows: [],
    tools: ['web_search', 'web_fetch'],
  },
  {
    id: 'schedule',
    name: '日程',
    order: 30,
    description: '提醒、目标与定时任务',
    label: '日程（提醒、目标、定时任务）',
    include: ['tool-schedule', 'command-goal', 'tool-goal'],
    exclude: [],
    rows: [],
    tools: ['schedule_*', 'get_goal', 'update_goal', 'create_goal'],
  },
  {
    id: 'delegate',
    name: '委派',
    order: 40,
    description: '把活分给子代理并收回结果',
    label: '委派（subagent 子代理）',
    include: ['delegation'],
    exclude: [],
    rows: [],
    tools: ['subagent*', 'list_agents', 'send_message', 'interrupt_agent'],
  },
  {
    id: 'browser',
    name: '浏览器',
    order: 50,
    description: '本机浏览器自动化',
    label: '浏览器（ego_*：截图、点击、抓 JS 页）',
    include: [],
    exclude: [],
    rows: [],
    tools: ['ego_*'],
  },
  {
    id: 'review',
    name: '审查',
    order: 60,
    description: '独立代码审查与证据核对',
    label: '审查（review_*）',
    include: [],
    exclude: [],
    rows: [],
    tools: ['review_*'],
  },
  {
    id: 'office',
    name: 'Office',
    order: 70,
    description: 'Word / Excel / PowerPoint / PDF',
    label: 'Office（office_*）',
    include: [],
    exclude: [],
    rows: [],
    tools: ['office_*'],
  },
  {
    id: 'plugins',
    name: '插件管理',
    order: 80,
    description: '在会话里装、卸、调插件',
    label: '插件管理（plugin_* / market_*）',
    include: ['tool-plugin-manager', 'tool-plugin-market'],
    exclude: [],
    rows: [],
    tools: ['plugin_*', 'market_*'],
  },
])

/** Role hints used when a colleague has no explicit kit. */
const ROLE_HINTS = Object.freeze([
  { match: /美术|设计|视觉|插画/i, kit: ['core', 'research', 'browser'] },
  { match: /视频|动画|剪辑/i, kit: ['core', 'research', 'browser'] },
  { match: /开发|工程|程序/i, kit: ['core', 'shell', 'research', 'review'] },
  { match: /审|测试|质量/i, kit: ['core', 'research', 'review'] },
  { match: /资料|研究|调研/i, kit: ['core', 'research', 'browser'] },
  { match: /统筹|协调|项目/i, kit: ['core', 'shell', 'schedule', 'delegate', 'research'] },
])

/** The kit a new colleague starts with, inferred from the role text. */
export const DEFAULT_KIT = Object.freeze(['core', 'shell', 'research'])

/**
 * @param {string} [role]
 * @returns {string[]}
 */
export function suggestKit(role) {
  const text = typeof role === 'string' ? role : ''
  for (const hint of ROLE_HINTS) {
    if (hint.match.test(text)) return [...hint.kit]
  }
  return [...DEFAULT_KIT]
}

/**
 * Merge built-in packs with YAML overrides from `_shared/packs/*.yml`.
 * A file with a known id replaces that pack; a new id adds one. A broken file
 * is skipped with a warning — one bad YAML must not cost a colleague her kit.
 * @param {string} dataDir
 * @param {{ warn?: (message: string) => void }} [logger]
 * @returns {Promise<Map<string, Pack>>}
 */
export async function loadPacks(dataDir, logger) {
  const packs = new Map(DEFAULT_PACKS.map((pack) => [pack.id, normalizePack(pack)]))
  let files = []
  try {
    files = await readdir(join(dataDir, PACKS_DIR))
  } catch {
    return packs
  }
  for (const file of files.sort()) {
    if (!/\.ya?ml$/i.test(file)) continue
    try {
      const text = await readFile(join(dataDir, PACKS_DIR, file), 'utf8')
      const parsed = parseYaml(text)
      const entries = Array.isArray(parsed) ? parsed : [parsed]
      for (const entry of entries) {
        const pack = normalizePack(entry)
        if (pack === undefined) continue
        packs.set(pack.id, pack)
      }
    } catch (error) {
      logger?.warn?.('无法读取能力包 ' + file + '：' + describeError(error))
    }
  }
  return packs
}

/**
 * Validate one pack definition; undefined means "not usable as a pack".
 * @param {unknown} value
 * @returns {Pack | undefined}
 */
export function normalizePack(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = /** @type {Record<string, unknown>} */ (value)
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return undefined
  const name = typeof source.name === 'string' && source.name.trim() !== '' ? source.name.trim() : id
  return {
    id,
    name,
    ...(typeof source.description === 'string' ? { description: source.description } : {}),
    ...(typeof source.label === 'string' && source.label.trim() !== '' ? { label: source.label.trim() } : {}),
    ...(Number.isFinite(source.order) ? { order: /** @type {number} */ (source.order) } : {}),
    include: stringList(source.include),
    exclude: stringList(source.exclude),
    rows: Array.isArray(source.rows) ? source.rows.filter(isRow) : [],
    tools: stringList(source.tools),
  }
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : []
}

/**
 * @param {unknown} row
 * @returns {boolean}
 */
function isRow(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row) && typeof (/** @type {any} */ (row).name) === 'string'
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Normalize a kit: known ids only, unique, preserving order. An empty or
 * unknown kit falls back to the base pack so a colleague never starts bare.
 * @param {unknown} kit
 * @param {Map<string, Pack>} packs
 * @returns {string[]}
 */
export function normalizeKit(kit, packs) {
  const wanted = Array.isArray(kit) ? kit : []
  const ids = []
  for (const id of wanted) {
    if (typeof id !== 'string' || !packs.has(id) || ids.includes(id)) continue
    ids.push(id)
  }
  return [BASE_PACK, ...ids.filter((id) => id !== BASE_PACK)]
}

/**
 * Glob matcher over a row id or plugin name (only * and ? are special).
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function globMatch(pattern, value) {
  const source = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp('^' + source + '$').test(value)
}

/**
 * Does a template row match one of the patterns? A row matches by id or by the
 * plugin package name, so a pack keeps working when an id is renamed.
 * @param {import('./presets.js').PresetRow} row
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesRow(row, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const values = [row?.id, row?.name].filter((value) => typeof value === 'string')
  return patterns.some((pattern) => values.some((value) => globMatch(pattern, value)))
}

/**
 * Compile one colleague's preset rows.
 *
 * - A row claimed only by unselected packs is dropped; a row no pack claims
 *   always stays (fail-open), so basic tools survive any kit.
 * - Pack `rows` are appended (deduped by id/name).
 * - The skill provider is pointed at the colleague's own skills directory.
 * - Whalebuddy's own rows are stripped; the caller appends its memory row.
 *
 * @param {import('./presets.js').PresetRow[]} templateRows
 * @param {Map<string, Pack>} packs
 * @param {string[]} kit
 * @param {{ skillsDir?: string }} [options]
 * @returns {import('./presets.js').PresetRow[]}
 */
export function compileRows(templateRows, packs, kit, options = {}) {
  const ids = normalizeKit(kit, packs)
  const selectedIds = new Set(ids)
  const selected = ids.map((id) => packs.get(id)).filter(Boolean)
  const include = selected.flatMap((pack) => pack.include ?? [])
  const exclude = selected.flatMap((pack) => pack.exclude ?? [])
  // Rows of packs this colleague did not pick are the ones that must go.
  const claimed = [...packs.values()]
    .filter((pack) => !selectedIds.has(pack.id))
    .flatMap((pack) => pack.include ?? [])
  const skillsDir = typeof options.skillsDir === 'string' ? options.skillsDir : ''

  const template = Array.isArray(templateRows) ? templateRows : []
  const rows = []
  const seen = new Set()
  const accept = (row) => {
    if (row?.name === WHALEBUDDY_PLUGIN_NAME || row?.id === 'whalebuddy-memory') return false
    const key = rowKey(row)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  for (const row of template) {
    // An unselected pack's rows are hidden unless a selected pack re-claims
    // them; everything else stays, including rows no pack mentions at all.
    if (matchesRow(row, claimed) && !matchesRow(row, include)) continue
    if (matchesRow(row, exclude)) continue
    if (!accept(row)) continue
    rows.push(rewriteSkillRow(row, skillsDir))
  }

  for (const pack of selected) {
    for (const row of pack.rows ?? []) {
      if (!accept(row)) continue
      rows.push(rewriteSkillRow(row, skillsDir))
    }
  }

  return rows
}

/**
 * Point a skill provider row at the colleague's skills directory.
 * @param {import('./presets.js').PresetRow} row
 * @param {string} skillsDir
 * @returns {import('./presets.js').PresetRow}
 */
function rewriteSkillRow(row, skillsDir) {
  if (skillsDir === '' || typeof row?.name !== 'string' || !row.name.endsWith('dsh-skill-filesystem')) return row
  const config = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {}
  const current = Array.isArray(config.customSkillDirs) ? config.customSkillDirs.filter((item) => typeof item === 'string') : []
  if (current.includes(skillsDir)) return row
  return { ...row, config: { ...config, customSkillDirs: [...current, skillsDir] } }
}

/**
 * @param {import('./presets.js').PresetRow} row
 * @returns {string}
 */
function rowKey(row) {
  return typeof row?.id === 'string' && row.id !== '' ? 'id:' + row.id : 'name:' + String(row?.name ?? '')
}

/**
 * Tools the selected kit must hide: every tool claimed by an unselected pack,
 * minus tools claimed by a selected one. Unclassified names are never denied.
 * @param {Map<string, Pack>} packs
 * @param {string[]} kit
 * @param {Iterable<string>} knownTools
 * @returns {string[]}
 */
export function compileToolDeny(packs, kit, knownTools) {
  const selected = new Set(normalizeKit(kit, packs))
  const names = [...knownTools].filter((name) => name !== 'run_code')
  const deny = new Set()
  const allow = new Set()
  for (const pack of packs.values()) {
    const patterns = pack.tools ?? []
    if (patterns.length === 0) continue
    const matches = names.filter((name) => patterns.some((pattern) => globMatch(pattern, name)))
    if (selected.has(pack.id)) {
      for (const name of matches) allow.add(name)
    } else {
      for (const name of matches) deny.add(name)
    }
  }
  for (const name of allow) deny.delete(name)
  return [...deny].sort()
}

/**
 * Display rows for the console.
 * @param {Map<string, Pack>} packs
 * @param {string[]} kit
 * @returns {Array<{id: string, name: string, description: string, order: number, selected: boolean, rows: number, tools: string[]}>}
 */
export function packList(packs, kit) {
  const selected = new Set(normalizeKit(kit, packs))
  return [...packs.values()]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id))
    .map((pack) => ({
      id: pack.id,
      name: pack.name,
      description: pack.description ?? '',
      order: pack.order ?? 999,
      selected: selected.has(pack.id),
      rows: (pack.rows ?? []).length + (pack.include ?? []).length,
      tools: [...(pack.tools ?? [])],
    }))
}

/**
 * One short prompt block describing what this kit issues and what it withholds.
 * The colleague reads it before choosing a tool: a missing binding is a normal
 * "not issued" answer, not a reason to try another tool or report a bug.
 * @param {Map<string, Pack>} packs
 * @param {string[]} kit
 * @returns {string}
 */
export function describeToolSurface(packs, kit) {
  const selected = new Set(normalizeKit(kit, packs))
  const owned = []
  const missing = []
  const ordered = [...packs.values()].sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id),
  )
  for (const pack of ordered) {
    const label = typeof pack.label === 'string' && pack.label !== '' ? pack.label : pack.name
    if (selected.has(pack.id)) owned.push(label)
    else missing.push(pack.name)
  }
  const lines = [
    '### 工具面',
    '有：' + (owned.length > 0 ? owned.join('；') : '（无）'),
  ]
  if (missing.length > 0) lines.push('没有：' + missing.join('、'))
  lines.push(
    '规则：没有的工具不要调用，也不要“试一下”；需要时换做法，或让老板找蓝鲸重配 kit。列出的工具若实际调不到，说明宿主没装或已禁用，停下来说明，不要用别的工具硬凑。',
  )
  return lines.join('\n')
}