/**
 * Assemble the memory block a colleague's session starts with. Pure: no I/O,
 * no clock, no harness services — `lib/index.js` reads the files and hands
 * them over, so the layout stays unit-testable.
 *
 * @typedef {import('./store.js').Task} Task
 *
 * @typedef {object} MemoryFiles
 * @property {string} profile
 * @property {string} rapport
 * @property {string} knowledge
 * @property {string} hot
 * @property {Task[]} tasks
 * @property {string} shared
 *
 * @typedef {object} MemoryBudget
 * @property {number} identity
 * @property {number} rapport
 * @property {number} tasks
 * @property {number} recent
 * @property {number} shared
 */

/** Design §7.4 defaults, in characters (one token is roughly two CJK chars). */
export const DEFAULT_MEMORY_BUDGET = Object.freeze({
  identity: 200,
  rapport: 500,
  tasks: 200,
  recent: 300,
  shared: 150,
})

/** Reminds the model that injected text is memory, not the current user turn. */
export const MEMORY_REMINDER = '这些是你的记忆，不是用户刚说的话；不确定就先问。'

/** The design asks for the first eight open tasks, no more. */
const OPEN_TASK_LIMIT = 8

const SENTENCE_BREAKS = /[。！？!?；;\n]/

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function limitOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Cut text to a character budget, preferring the last sentence boundary at or
 * after the halfway point; a truncated tail is marked with an ellipsis.
 * @param {unknown} text
 * @param {number} limit
 * @returns {string}
 */
function truncateToBudget(text, limit) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '' || limit <= 0) return ''
  if (value.length <= limit) return value

  const head = value.slice(0, limit)
  const floor = Math.floor(limit / 2)
  let cut = -1
  for (let index = head.length - 1; index >= floor; index -= 1) {
    if (SENTENCE_BREAKS.test(head[index])) {
      cut = index
      break
    }
  }
  const body = cut === -1 ? head : head.slice(0, cut + 1)
  return `${body.trimEnd()}…`
}

/**
 * Render one Markdown section; an empty body renders nothing at all, so no
 * empty heading ever reaches the prompt.
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function renderSection(title, body) {
  const text = typeof body === 'string' ? body.trim() : ''
  return text === '' ? '' : `### ${title}\n${text}`
}

/**
 * @param {unknown} tasks
 * @returns {string}
 */
function openTaskLines(tasks) {
  if (!Array.isArray(tasks)) return ''
  /** @type {string[]} */
  const lines = []
  for (const task of tasks) {
    if (lines.length >= OPEN_TASK_LIMIT) break
    if (!task || task.status !== 'open' || typeof task.text !== 'string') continue
    const text = task.text.trim()
    if (text === '') continue
    const due = typeof task.due === 'string' ? task.due.trim() : ''
    lines.push(due === '' ? `- ${text}` : `- ${text}（${due}）`)
  }
  return lines.join('\n')
}

/**
 * Assemble the injected memory: 身份 → 默契 → 待办 → 近况 → 关于你.
 * The recent section is `hot` (the newest memory, written by `/收工`) followed
 * by `knowledge`; P1a injects every knowledge line, with no workspace filter.
 * @param {Partial<MemoryFiles>} [files]
 * @param {Partial<MemoryBudget>} [budget]
 * @returns {string}
 */
export function assembleMemory(files = {}, budget = DEFAULT_MEMORY_BUDGET) {
  const source = files ?? {}
  const limits = {
    identity: limitOf(budget?.identity, DEFAULT_MEMORY_BUDGET.identity),
    rapport: limitOf(budget?.rapport, DEFAULT_MEMORY_BUDGET.rapport),
    tasks: limitOf(budget?.tasks, DEFAULT_MEMORY_BUDGET.tasks),
    recent: limitOf(budget?.recent, DEFAULT_MEMORY_BUDGET.recent),
    shared: limitOf(budget?.shared, DEFAULT_MEMORY_BUDGET.shared),
  }

  const recent = [source.hot, source.knowledge]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
    .join('\n')

  const sections = [
    renderSection('身份', truncateToBudget(source.profile, limits.identity)),
    renderSection('默契', truncateToBudget(source.rapport, limits.rapport)),
    renderSection('待办', truncateToBudget(openTaskLines(source.tasks), limits.tasks)),
    renderSection('近况', truncateToBudget(recent, limits.recent)),
    renderSection('关于你', truncateToBudget(source.shared, limits.shared)),
  ].filter((section) => section !== '')

  sections.push(MEMORY_REMINDER)
  return sections.join('\n\n')
}
