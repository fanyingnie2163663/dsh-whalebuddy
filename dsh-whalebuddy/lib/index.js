import { randomUUID } from 'node:crypto'
import { appendFile, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import Schema from 'schemastery'
import { appendChange } from './changelog.js'
import { createQueue, mergeExtraction, ruleExtractor } from './distill.js'
import { createPanelRoutes, isConsoleRequestAllowed, ROUTES } from './host/routes.js'
import { assembleMemory } from './inject.js'
import { DEFAULT_NAMES } from './names.js'
import { NOTICE_FILE, appendWithinCap, collectNotice, noticeCapFromState, parseNotices } from './notices.js'
import { compileRows, compileToolDeny, describeToolSurface, loadPacks, normalizeKit, suggestKit } from './packs.js'
import { registerEmployeePresets, resolveTemplateRows } from './presets.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assignWorkspace, canAssign } from './assign.js'
import { createStore } from './store.js'

/**
 * @typedef {import('./distill.js').Extraction} Extraction
 * @typedef {import('./distill.js').TranscriptBlock} TranscriptBlock
 * @typedef {import('./inject.js').MemoryFiles} MemoryFiles
 * @typedef {import('./presets.js').PresetRow} PresetRow
 * @typedef {import('./store.js').EmployeeSummary} EmployeeSummary
 * @typedef {import('./store.js').Store} Store
 */

/**
 * @typedef {object} CommandInvocation
 * @property {string} [rawInput]
 * @property {{ session?: { id?: string, header?: { id?: string } } }} [agent]
 */

/**
 * @typedef {object} CommandResult
 * @property {'success' | 'error'} kind
 * @property {string} [text]
 */

/**
 * @typedef {object} EmployeeCommandOptions
 * @property {(employee: EmployeeSummary) => Promise<void>} [onCreated]
 * @property {*} [logger]
 * @property {Map<string, import('./packs.js').Pack>} [packs]
 * @property {(slug: string) => Promise<string[]>} [readKit]
 * @property {(slug: string, kit: string[]) => Promise<string[]>} [writeKit]
 */

export const name = 'dsh-whalebuddy'
export const inject = ['commands', 'systemPrompt']
export const Config = Schema.object({
  dataDir: Schema.string().default(''),
  presetRows: Schema.array(Schema.any()).default([]),
  // Set by a colleague preset (`config: { employee: '<slug>' }`); empty on the
  // profile-level load, which owns the command and the preset registry.
  employee: Schema.string().default(''),
  // Global tools this colleague's kit must hide; computed by the profile-level
  // load at registration time and applied by this preset-scoped copy.
  toolDeny: Schema.array(Schema.string()).default([]),
  // Human-readable "what this kit issues / withholds" block, built by the
  // profile-level load and injected as a prompt section by this scoped copy.
  toolSurface: Schema.string().default(''),
})

const COMMAND_NAME = 'colleague'
const COMMAND_DESCRIPTION = '创建或列出同事'
const COMMAND_HINT = 'new <名字> | ls | kit [<slug> [set|add|rm|reset <包,...>]]'
const USAGE = '用法：/colleague new <名字> | ls | kit [<slug> [set|add|rm|reset <包,...>]]'
const MISSING_NAME = '给个名字：/colleague new 小白'
const EMPTY_LIST = '还没有同事：/colleague new 小白'
const UNNAMED_ROLE = '未定'
const DEFAULT_AUTONOMY = 'L2'
const DATA_DIR_NAME = 'whalebuddy'
/** The prompt section a preset-scoped instance owns. */
const MEMORY_SECTION_NAME = 'whalebuddy:memory'
/** The prompt section that tells a colleague which tools her kit issued. */
const TOOL_SURFACE_SECTION_NAME = 'whalebuddy:tools'
/** Cut-in slot when the harness cannot order `HARNESS_IDENTITY`. */
const FALLBACK_MEMORY_ORDER = 1000
/** Keep `_startup.log` bounded; it is diagnostics, not history. */
const STARTUP_LOG_LIMIT = 64 * 1024
const HARNESS_IDENTITY_SECTION = 'HARNESS_IDENTITY'
/** `_shared/` sits beside the employee directories, not inside one. */
const SHARED_SLUG = '_shared'
const SHARED_USER_FILE = 'user.md'
const SHARED_ROSTER_FILE = 'roster.md'
/** `/collect` exists only in a preset-scoped instance (ruling R9). */
const COLLECT_COMMAND_NAME = 'collect'
const COLLECT_COMMAND_DESCRIPTION = '收工：把这次会话里值得留下的写进记忆'
const COLLECT_SUCCESS = '收工了。'
const COLLECT_EMPTY = '这个会话没攒到可收的文字。'
/** Message event types that feed the transcript buffer. */
const MESSAGE_EVENT_TYPES = ['user/message', 'assistant/message']
/** System reminders ride inside user messages; they are not the user's words. */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
/** Only the newest 8000 transcript characters are distilled on command. */
const TRANSCRIPT_LIMIT = 8000
/** Same warning for the load-time and the lazy template resolution paths. */
const NO_TEMPLATE_ROWS = '同事预设没有模板行，只含 Whalebuddy 自身'
/** Serializes every collect's read-modify-write per employee across instances. */
const collectQueue = createQueue()

/**
 * Resolve the colleague data root: the configured directory when it is
 * non-empty, then the harness home (`dshHomePath('whalebuddy')`), then
 * `~/.dsh/whalebuddy`.
 * @param {*} ctx
 * @param {{ dataDir?: string }} config
 * @returns {string}
 */
export function resolveDataDir(ctx, config) {
  const configured = config?.dataDir
  if (typeof configured === 'string' && configured !== '') return configured
  if (typeof ctx?.get === 'function') {
    const dshHomePath = ctx.get('dshHomePath')
    if (typeof dshHomePath === 'function') {
      const root = dshHomePath(DATA_DIR_NAME)
      if (typeof root === 'string' && root !== '') return root
    }
  }
  return join(homedir(), '.dsh', DATA_DIR_NAME)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Warn through a bare logger without requiring a complete one.
 * @param {*} logger
 * @param {string} message
 * @returns {void}
 */
function warnThrough(logger, message) {
  if (typeof logger?.warn === 'function') logger.warn(message)
}

/**
 * Warn through the context logger; the harness always provides one.
 * @param {*} ctx
 * @param {string} message
 * @returns {void}
 */
function warn(ctx, message) {
  warnThrough(ctx?.logger, message)
}

/**
 * Template rows from the plugin config; absent configuration means `[]`.
 * @param {{ presetRows?: unknown }} [config]
 * @returns {PresetRow[]}
 */
function presetRowsOf(config) {
  const rows = config?.presetRows
  return Array.isArray(rows) ? rows : []
}

/**
 * Build the `/colleague` command: create a colleague or list them.
 * @param {Store} store
 * @param {EmployeeCommandOptions} [options]
 * @returns {{ name: string, description: string, input: { hint: string }, handler: (invocation: CommandInvocation) => Promise<CommandResult> }}
 */
export function createEmployeeCommand(store, options = {}) {
  return {
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_HINT },
    async handler(invocation) {
      const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''

      if (rawInput === '' || /^ls$/i.test(rawInput)) {
        try {
          return await listEmployees(store)
        } catch (error) {
          return { kind: 'error', text: `读取同事列表失败：${describeError(error)}` }
        }
      }

      const create = /^new(?:\s+([\s\S]*))?$/i.exec(rawInput)
      if (create) {
        const employeeName = (create[1] ?? '').trim()
        if (employeeName === '') return { kind: 'error', text: MISSING_NAME }
        try {
          return await createEmployee(store, employeeName, options)
        } catch (error) {
          return { kind: 'error', text: `创建同事失败：${describeError(error)}` }
        }
      }

      const kit = /^kit(?:\s+([\s\S]*))?$/i.exec(rawInput)
      if (kit) {
        try {
          return await handleKit(store, (kit[1] ?? '').trim(), options)
        } catch (error) {
          return { kind: 'error', text: '工具箱操作失败：' + describeError(error) }
        }
      }

      return { kind: 'error', text: USAGE }
    },
  }
}

/**
 * @param {Store} store
 * @returns {Promise<CommandResult>}
 */
async function listEmployees(store) {
  const employees = await store.list()
  if (employees.length === 0) return { kind: 'success', text: EMPTY_LIST }
  const lines = employees.map((employee) => {
    const role = typeof employee.role === 'string' && employee.role.trim() !== '' ? employee.role.trim() : UNNAMED_ROLE
    return `${employee.slug} · ${role} · ${employee.autonomy}`
  })
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Read one colleague's kit: an explicit state list, or the role suggestion.
 * @param {Store} store
 * @param {EmployeeSummary} employee
 * @param {Map<string, import('./packs.js').Pack>} packs
 * @param {EmployeeCommandOptions} [options]
 * @returns {Promise<string[]>}
 */
async function readKitOf(store, employee, packs, options = {}) {
  if (typeof options.readKit === 'function') return options.readKit(employee.slug)
  const state = await store.state(employee.slug)
  return normalizeKit(state.kit ?? suggestKit(employee.role), packs)
}

/**
 * `/colleague kit`: list, inspect, or edit the capability packs a colleague
 * carries into her next session. The current session keeps its composition —
 * DSH locks a preset after the first turn.
 * @param {Store} store
 * @param {string} input
 * @param {EmployeeCommandOptions} [options]
 * @returns {Promise<CommandResult>}
 */
async function handleKit(store, input, options = {}) {
  const packs = options.packs
  if (!packs || typeof packs.values !== 'function') {
    return { kind: 'error', text: '能力包没有加载，暂时无法调整工具箱' }
  }
  const employees = await store.list()
  if (employees.length === 0) return { kind: 'success', text: EMPTY_LIST }

  const parts = input.split(/\s+/).filter((part) => part !== '')
  const [slug, action] = parts
  const value = parts.slice(2).join(',')

  if (slug === undefined) {
    const lines = []
    for (const employee of employees) {
      const kit = await readKitOf(store, employee, packs, options)
      lines.push(employee.slug + ' · ' + kit.join(', '))
    }
    return { kind: 'success', text: '同事工具箱：\n' + lines.join('\n') + '\n用 /colleague kit <slug> set|add|rm <包,...> 调整。' }
  }

  const employee = employees.find((entry) => entry.slug === slug || entry.name === slug)
  if (employee === undefined) return { kind: 'error', text: '没有这位同事：' + slug }
  const current = await readKitOf(store, employee, packs, options)
  if (action === undefined) {
    return { kind: 'success', text: employee.slug + ' · ' + current.join(', ') }
  }

  const wanted = typeof value === 'string'
    ? value.split(/[,，]/).map((id) => id.trim()).filter((id) => id !== '')
    : []
  let next
  if (action === 'set') next = wanted
  else if (action === 'add') next = [...current, ...wanted]
  else if (action === 'rm' || action === 'remove') next = current.filter((id) => !wanted.includes(id))
  else if (action === 'reset') next = suggestKit(employee.role)
  else return { kind: 'error', text: USAGE }

  if (typeof options.writeKit !== 'function') {
    return { kind: 'error', text: '当前无法写回工具箱' }
  }
  const saved = await options.writeKit(employee.slug, normalizeKit(next, packs))
  return {
    kind: 'success',
    text: '已更新「' + employee.slug + '」工具箱：' + saved.join(', ') + '\n下次新会话生效。',
  }
}

/**
 * @param {Store} store
 * @param {string} employeeName
 * @param {EmployeeCommandOptions} [options]
 * @returns {Promise<CommandResult>}
 */
async function createEmployee(store, employeeName, options = {}) {
  const known = DEFAULT_NAMES.find((entry) => entry.name === employeeName)
  const employee = await store.create({
    name: employeeName,
    role: '',
    presetId: '',
    autonomy: DEFAULT_AUTONOMY,
    workspaces: [],
    temperament: known ? known.temperament : '',
  })

  if (typeof options?.onCreated === 'function') {
    try {
      await options.onCreated(employee)
    } catch (error) {
      warnThrough(options.logger, `同事「${employee.slug}」的预设注册失败：${describeError(error)}`)
    }
  }

  return { kind: 'success', text: `已创建同事「${employeeName}」（${employee.slug}）。` }
}

/**
 * Order the memory section right after the harness identity. Unknown names
 * throw (or return a non-number) in some builds, hence the guarded fallback.
 * @param {*} ctx
 * @returns {number}
 */
function memorySectionOrder(ctx) {
  try {
    const systemPrompt = ctx?.systemPrompt
    if (typeof systemPrompt?.getSectionOrder === 'function') {
      const order = systemPrompt.getSectionOrder(HARNESS_IDENTITY_SECTION)
      if (typeof order === 'number' && Number.isFinite(order)) return order + 1
    }
  } catch {
    // Fall through to the late slot.
  }
  return FALLBACK_MEMORY_ORDER
}

/**
 * Read one employee file; a missing file coalesces to `''` (ruling R4).
 * @param {Store} store
 * @param {string} slug
 * @param {string} rel
 * @returns {Promise<string>}
 */
async function readMemoryText(store, slug, rel) {
  const text = await store.read(slug, rel)
  return typeof text === 'string' ? text : ''
}

/**
 * Read every file the opening injection assembles. Missing files become `''`
 * and a missing task file becomes `[]`; a corrupt file throws and leaves the
 * previous cache in place.
 * @param {Store} store
 * @param {string} employee
 * @returns {Promise<MemoryFiles>}
 */
async function readMemoryFiles(store, employee) {
  const [profile, rapport, knowledge, hot, recent, tasks, shared, roster, orders] = await Promise.all([
    readMemoryText(store, employee, 'profile.md'),
    readMemoryText(store, employee, 'memory/rapport.md'),
    readMemoryText(store, employee, 'memory/knowledge.md'),
    readMemoryText(store, employee, 'memory/hot.md'),
    readMemoryText(store, employee, 'memory/recent.md'),
    store.tasks(employee),
    readMemoryText(store, SHARED_SLUG, SHARED_USER_FILE),
    readMemoryText(store, SHARED_SLUG, SHARED_ROSTER_FILE),
    store.orders(employee),
  ])
  return { profile, rapport, knowledge, hot, recent, tasks, shared, roster, orders }
}

/**
 * Local `YYYY-MM-DD` stamp: the log file name and every dated memory line.
 * @param {Date} [date]
 * @returns {string}
 */
function todayStamp(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Keep the text blocks of one `user/message` or `assistant/message` event,
 * tagged with the role, so the newest assistant text can become the report
 * even after the joined transcript is tail-capped. A plain string content is
 * text too; anything else is ignored.
 * @param {TranscriptBlock[]} buffer
 * @param {*} event
 * @returns {void}
 */
function recordTranscript(buffer, event) {
  if (!MESSAGE_EVENT_TYPES.includes(event?.type)) return
  const role = event.type === 'user/message' ? 'user' : 'assistant'
  // A `user/message` event's `data` is the UserMessage itself; an
  // `assistant/message` event wraps it as `data.message` (see the host events).
  const message = event.type === 'assistant/message' ? event.data?.message : event.data
  // Workspace instructions arrive as a user message sourced from the
  // agent-instructions plugin; they are guidance, not the user's own words.
  if (role === 'user' && message?.source?.kind === 'agent-instructions') return
  const content = message?.content
  const push = (text) => {
    const cleaned = text.replace(SYSTEM_REMINDER, '').trim()
    if (cleaned !== '') buffer.push({ role, text: cleaned })
  }
  if (typeof content === 'string') {
    push(content)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') push(block.text)
  }
}

/**
 * How many memory items one extraction contributes: corrections, promises,
 * facts and the report (the log line).
 * @param {Extraction} extraction
 * @returns {number}
 */
function countNewMemories(extraction) {
  let count = typeof extraction.report === 'string' && extraction.report.trim() !== '' ? 1 : 0
  for (const list of [extraction.corrections, extraction.promises, extraction.facts]) {
    if (Array.isArray(list)) count += list.length
  }
  return count
}

/**
 * One-line changelog summary of what a `/collect` changed.
 * @param {Extraction} extraction
 * @returns {string}
 */
function describeExtraction(extraction) {
  const parts = []
  if (Array.isArray(extraction.corrections) && extraction.corrections.length > 0) {
    parts.push(`纠错 +${extraction.corrections.length}`)
  }
  if (Array.isArray(extraction.promises) && extraction.promises.length > 0) {
    parts.push(`待办 +${extraction.promises.length}`)
  }
  if (Array.isArray(extraction.facts) && extraction.facts.length > 0) {
    parts.push(`知识 +${extraction.facts.length}`)
  }
  if (typeof extraction.report === 'string' && extraction.report.trim() !== '') parts.push('日志 +1')
  return parts.join('、')
}

/**
 * Append one log entry to `memory/log/<date>.md`, keeping a blank line
 * between entries.
 * @param {Store} store
 * @param {string} employee
 * @param {string} date
 * @param {string} entry
 * @returns {Promise<void>}
 */
async function appendLog(store, employee, date, entry) {
  const rel = `memory/log/${date}.md`
  const existing = await readMemoryText(store, employee, rel)
  const head = existing.trimEnd()
  const header = `## ${date}`
  const hasHeader = head.includes(header)
  const body = entry.startsWith(header) ? entry.slice(header.length).replace(/^\n+/, '') : entry
  const next = head === '' ? `${header}\n${body}\n` : hasHeader ? `${head}\n\n${body}\n` : `${head}\n\n${header}\n${body}\n`
  await store.write(employee, rel, next)
}

/**
 * @typedef {object} CollectCommandOptions
 * @property {Store} store
 * @property {string} employee
 * @property {{ push(slug: string, task: () => Promise<void>): Promise<void> }} queue
 * @property {TranscriptBlock[] | string | ((invocation?: CommandInvocation) => TranscriptBlock[])} transcript
 * @property {() => Promise<string>} refresh
 * @property {(message: string) => void} [warn]
 */

/**
 * Build `/collect` for one preset-scoped instance. It distills the newest tail
 * of the buffered transcript, writes knowledge/rapport/tasks/hot plus the day's
 * log, then calls this instance's local `refresh` — never the module-scope
 * singleton (ruling R9). The full role-tagged record is passed to the extractor
 * so the report is the newest assistant message and only the user's turns can
 * yield corrections/promises, even when the 8000-character tail cap cuts the
 * transcript. A plain string has no roles, so it reaches the extractor without
 * the record and keeps the legacy whole-text fallback. A function is resolved
 * per invocation, so a session collects only the messages it buffered. The
 * buffer is cleared only after a successful write, so a failure can be retried.
 * @param {CollectCommandOptions} options
 * @returns {{ name: string, description: string, handler: (invocation?: CommandInvocation) => Promise<CommandResult> }}
 */
export function createCollectCommand({ store, employee, queue, transcript, refresh, warn }) {
  // Compatibility: a caller may still pass one plain string or one array. A
  // function is resolved per invocation; a string has no roles and keeps the
  // legacy whole-text fallback.
  const source = transcript

  /**
   * Leave one user-facing note after a collect that changed something. Failures
   * are warnings: a note must never turn a good collect into an error.
   * @param {Extraction} extraction
   * @param {string} summary
   * @returns {Promise<void>}
   */
  async function leaveNotice(extraction, summary) {
    try {
      const employees = await store.list()
      const self = employees.find((entry) => entry.slug === employee)
      if (self === undefined || (self.autonomy !== 'L2' && self.autonomy !== 'L3')) return
      const [stateText, noticesText] = await Promise.all([
        store.read(employee, 'state.json'),
        store.read(employee, NOTICE_FILE),
      ])
      const at = Date.now()
      const notice = collectNotice(extraction, summary, at, randomUUID())
      if (notice === null) return
      const next = appendWithinCap(parseNotices(noticesText), notice, noticeCapFromState(stateText), at)
      if (next === null) return
      await store.write(employee, NOTICE_FILE, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      if (typeof warn === 'function') warn(`给「${employee}」留便签失败：${describeError(error)}`)
    }
  }

  return {
    name: COLLECT_COMMAND_NAME,
    description: COLLECT_COMMAND_DESCRIPTION,
    async handler(invocation) {
      /** @type {TranscriptBlock[] | string} */
      const input = typeof source === 'function' ? source(invocation) : source
      const isStringInput = typeof input === 'string'
      /** @type {TranscriptBlock[]} */
      const blocks = isStringInput ? [{ role: 'assistant', text: input }] : input
      const joined = blocks.map((block) => block.text).join('\n\n').trim()
      const text = joined.slice(-TRANSCRIPT_LIMIT)
      if (text === '') return { kind: 'error', text: COLLECT_EMPTY }

      const extraction = ruleExtractor(text, isStringInput ? undefined : blocks)
      try {
        await queue.push(employee, async () => {
          const [recent, rapport, knowledge, tasks] = await Promise.all([
            readMemoryText(store, employee, 'memory/recent.md'),
            readMemoryText(store, employee, 'memory/rapport.md'),
            readMemoryText(store, employee, 'memory/knowledge.md'),
            store.tasks(employee),
          ])
          const stamp = todayStamp()
          const merged = mergeExtraction({ recent, rapport, knowledge, tasks }, extraction, stamp)

          await store.write(employee, 'memory/knowledge.md', merged.knowledge)
          await store.write(employee, 'memory/rapport.md', merged.rapport)
          await store.saveTasks(employee, merged.tasks)
          await store.write(employee, 'memory/recent.md', merged.recent)
          if (merged.logEntry !== '') await appendLog(store, employee, stamp, merged.logEntry)
          const summary = describeExtraction(extraction)
          if (summary !== '') {
            await appendChange(store, employee, '收工', summary)
            await leaveNotice(extraction, summary)
          }
          await refresh()
        })
      } catch (error) {
        return { kind: 'error', text: `收工失败：${describeError(error)}` }
      }

      blocks.length = 0
      const added = countNewMemories(extraction)
      return added > 0
        ? { kind: 'success', text: `${COLLECT_SUCCESS}${added} 条新记忆` }
        : { kind: 'success', text: COLLECT_SUCCESS }
    },
  }
}

/**
 * Preset-scoped load: cache the colleague's memory, expose it as one prompt
 * section, buffer the session transcript and register `/collect`. The
 * profile-level `/colleague` command and the preset registry are deliberately
 * skipped; otherwise every session of the colleague would register them again.
 * The section provider is synchronous, reads the cache, and never throws.
 * @param {*} ctx
 * @param {{ dataDir?: string, employee?: string, toolDeny?: string[], toolSurface?: string }} config
 * @param {string} employee
 * @returns {Promise<void>}
 */
async function applyScoped(ctx, config, employee) {
  const root = resolveDataDir(ctx, config)
  const store = createStore(root)
  const systemPrompt = ctx?.systemPrompt
  const toolSurface = typeof config?.toolSurface === 'string' ? config.toolSurface.trim() : ''

  let cached = ''

  /**
   * Read, assemble and cache again. Failures are logged and the last good text
   * stays; the section provider must never throw into prompt assembly.
   * @returns {Promise<string>}
   */
  const refresh = async () => {
    try {
      const files = await readMemoryFiles(store, employee)
      cached = assembleMemory(files)
      return cached
    } catch (error) {
      warn(ctx, `读取「${employee}」的记忆失败：${describeError(error)}`)
      return cached
    }
  }

  /**
   * One role-tagged buffer per session: `session/event` is a process-wide
   * broadcast, so a colleague with two sessions open must not let one session's
   * words into the other's memory. `/collect` resolves its own buffer through
   * `invocation.agent.session`. The same listener refreshes the cache at every
   * turn start, so a new turn sees what `/collect` wrote in the previous one.
   * @type {Map<string, TranscriptBlock[]>}
   */
  const transcripts = new Map()
  /**
   * @param {*} session
   * @returns {string}
   */
  const sessionKey = (session) => {
    const id = session?.header?.id ?? session?.id
    return typeof id === 'string' ? id : ''
  }
  /**
   * @param {string} key
   * @returns {TranscriptBlock[]}
   */
  const transcriptFor = (key) => {
    let blocks = transcripts.get(key)
    if (blocks === undefined) {
      blocks = []
      transcripts.set(key, blocks)
    }
    return blocks
  }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('session/event', (session, event) => {
        recordTranscript(transcriptFor(sessionKey(session)), event)
        if (event?.type === 'turn/start') void refresh()
      })
      ctx.on('session/disposed', (session) => {
        transcripts.delete(sessionKey(session))
      })
    } catch (error) {
      warn(ctx, `监听 session/event 失败：${describeError(error)}`)
    }
  }

  const command = createCollectCommand({
    store,
    employee,
    queue: collectQueue,
    transcript: (invocation) => transcriptFor(sessionKey(invocation?.agent?.session)),
    refresh,
    warn: (message) => warn(ctx, message),
  })
  if (typeof ctx.effect === 'function' && typeof ctx.commands?.register === 'function') {
    ctx.effect(() => ctx.commands.register(command))
  } else {
    warn(ctx, '没有 commands 服务，跳过 /collect 注册')
  }

  // Load once at apply so the first assembly already sees the memory.
  await refresh()

  if (typeof systemPrompt?.section !== 'function') {
    warn(ctx, '没有 systemPrompt 服务，跳过记忆注入')
    return
  }

  try {
    systemPrompt.section({
      name: MEMORY_SECTION_NAME,
      order: memorySectionOrder(ctx),
      // Memory is data, not a prompt template: literal `{{...}}` must survive.
      interpolate: false,
      text: () => cached,
    })
  } catch (error) {
    warn(ctx, `注册记忆段失败：${describeError(error)}`)
  }

  // The tool surface is configuration, not memory: it changes when the kit
  // changes, so it gets its own section right after the memory one.
  if (toolSurface !== '') {
    try {
      systemPrompt.section({
        name: TOOL_SURFACE_SECTION_NAME,
        order: memorySectionOrder(ctx) + 1,
        interpolate: false,
        text: () => toolSurface,
      })
    } catch (error) {
      warn(ctx, `注册工具面段失败：${describeError(error)}`)
    }
  }

  const actorProfile = (await store.read(employee, 'profile.md')) ?? ''
  if (typeof ctx.inject === 'function' && canAssign(actorProfile)) {
    ctx.inject(['tools'], (scope) => {
      try {
        scope.tools.register(defineTool({
          name: 'colleague_assign',
          description: '把某个工作区目录绑给一位同事，写进她的档案。只有档案里有「权限：分配工作区」的同事能用；别的同事调用会被告知没有权限。参数：colleague 是同事的名字或 slug，workspace 是绝对路径。',
          parameters: {
            colleague: { type: 'string', required: true, description: '同事的名字或 slug' },
            workspace: { type: 'string', required: true, description: '工作区的绝对路径' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          isConcurrencySafe: () => true,
          async execute(args) {
            const result = await assignWorkspace(store, employee, args?.colleague, args?.workspace)
            return { text: result.text }
          },
        }))
      } catch (error) {
        warn(ctx, `注册 colleague_assign 失败：${describeError(error)}`)
      }
    })
  }

  // The kit's tool gate: hide every global tool an unselected pack owns.
  // tools.restrict() only accepts scoped contexts, which this preset-scoped
  // copy is. Unknown names (a tool missing from this build) fail the call, so
  // the whole gate fails open rather than locking the colleague out.
  const toolDeny = Array.isArray(config?.toolDeny)
    ? config.toolDeny.filter((name) => typeof name === 'string' && name !== '')
    : []
  if (toolDeny.length > 0 && typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      try {
        if (typeof scope.tools?.restrict !== 'function') return
        scope.tools.restrict({ deny: toolDeny })
      } catch (error) {
        warn(ctx, '应用工具箱限制失败：' + describeError(error))
      }
    })
  }

  if (typeof ctx?.logger?.info === 'function') {
    ctx.logger.info('whalebuddy memory loaded (employee=%s, dataDir=%s)', employee, root)
  }
}

/**
 * Load the plugin in one of two modes, chosen by `config.employee`:
 *
 * - non-empty (a colleague preset's scoped copy): buffer the session and
 *   register `/collect`, then inject that colleague's memory as a prompt
 *   section — never `/colleague` or the preset registry;
 * - empty (the profile-level load): register `/colleague`, then one agent
 *   preset per colleague. A colleague created later gets its preset registered
 *   immediately, reusing the template rows resolved at load. A corrupt
 *   `index.json` only skips preset registration — it never fails the plugin
 *   load. Without an `agentPresets` service the command still works.
 * @param {*} ctx
 * @param {{ dataDir?: string, presetRows?: PresetRow[], employee?: string, toolDeny?: string[], toolSurface?: string }} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const employee = typeof config?.employee === 'string' ? config.employee.trim() : ''
  if (employee !== '') {
    await applyScoped(ctx, config, employee)
    return
  }

  const root = resolveDataDir(ctx, config)
  ctx.logger.info('whalebuddy loaded (dataDir=%s)', root)
  const store = createStore(root)

  /** @type {Map<string, () => Promise<void>>} */
  const presetDisposers = new Map()
  /** Last deny set registered per colleague; tool churn only re-registers changes. */
  const denySignatures = new Map()
  /** @type {Promise<PresetRow[]> | undefined} */
  let templateRows
  /** @type {*} */
  let presets = null
  let presetsBound = false
  let disposeEffectBound = false

  const resolveRowsOnce = () => (templateRows ??= resolveTemplateRows(presets, presetRowsOf(config)))

  const packs = await loadPacks(root, ctx.logger)

  /** Every global tool name this build knows; empty before the tools service is up. */
  const knownToolNames = () => {
    try {
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
      const view = tools && typeof tools.view === 'function' ? tools.view() : undefined
      const names = view && view.restrictableNames
      return names === undefined ? [] : [...names]
    } catch {
      return []
    }
  }

  const kitFor = async (employee) => {
    const state = await store.state(employee.slug)
    return normalizeKit(state.kit ?? suggestKit(employee.role), packs)
  }

  const rowsFor = async (employee) =>
    compileRows(await resolveRowsOnce(), packs, await kitFor(employee), {
      skillsDir: join(root, employee.slug, 'skills'),
    })

  const toolDenyFor = async (employee) => compileToolDeny(packs, await kitFor(employee), knownToolNames())

  /**
   * Register one colleague's preset from her kit, replacing any older
   * registration for the same slug. The registry keeps the old revision alive
   * while an existing session uses it, so a kit change is safe mid-session.
   * @param {EmployeeSummary} employee
   * @returns {Promise<{ rows: number, deny: number }>}
   */
  const registerOne = async (employee) => {
    if (!presets) return { rows: 0, deny: 0 }
    const previous = presetDisposers.get(employee.slug)
    if (previous !== undefined) {
      await previous()
      presetDisposers.delete(employee.slug)
    }
    const rows = await rowsFor(employee)
    if (rows.length === 0) warn(ctx, NO_TEMPLATE_ROWS)
    const toolDeny = await toolDenyFor(employee)
    const toolSurface = describeToolSurface(packs, await kitFor(employee))
    denySignatures.set(employee.slug, toolDeny.join('\u0000'))
    const dispose = await registerEmployeePresets(presets, [employee], rows, ctx.logger, root, () => ({ toolDeny, toolSurface }))
    presetDisposers.set(employee.slug, dispose)
    return { rows: rows.length, deny: toolDeny.length }
  }

  /**
   * Append one diagnostic line for the next startup post-mortem. Never throws.
   * @param {Record<string, string | number | undefined>} fields
   * @returns {Promise<void>}
   */
  const note = async (fields) => {
    try {
      const pairs = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
      const file = join(root, '_startup.log')
      try {
        if ((await stat(file)).size > STARTUP_LOG_LIMIT) await rename(file, `${file}.1`)
      } catch {
        // A missing log (or a concurrent rotation) simply appends below.
      }
      await appendFile(file, `${new Date().toISOString()} ${pairs.join(' ')}\n`, 'utf8')
    } catch {
      // diagnostics must never break the plugin
    }
  }

  /**
   * Dispose every collected preset registration, newest first.
   * @returns {Promise<void>}
   */
  const disposeAll = async () => {
    for (const dispose of [...presetDisposers.values()].reverse()) {
      try {
        await dispose()
      } catch (error) {
        warn(ctx, `注销同事预设失败：${describeError(error)}`)
      }
    }
  }

  /**
   * Register the disposal effect exactly once, on the context that owns the
   * service.
   * @param {*} inner
   * @returns {void}
   */
  const bindDisposeEffect = (inner) => {
    if (disposeEffectBound) return
    disposeEffectBound = true
    inner.effect(() => disposeAll)
  }

  /**
   * Register the preset of a colleague created through `/colleague new`.
   * @param {EmployeeSummary} created
   * @returns {Promise<void>}
   */
  const registerCreated = async (created) => {
    if (!presets) return
    try {
      const old = presetDisposers.get(created.slug)
      if (old !== undefined) {
        await old()
        presetDisposers.delete(created.slug)
      }
      const summary = await registerOne(created)
      void note({ event: 'created', employee: created.slug, rows: summary.rows, deny: summary.deny })
    } catch (error) {
      warn(ctx, '注册「' + created.slug + '」的预设失败：' + describeError(error))
      void note({ event: 'created-failed', employee: created.slug, error: describeError(error) })
    }
  }

  /**
   * Register the presets of the colleagues that already exist.
   * @returns {Promise<void>}
   */
  const registerLoaded = async () => {
    let employees
    try {
      employees = await store.list()
    } catch (error) {
      warn(ctx, '读取同事列表失败（' + describeError(error) + '），本次不注册同事预设')
      void note({ event: 'list-failed', error: describeError(error) })
      return
    }

    if (employees.length === 0) {
      void note({ event: 'empty', employees: 0 })
      return
    }

    let maxRows = 0
    let maxDeny = 0
    let failed = 0
    for (const employee of employees) {
      try {
        const summary = await registerOne(employee)
        maxRows = Math.max(maxRows, summary.rows)
        maxDeny = Math.max(maxDeny, summary.deny)
      } catch (error) {
        failed += 1
        warn(ctx, '注册「' + employee.slug + '」的预设失败：' + describeError(error))
        void note({ event: 'loaded-failed', employee: employee.slug, error: describeError(error) })
      }
    }
    void note({ event: 'loaded', employees: employees.length, maxRows, maxDeny, failed })
  }

  /**
   * Bind the `agentPresets` service when it appears (startup ordering) and
   * register the existing colleagues' presets once.
   * @param {*} inner
   * @param {*} [service]
   * @returns {Promise<void>}
   */
  const bindPresets = async (inner, service) => {
    if (presetsBound) return
    const resolved = service ?? (typeof inner?.get === 'function' ? inner.get('agentPresets') : undefined)
    if (!resolved || typeof resolved.register !== 'function') {
      warn(ctx, '没有 agentPresets 服务，跳过同事预设注册')
      void note({ event: 'presets-missing' })
      return
    }
    presetsBound = true
    presets = resolved
    bindDisposeEffect(inner)
    await registerLoaded()
  }

  /**
   * Mount the console routes on the harness web server. The web server is
   * optional (a CLI session has none), so this goes through `ctx.inject` and
   * never blocks the plugin load; the `scope.effect` makes unload dispose the
   * registrations in reverse order.
   * @returns {void}
   */
  const mountConsole = () => {
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (scope) => {
      try {
        // The web server can arrive before a Workspace service exists; resolve it
        // per request so the panel degrades to an empty list instead of failing.
        const workspaceRegistry = () => {
          try {
            return typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
          } catch {
            return undefined
          }
        }
        const routes = createPanelRoutes({
          store,
          allow: (request) => isConsoleRequestAllowed(ctx, request),
          onCreate: (created) => registerCreated(created),
          logger: ctx.logger,
          packs,
          onKitChange: (slug, kit) => saveKitFor(slug, kit),
          listWorkspaces: () => {
            const registry = workspaceRegistry()
            if (!registry || typeof registry.list !== 'function') return []
            return registry.list().map((workspace) => ({
              id: String(workspace.id),
              path: String(workspace.path),
              title: basename(String(workspace.path)),
            }))
          },
          workspacePath: (id) => {
            const registry = workspaceRegistry()
            if (!registry || typeof registry.get !== 'function') return undefined
            return registry.get(id)?.path
          },
        })
        scope.effect(() => {
          const releases = routes.map((route) => scope.webServer.register(route))
          return () => {
            for (const release of releases.splice(0)) release()
          }
        }, 'whalebuddy: console routes')
        ctx.logger.info('whalebuddy console mounted (%s)', ROUTES.state)
        void note({ event: 'console', routes: routes.length })
      } catch (error) {
        warn(ctx, `注册同事控制台失败：${describeError(error)}`)
        void note({ event: 'console-failed', error: describeError(error) })
      }
    })
  }

  // Bind synchronously when the service is already visible: the disposal
  // effect registers before the command effect, so unload disposes presets
  // in the same order as the previous releases.
  const visible = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  const visibleNow = Boolean(visible) && typeof visible.register === 'function'
  if (visibleNow) {
    presetsBound = true
    presets = visible
    bindDisposeEffect(ctx)
  }

  /**
   * Persist a kit and re-register that colleague's preset. Existing sessions
   * keep the revision they started with; the next session picks up the new one.
   * @param {string} slug
   * @param {string[]} kit
   * @returns {Promise<string[]>}
   */
  const saveKitFor = async (slug, kit) => {
    const employees = await store.list()
    const employee = employees.find((entry) => entry.slug === slug)
    if (employee === undefined) throw new Error('no colleague named "' + slug + '"')
    const saved = await store.setKit(slug, normalizeKit(kit, packs))
    const old = presetDisposers.get(slug)
    if (old !== undefined) {
      await old()
      presetDisposers.delete(slug)
    }
    await registerOne(employee)
    try {
      await appendChange(store, slug, '工具箱', saved.join('、'))
    } catch {
      // The kit is saved; a changelog failure must not undo it.
    }
    return saved
  }

  /**
   * Tools register in bundle order: a colleague's preset can be registered
   * before the browser/review/Office plugins have added their tools, which
   * would leave those names out of her deny set. Every tools/change event
   * recomputes each colleague's deny set and re-registers only the colleagues
   * whose set actually moved, so the gate converges instead of freezing the
   * surface seen at load. Debounced, serialized, and a no-op while unbound.
   */
  let gateChain = Promise.resolve()
  const runGateRefresh = async () => {
    if (presets === null) return
    let employees
    try {
      employees = await store.list()
    } catch {
      return
    }
    for (const employee of employees) {
      try {
        const deny = await toolDenyFor(employee)
        if (denySignatures.get(employee.slug) === deny.join('\u0000')) continue
        const old = presetDisposers.get(employee.slug)
        if (old !== undefined) {
          await old()
          presetDisposers.delete(employee.slug)
        }
        await registerOne(employee)
        void note({ event: 'gate-refreshed', employee: employee.slug, deny: deny.length })
      } catch (error) {
        warn(ctx, '刷新「' + employee.slug + '」的工具门失败：' + describeError(error))
      }
    }
  }
  const refreshToolGates = () => {
    gateChain = gateChain.then(runGateRefresh, runGateRefresh)
    return gateChain
  }

  let gateTimer
  const scheduleGateRefresh = () => {
    if (gateTimer !== undefined) clearTimeout(gateTimer)
    gateTimer = setTimeout(() => {
      gateTimer = undefined
      void refreshToolGates()
    }, 150)
  }
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('tools/change', scheduleGateRefresh)
      return () => {
        if (gateTimer !== undefined) clearTimeout(gateTimer)
        if (typeof off === 'function') off()
      }
    })
  }

  const command = createEmployeeCommand(store, {
    onCreated: (created) => registerCreated(created),
    logger: ctx.logger,
    packs,
    readKit: async (slug) => {
      const employees = await store.list()
      const employee = employees.find((entry) => entry.slug === slug)
      if (employee === undefined) throw new Error('no colleague named "' + slug + '"')
      return kitFor(employee)
    },
    writeKit: (slug, kit) => saveKitFor(slug, kit),
  })
  ctx.effect(() => ctx.commands.register(command))
  mountConsole()

  // Directories are the truth and index.json is only a cache: reconcile once at
  // load so a colleague directory copied in still gets its preset row.
  try {
    const repaired = await store.repair()
    if (repaired.changed) {
      void note({ event: 'repaired', employees: repaired.employees.length })
      if (typeof ctx.logger?.info === 'function') {
        ctx.logger.info('whalebuddy index rebuilt (%d colleagues)', repaired.employees.length)
      }
    }
  } catch (error) {
    warn(ctx, `修复同事索引失败：${describeError(error)}`)
    void note({ event: 'repair-failed', error: describeError(error) })
  }

  if (visibleNow) {
    await registerLoaded()
    return
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], (inner) => {
      void bindPresets(inner)
    })
    return
  }

  warn(ctx, '没有 agentPresets 服务，跳过同事预设注册')
  void note({ event: 'presets-missing' })
}
