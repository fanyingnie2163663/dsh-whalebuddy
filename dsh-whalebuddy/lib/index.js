import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from 'schemastery'
import { DEFAULT_NAMES } from './names.js'
import { registerEmployeePresets, resolveTemplateRows } from './presets.js'
import { createStore } from './store.js'

/**
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
export const inject = ['commands']
export const Config = Schema.object({
  dataDir: Schema.string().default(''),
  presetRows: Schema.array(Schema.any()).default([]),
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

/**
 * Load the plugin: register `/colleague`, then one agent preset per colleague.
 * A colleague created later gets its preset registered immediately, reusing
 * the template rows resolved at load. A corrupt `index.json` only skips preset
 * registration — it never fails the plugin load. Without an `agentPresets`
 * service the command still works.
 * @param {*} ctx
 * @param {{ dataDir?: string, presetRows?: PresetRow[] }} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
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
    const dispose = await registerEmployeePresets(agentPresets, [employee], await resolveRowsOnce(), ctx.logger)
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

  disposers.push(await registerEmployeePresets(agentPresets, employees, rows, ctx.logger))
}
