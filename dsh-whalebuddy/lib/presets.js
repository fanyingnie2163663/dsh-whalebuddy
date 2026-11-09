import { parse as parseYaml } from 'yaml'

/**
 * Where the rows around Whalebuddy's own row come from (Task 4, decisions R3/R7:
 * no live probe during P1a). `resolveTemplateRows` takes them, in order, from:
 *
 * 1. `config.presetRows` when it is a non-empty array of `{ id?, name, config? }`;
 * 2. otherwise the current default agent preset — `resolve()` for the id,
 *    `readDocument(id)` for the YAML, then `yaml.parse`: a top-level array is the
 *    row list, an object contributes its `plugins` or `rows` array;
 * 3. otherwise `[]` — `lib/index.js` then warns that the colleague preset
 *    carries Whalebuddy's own row only.
 *
 * Every thrown registry call is caught and degrades to `[]`; the template shape
 * stays unverified until the deferred T7 integration check.
 *
 * @typedef {object} PresetRow
 * @property {string} [id]
 * @property {string} name
 * @property {Record<string, unknown>} [config]
 */

/**
 * @typedef {import('./store.js').EmployeeSummary} EmployeeSummary
 */

/**
 * @typedef {object} PresetDefinition
 * @property {string} id
 * @property {string} [name]
 * @property {string} [description]
 * @property {number} [order]
 * @property {PresetRow[]} plugins
 */

/**
 * @typedef {object} PresetTemplateSource
 * @property {() => Promise<{ id?: string }>} resolve
 * @property {(id: string) => Promise<{ content?: string }>} readDocument
 */

/**
 * @typedef {object} PresetRegistry
 * @property {(definition: PresetDefinition) => Promise<() => Promise<void>>} register
 */

/**
 * @typedef {object} PresetLogger
 * @property {(message: string) => void} [warn]
 */

/** Every colleague preset sorts after the built-in presets. */
const PRESET_ORDER = 100

/** The id of Whalebuddy's own row inside a colleague preset. */
const MEMORY_PLUGIN_ID = 'whalebuddy-memory'

const PRESET_ID_PREFIX = 'whalebuddy:'
const OWN_PLUGIN_NAME = 'dsh-whalebuddy'

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {PresetLogger | undefined} logger
 * @param {string} message
 * @returns {void}
 */
function warn(logger, message) {
  if (typeof logger?.warn === 'function') logger.warn(message)
}

/**
 * Build one colleague's preset: the template rows, then Whalebuddy's own row
 * carrying the employee slug.
 * @param {EmployeeSummary} employee
 * @param {PresetRow[]} rows
 * @returns {PresetDefinition}
 */
export function buildPresetDefinition(employee, rows) {
  const slug = employee.slug
  const name = typeof employee.name === 'string' && employee.name !== '' ? employee.name : slug
  const description = typeof employee.role === 'string' ? employee.role : ''
  const templateRows = Array.isArray(rows) ? rows : []

  return {
    id: `${PRESET_ID_PREFIX}${slug}`,
    name,
    description,
    order: PRESET_ORDER,
    plugins: [
      ...templateRows,
      { id: MEMORY_PLUGIN_ID, name: OWN_PLUGIN_NAME, config: { employee: slug } },
    ],
  }
}

/**
 * Pick the row list out of a parsed preset document: a top-level array, or the
 * object's `plugins` / `rows` array.
 * @param {unknown} parsed
 * @returns {PresetRow[]}
 */
function rowsOf(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object') {
    const document = /** @type {Record<string, unknown>} */ (parsed)
    for (const key of ['plugins', 'rows']) {
      const candidate = document[key]
      if (Array.isArray(candidate)) return candidate
    }
  }
  return []
}

/**
 * Resolve the template rows a colleague preset is built around.
 * @param {PresetTemplateSource | undefined} agentPresets
 * @param {PresetRow[]} [presetRows]
 * @returns {Promise<PresetRow[]>}
 */
export async function resolveTemplateRows(agentPresets, presetRows = []) {
  if (Array.isArray(presetRows) && presetRows.length > 0) return presetRows

  try {
    const current = await agentPresets.resolve()
    const id = current?.id
    if (typeof id !== 'string' || id === '') return []
    const document = await agentPresets.readDocument(id)
    return rowsOf(parseYaml(document?.content ?? ''))
  } catch {
    return []
  }
}

/**
 * Register one preset per employee. A failed registration is logged and the
 * remaining employees are still registered; the returned disposer unregisters
 * in reverse order, each disposer awaited and individually caught.
 * @param {PresetRegistry} registry
 * @param {EmployeeSummary[]} employees
 * @param {PresetRow[]} rows
 * @param {PresetLogger} [logger]
 * @returns {Promise<() => Promise<void>>}
 */
export async function registerEmployeePresets(registry, employees, rows, logger) {
  /** @type {Array<() => Promise<void>>} */
  const disposers = []

  for (const employee of employees) {
    try {
      const dispose = await registry.register(buildPresetDefinition(employee, rows))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      warn(logger, `同事「${employee?.slug}」的预设注册失败：${describeError(error)}`)
    }
  }

  return async () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose()
      } catch (error) {
        warn(logger, `注销同事预设失败：${describeError(error)}`)
      }
    }
  }
}
