/**
 * The colleague console's data half: what the panel shows, and the one preview
 * that must match what a colleague really receives.
 *
 * Pure apart from the store it is handed, so the routes stay thin and the
 * behaviour is testable without a web server.
 *
 * @module dsh-whalebuddy/host/panel-data
 */
import { parseBoard } from './board.js'
import { appendChange } from '../changelog.js'
import { assembleMemory } from '../inject.js'
import { NOTICE_FILE, aggregateNotices, markRead, noticeCapFromState, parseNotices } from '../notices.js'
import { normalizeKit, packList, suggestKit } from '../packs.js'

/**
 * The only files the console may write. Anything else is refused, so a bug in
 * the client cannot turn into an arbitrary write inside the whalebuddy root.
 */
export const WRITABLE = Object.freeze([
  'profile.md',
  'memory/hot.md',
  'memory/rapport.md',
  'memory/knowledge.md',
  'memory/tasks.json',
  '_shared/roster.md',
])

/** The shared slug holding the roster; `_shared` is not a colleague. */
const SHARED_SLUG = '_shared'
const ROSTER_FILE = 'roster.md'
const USER_FILE = 'user.md'

/** The change log can grow; the panel only needs the newest slice. */
const CHANGELOG_VIEW_LIMIT = 16 * 1024

/** The profile line holding the comma-separated workspace paths. */
const WORKSPACE_LINE = /^-[ \t]*工作区[:：][ \t]*(.*)$/m

/** The profile line the raw editor can also use to change the level. */
const AUTONOMY_LINE = /^-[ \t]*档位[:：][ \t]*(L[123])(?![0-9])/m

/**
 * The autonomy level written in a profile, when it is one the console knows.
 * @param {string} [profile]
 * @returns {'L1' | 'L2' | 'L3' | undefined}
 */
function profileAutonomy(profile) {
  const match = AUTONOMY_LINE.exec(typeof profile === 'string' ? profile : '')
  return match === null ? undefined : /** @type {'L1' | 'L2' | 'L3'} */ (match[1])
}

/**
 * Parse the workspace paths recorded in one profile.
 * @param {string} [profile]
 * @returns {string[]}
 */
export function boundWorkspaces(profile) {
  const match = WORKSPACE_LINE.exec(typeof profile === 'string' ? profile : '')
  if (match === null) return []
  return match[1]
    .split(/[,，]/)
    .map((path) => path.trim())
    .filter((path) => path !== '')
}

/**
 * @param {unknown} rel
 * @returns {boolean}
 */
export function isWritable(rel) {
  return typeof rel === 'string' && WRITABLE.includes(rel)
}

/**
 * The injected-memory text for one set of files.
 *
 * Calls the very `assembleMemory` the host injects with, so the panel's preview
 * cannot drift from the real prompt.
 * @param {{profile?: string, hot?: string, recent?: string, rapport?: string, knowledge?: string, roster?: string, shared?: string}} files
 * @param {import('../store.js').Task[]} [tasks]
 * @returns {string}
 */
export function buildPreview(files, tasks = []) {
  const source = files ?? {}
  return assembleMemory({
    profile: source.profile ?? '',
    hot: source.hot ?? '',
    recent: source.recent ?? '',
    rapport: source.rapport ?? '',
    knowledge: source.knowledge ?? '',
    roster: source.roster ?? '',
    tasks: Array.isArray(tasks) ? tasks : [],
    shared: source.shared ?? '',
  })
}

/**
 * One colleague's editable files plus the preview they produce.
 * @param {import('../store.js').Store} store
 * @param {string} slug
 * @returns {Promise<{slug: string, files: Record<string, string>, bound: string[], preview: string, notices: import('../notices.js').Notice[], noticeCap: number, kit: string[]}>}
 */
export async function readColleague(store, slug) {
  const read = async (rel) => (await store.read(slug, rel)) ?? ''
  const [profile, hot, recent, rapport, knowledge, roster, shared, changelog, tasksText, stateText, noticesText] = await Promise.all([
    read('profile.md'),
    read('memory/hot.md'),
    read('memory/recent.md'),
    read('memory/rapport.md'),
    read('memory/knowledge.md'),
    (async () => (await store.read(SHARED_SLUG, ROSTER_FILE)) ?? '')(),
    (async () => (await store.read(SHARED_SLUG, USER_FILE)) ?? '')(),
    read('memory/changelog.md'),
    read('memory/tasks.json'),
    read('state.json'),
    read(NOTICE_FILE),
  ])
  let kit = []
  try {
    const state = JSON.parse(stateText)
    if (state !== null && typeof state === 'object' && Array.isArray(state.kit)) {
      kit = state.kit.filter((id) => typeof id === 'string')
    }
  } catch {
    // A corrupt state file simply has no explicit kit; the role hint applies.
  }
  const tasks = await store.tasks(slug).catch(() => [])
  const files = {
    profile,
    hot,
    recent,
    rapport,
    knowledge,
    roster,
    shared,
    changelog: changelog.slice(-CHANGELOG_VIEW_LIMIT),
    tasks: tasksText,
  }
  return {
    slug,
    files,
    bound: boundWorkspaces(profile),
    preview: buildPreview(files, tasks),
    notices: parseNotices(noticesText),
    noticeCap: noticeCapFromState(stateText),
    kit,
  }
}

/**
 * Change one colleague's daily notice cap and record it.
 * @param {import('../store.js').Store} store
 * @param {string} slug
 * @param {number} cap
 * @returns {Promise<Awaited<ReturnType<typeof readPanelState>>>}
 */
export async function changeNoticeCap(store, slug, cap) {
  await store.setNoticeCap(slug, cap)
  await appendChange(store, slug, '控制台', `上限 → ${cap} 条/天`)
  return readPanelState(store, slug)
}

/**
 * Every colleague's unread roll-up for the sidebar row; L1 colleagues are left
 * out by `aggregateNotices`.
 * @param {import('../store.js').Store} store
 * @returns {Promise<ReturnType<typeof aggregateNotices>>}
 */
export async function readNoticeSummary(store) {
  const employees = await store.list()
  const entries = []
  for (const employee of employees) {
    const raw = await store.read(employee.slug, NOTICE_FILE).catch(() => undefined)
    entries.push({
      slug: employee.slug,
      name: employee.name,
      autonomy: employee.autonomy,
      notices: parseNotices(raw),
    })
  }
  return aggregateNotices(entries)
}

/**
 * Mark one notice (by id) or all of them read, then answer with the new roll-up.
 * @param {import('../store.js').Store} store
 * @param {string} slug
 * @param {string | undefined} id
 * @param {number} [at]
 * @returns {Promise<ReturnType<typeof aggregateNotices>>}
 */
export async function markNoticesRead(store, slug, id, at = Date.now()) {
  const raw = await store.read(slug, NOTICE_FILE)
  const next = markRead(parseNotices(raw), id, at)
  await store.write(slug, NOTICE_FILE, `${JSON.stringify(next, null, 2)}\n`)
  return readNoticeSummary(store)
}

/**
 * The whole panel state for one selected colleague.
 *
 * `board` stays the raw file (the folded text view); `tasksView` is the same
 * file parsed once, and both the four-state list and the team tree render from
 * it so there is never a second parser or a second source of truth.
 * @param {import('../store.js').Store} store
 * @param {string} [slug]
 * @returns {Promise<{employees: import('../store.js').EmployeeSummary[], selected: string, colleague: Awaited<ReturnType<typeof readColleague>> | null, board: string, tasksView: import('./board.js').TasksView, kit: string[], packs: ReturnType<typeof packList>}>}
 */
export async function readPanelState(store, slug, options = {}) {
  const employees = await store.list()
  const selected = typeof slug === 'string' && slug !== '' ? slug : employees[0]?.slug ?? ''
  const packs = options.packs
  const employee = employees.find((entry) => entry.slug === selected)
  const colleague = selected === '' ? null : await readColleague(store, selected)
  const kit = packs === undefined || colleague === null
    ? []
    : normalizeKit(colleague.kit.length > 0 ? colleague.kit : suggestKit(employee?.role), packs)
  if (colleague !== null) colleague.kit = kit
  const board = await readBoard(store)
  return {
    employees,
    selected,
    colleague,
    board,
    tasksView: parseBoard(board),
    kit,
    packs: packs === undefined ? [] : packList(packs, kit),
  }
}

/**
 * Change one colleague's kit from the console, then answer with the whole
 * panel so the tab repaints from the same data the host will compile.
 * @param {import('../store.js').Store} store
 * @param {string} slug
 * @param {string[]} kit
 * @param {Map<string, import('../packs.js').Pack>} packs
 * @returns {Promise<Awaited<ReturnType<typeof readPanelState>>>}
 */
export async function changeKit(store, slug, kit, packs) {
  const saved = await store.setKit(slug, normalizeKit(kit, packs))
  await appendChange(store, slug, '工具箱', saved.join('、'))
  return readPanelState(store, slug, { packs })
}

/**
 * Read the shared work board (`_shared/board.md`). A missing board is normal.
 * @param {import('../store.js').Store} store
 * @returns {Promise<string>}
 */
async function readBoard(store) {
  try {
    const text = await store.read(SHARED_SLUG, 'board.md')
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/**
 * Save one file, then hand back the regenerated preview so the page never has
 * to reload to stay honest.
 * @param {import('../store.js').Store} store
 * @param {string} slug
 * @param {string} rel
 * @param {string} text
 * @returns {Promise<{saved: true, bound: string[], preview: string, employees: import('../store.js').EmployeeSummary[]}>}
 */
export async function saveFile(store, slug, rel, text) {
  if (!isWritable(rel)) throw new Error(`refused: ${rel} is not a console-editable file`)
  if (typeof text !== 'string') throw new Error('refused: text must be a string')
  if (text.length > 64 * 1024) throw new Error('refused: file is larger than 64 KB')
  const sharedTarget = rel.startsWith('_shared/')
  const targetSlug = sharedTarget ? SHARED_SLUG : slug
  const targetRel = sharedTarget ? rel.slice('_shared/'.length) : rel
  await store.write(targetSlug, targetRel, text)

  // The raw editor can change the level too; without this the profile would say
  // L1 while the state snapshot (and so the chip) still said L2.
  if (!sharedTarget && rel === 'profile.md') {
    const level = profileAutonomy(text)
    const current = (await store.list()).find((employee) => employee?.slug === slug)
    if (level !== undefined && current !== undefined && current.autonomy !== level) {
      await store.setAutonomy(slug, level)
    }
  }

  if (!sharedTarget) await appendChange(store, slug, '控制台', `${rel}（${text.length} 字）`)
  const colleague = await readColleague(store, slug)
  return { saved: true, bound: colleague.bound, preview: colleague.preview, employees: await store.list() }
}

/**
 * Change one colleague's autonomy level, record the change, and hand back the
 * fresh panel payload so the console can adopt the new state in one trip.
 * @param {import('../store.js').Store} store
 * @param {string} slug
 * @param {'L1' | 'L2' | 'L3'} autonomy
 * @returns {Promise<{updated: import('../store.js').EmployeeSummary, employees: import('../store.js').EmployeeSummary[], selected: string, colleague: Awaited<ReturnType<typeof readColleague>> | null}>}
 */
export async function changeAutonomy(store, slug, autonomy) {
  const updated = await store.setAutonomy(slug, autonomy)
  await appendChange(store, slug, '控制台', `档位 → ${autonomy}`)
  return { updated, ...(await readPanelState(store, slug)) }
}

/**
 * Record one workspace path in a colleague's profile, additively: no duplicate
 * paths, no reordering, and every other line is left exactly as it was.
 * @param {import('../store.js').Store} store
 * @param {string} slug
 * @param {string} path absolute workspace directory
 * @returns {Promise<{saved: true, bound: string[], preview: string}>}
 */
export async function bindWorkspace(store, slug, path) {
  const target = typeof path === 'string' ? path.trim() : ''
  if (target === '') throw new Error('refused: workspace path is required')

  const profile = (await store.read(slug, 'profile.md')) ?? ''
  const bound = boundWorkspaces(profile)
  if (!bound.includes(target)) {
    const line = `- 工作区：${[...bound, target].join(', ')}`
    const next = WORKSPACE_LINE.test(profile)
      ? profile.replace(WORKSPACE_LINE, line)
      : `${profile.trimEnd()}${profile.trimEnd() === '' ? '' : '\n'}${line}\n`
    await store.write(slug, 'profile.md', next)
    await appendChange(store, slug, '控制台', `工作区 +${target}`)
  }

  const colleague = await readColleague(store, slug)
  return { saved: true, bound: colleague.bound, preview: colleague.preview }
}
