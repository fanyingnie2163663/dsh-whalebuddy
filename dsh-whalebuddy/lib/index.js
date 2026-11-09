import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from 'schemastery'
import { createQueue, mergeExtraction, ruleExtractor } from './distill.js'
import { assembleMemory } from './inject.js'
import { DEFAULT_NAMES } from './names.js'
import { registerEmployeePresets, resolveTemplateRows } from './presets.js'
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
 */

export const name = 'dsh-whalebuddy'
export const inject = ['commands', 'systemPrompt']
export const Config = Schema.object({
  dataDir: Schema.string().default(''),
  presetRows: Schema.array(Schema.any()).default([]),
  // Set by a colleague preset (`config: { employee: '<slug>' }`); empty on the
  // profile-level load, which owns the command and the preset registry.
  employee: Schema.string().default(''),
})

const COMMAND_NAME = 'colleague'
const COMMAND_DESCRIPTION = '创建或列出同事'
const COMMAND_HINT = 'new <名字> | ls'
const USAGE = '用法：/colleague new <名字> | ls'
const MISSING_NAME = '给个名字：/colleague new 小白'
const EMPTY_LIST = '还没有同事：/colleague new 小白'
const UNNAMED_ROLE = '未定'
const DEFAULT_AUTONOMY = 'L2'
const DATA_DIR_NAME = 'whalebuddy'
/** The prompt section a preset-scoped instance owns. */
const MEMORY_SECTION_NAME = 'whalebuddy:memory'
/** Cut-in slot when the harness cannot order `HARNESS_IDENTITY`. */
const FALLBACK_MEMORY_ORDER = 1000
const HARNESS_IDENTITY_SECTION = 'HARNESS_IDENTITY'
/** `_shared/` sits beside the employee directories, not inside one. */
const SHARED_SLUG = '_shared'
const SHARED_USER_FILE = 'user.md'
/** `/collect` exists only in a preset-scoped instance (ruling R9). */
const COLLECT_COMMAND_NAME = 'collect'
const COLLECT_COMMAND_DESCRIPTION = '收工：把这次会话里值得留下的写进记忆'
const COLLECT_SUCCESS = '收工了。'
const COLLECT_EMPTY = '这个会话没攒到可收的文字。'
/** Message event types that feed the transcript buffer. */
const MESSAGE_EVENT_TYPES = ['user/message', 'assistant/message']
/** Only the newest 8000 transcript characters are distilled on command. */
const TRANSCRIPT_LIMIT = 8000
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

/** @type {null | (() => Promise<string>)} */
let memoryRefresher = null

/**
 * Refresh the memory of the active preset-scoped instance. `/收工` calls this
 * after writing the distilled memory back, so the next assembly sees it. A
 * profile-level load has no scoped instance, so this is a no-op there.
 * @returns {Promise<string | undefined>}
 */
export async function refreshMemory() {
  if (memoryRefresher === null) return undefined
  return memoryRefresher()
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
  const [profile, rapport, knowledge, hot, tasks, shared] = await Promise.all([
    readMemoryText(store, employee, 'profile.md'),
    readMemoryText(store, employee, 'memory/rapport.md'),
    readMemoryText(store, employee, 'memory/knowledge.md'),
    readMemoryText(store, employee, 'memory/hot.md'),
    store.tasks(employee),
    readMemoryText(store, SHARED_SLUG, SHARED_USER_FILE),
  ])
  return { profile, rapport, knowledge, hot, tasks, shared }
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
  const content = event?.data?.message?.content
  if (typeof content === 'string') {
    buffer.push({ role, text: content })
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') buffer.push({ role, text: block.text })
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
  await store.write(employee, rel, head === '' ? `${entry}\n` : `${head}\n\n${entry}\n`)
}

/**
 * @typedef {object} CollectCommandOptions
 * @property {Store} store
 * @property {string} employee
 * @property {{ push(slug: string, task: () => Promise<void>): Promise<void> }} queue
 * @property {TranscriptBlock[]} transcript
 * @property {() => Promise<string>} refresh
 */

/**
 * Build `/collect` for one preset-scoped instance. It distills the newest tail
 * of the buffered transcript, writes knowledge/rapport/tasks/hot plus the day's
 * log, then calls this instance's local `refresh` — never the module-scope
 * singleton (ruling R9). The full role-tagged record is passed to the extractor
 * so the report is the newest assistant message even when the 8000-character
 * tail cap cuts it off. The buffer is cleared only after a successful write, so
 * a failure can be retried.
 * @param {CollectCommandOptions} options
 * @returns {{ name: string, description: string, handler: () => Promise<CommandResult> }}
 */
export function createCollectCommand({ store, employee, queue, transcript, refresh }) {
  return {
    name: COLLECT_COMMAND_NAME,
    description: COLLECT_COMMAND_DESCRIPTION,
    async handler() {
      const joined = transcript.map((block) => block.text).join('\n\n').trim()
      const text = joined.slice(-TRANSCRIPT_LIMIT)
      if (text === '') return { kind: 'error', text: COLLECT_EMPTY }

      const extraction = ruleExtractor(text, transcript)
      try {
        await queue.push(employee, async () => {
          const [hot, rapport, knowledge, tasks] = await Promise.all([
            readMemoryText(store, employee, 'memory/hot.md'),
            readMemoryText(store, employee, 'memory/rapport.md'),
            readMemoryText(store, employee, 'memory/knowledge.md'),
            store.tasks(employee),
          ])
          const stamp = todayStamp()
          const merged = mergeExtraction({ hot, rapport, knowledge, tasks }, extraction, stamp)

          await store.write(employee, 'memory/knowledge.md', merged.knowledge)
          await store.write(employee, 'memory/rapport.md', merged.rapport)
          await store.saveTasks(employee, merged.tasks)
          await store.write(employee, 'memory/hot.md', merged.hot)
          if (merged.logEntry !== '') await appendLog(store, employee, stamp, merged.logEntry)
          await refresh()
        })
      } catch (error) {
        return { kind: 'error', text: `收工失败：${describeError(error)}` }
      }

      transcript.length = 0
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
 * @param {{ dataDir?: string, employee?: string }} config
 * @param {string} employee
 * @returns {Promise<void>}
 */
async function applyScoped(ctx, config, employee) {
  const root = resolveDataDir(ctx, config)
  const store = createStore(root)
  const systemPrompt = ctx?.systemPrompt

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

  memoryRefresher = refresh
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (memoryRefresher === refresh) memoryRefresher = null
    })
  }

  /**
   * Role-tagged text of real messages; `/collect` joins and clears it.
   * @type {TranscriptBlock[]}
   */
  const transcript = []
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('session/event', (session, event) => recordTranscript(transcript, event))
    } catch (error) {
      warn(ctx, `监听 session/event 失败：${describeError(error)}`)
    }
    try {
      ctx.on('turn/start', () => {
        void refresh()
      })
    } catch (error) {
      warn(ctx, `监听 turn/start 失败：${describeError(error)}`)
    }
  }

  const command = createCollectCommand({ store, employee, queue: collectQueue, transcript, refresh })
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
      text: () => cached,
    })
  } catch (error) {
    warn(ctx, `注册记忆段失败：${describeError(error)}`)
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
 * @param {{ dataDir?: string, presetRows?: PresetRow[], employee?: string }} config
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

  const agentPresets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  const presetsAvailable = Boolean(agentPresets) && typeof agentPresets.register === 'function'

  /** @type {Array<() => Promise<void>>} */
  const disposers = []
  /** @type {Promise<PresetRow[]> | undefined} */
  let templateRows

  /**
   * Resolve the template rows once; load-time and per-create registration share
   * the same promise, so the preset document is never read twice.
   * @returns {Promise<PresetRow[]>}
   */
  const resolveRowsOnce = () => {
    templateRows ??= resolveTemplateRows(agentPresets, presetRowsOf(config))
    return templateRows
  }

  if (presetsAvailable) {
    ctx.effect(() => async () => {
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose()
        } catch (error) {
          warn(ctx, `注销同事预设失败：${describeError(error)}`)
        }
      }
    })
  }

  /**
   * Register the preset of a colleague created through `/colleague new`,
   * reusing the template rows resolved for the load-time path.
   * @param {EmployeeSummary} employee
   * @returns {Promise<void>}
   */
  const registerCreated = async (employee) => {
    const dispose = await registerEmployeePresets(
      agentPresets,
      [employee],
      await resolveRowsOnce(),
      ctx.logger,
      root,
    )
    disposers.push(dispose)
  }

  const command = createEmployeeCommand(store, {
    onCreated: presetsAvailable ? registerCreated : undefined,
    logger: ctx.logger,
  })
  ctx.effect(() => ctx.commands.register(command))

  let employees
  try {
    employees = await store.list()
  } catch (error) {
    warn(ctx, `读取同事列表失败（${describeError(error)}），本次不注册同事预设`)
    return
  }

  if (!presetsAvailable) {
    warn(ctx, '没有 agentPresets 服务，跳过同事预设注册')
    return
  }

  // A fresh install has nothing to register, so it also skips resolving the
  // template document; the first created colleague resolves it exactly once.
  if (employees.length === 0) return

  const rows = await resolveRowsOnce()
  if (rows.length === 0) warn(ctx, '同事预设没有模板行，只含 Whalebuddy 自身')

  disposers.push(await registerEmployeePresets(agentPresets, employees, rows, ctx.logger, root))
}
