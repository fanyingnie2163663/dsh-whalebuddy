/**
 * User-facing notices: the short notes a colleague leaves after working.
 * Pure on purpose — no I/O, no clock; callers pass `now`/`at`, so the panel,
 * the collector and the tests share one implementation.
 *
 * @module dsh-whalebuddy/notices
 */

/** Where one colleague's notices live, relative to the colleague directory. */
export const NOTICE_FILE = 'memory/notices.json'

/** The daily cap when the colleague never chose one. */
export const DEFAULT_NOTICE_CAP = 2

/** The smallest and largest cap the console accepts. */
export const NOTICE_CAP_MIN = 1
export const NOTICE_CAP_MAX = 5

/**
 * @typedef {object} Notice
 * @property {string} id
 * @property {number} at
 * @property {'collect'} kind
 * @property {string} text
 * @property {string} detail
 * @property {number} [readAt]
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNoticeCap(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= NOTICE_CAP_MIN &&
    value <= NOTICE_CAP_MAX
  )
}

/**
 * Parse `memory/notices.json`. A broken file, a non-array, or a malformed row
 * never throws: the console shows what it can and the collector keeps working.
 * @param {unknown} value
 * @returns {Notice[]}
 */
export function parseNotices(value) {
  let parsed
  try {
    parsed = JSON.parse(typeof value === 'string' ? value : '')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  /** @type {Notice[]} */
  const out = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    if (typeof item.id !== 'string' || item.id === '') continue
    if (typeof item.at !== 'number' || !Number.isFinite(item.at)) continue
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    /** @type {Notice} */
    const notice = {
      id: item.id,
      at: item.at,
      kind: 'collect',
      text: item.text,
      detail: typeof item.detail === 'string' ? item.detail : '',
    }
    if (typeof item.readAt === 'number' && Number.isFinite(item.readAt)) notice.readAt = item.readAt
    out.push(notice)
  }
  return out
}

/**
 * The colleague's daily cap, or the default when the state file is missing,
 * broken, or carries a value the console would never write.
 * @param {unknown} value state.json text
 * @returns {number}
 */
export function noticeCapFromState(value) {
  let parsed
  try {
    parsed = JSON.parse(typeof value === 'string' ? value : '')
  } catch {
    return DEFAULT_NOTICE_CAP
  }
  return parsed !== null && typeof parsed === 'object' && isNoticeCap(parsed.noticeCap)
    ? parsed.noticeCap
    : DEFAULT_NOTICE_CAP
}

/**
 * @param {number} at
 * @returns {string}
 */
function dayKey(at) {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/**
 * How many notices landed on the local day containing `now`.
 * @param {Notice[]} notices
 * @param {number} now
 * @returns {number}
 */
export function todayCount(notices, now) {
  const key = dayKey(now)
  let count = 0
  for (const notice of Array.isArray(notices) ? notices : []) {
    if (notice && dayKey(notice.at) === key) count += 1
  }
  return count
}

/**
 * The first sentence of a report, keeping its terminator; capped so one paste
 * cannot become a wall of text.
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const match = /^[\s\S]*?[。！？]/u.exec(text)
  const sentence = (match === null ? text : match[0]).trim()
  return sentence.length > 80 ? sentence.slice(0, 80) : sentence
}

/**
 * Build the notice one `/collect` leaves. Silence (no summary) leaves nothing,
 * so a collect that changed no memory never rings.
 * @param {{ report?: string }} extraction
 * @param {string} summary what changed, e.g. `待办 +2`
 * @param {number} at
 * @param {string} id
 * @returns {Notice | null}
 */
export function collectNotice(extraction, summary, at, id) {
  const detail = typeof summary === 'string' ? summary.trim() : ''
  if (detail === '') return null
  const report = typeof extraction?.report === 'string' ? extraction.report.trim() : ''
  const text = report === '' ? detail : firstSentence(report) || detail
  return { id, at, kind: 'collect', text, detail }
}

/**
 * Append one notice unless the day is already at the cap. Returns `null` when
 * the cap was hit; the caller keeps the memory write either way.
 * @param {Notice[]} notices
 * @param {Notice} notice
 * @param {number} cap
 * @param {number} at
 * @returns {Notice[] | null}
 */
export function appendWithinCap(notices, notice, cap, at) {
  const list = Array.isArray(notices) ? notices : []
  if (todayCount(list, at) >= cap) return null
  return [...list, notice]
}

/**
 * Mark one notice (by id) or every unread notice as read. Existing read times
 * are kept, so two windows marking the same list stay idempotent.
 * @param {Notice[]} notices
 * @param {string | undefined} id
 * @param {number} at
 * @returns {Notice[]}
 */
export function markRead(notices, id, at) {
  const list = Array.isArray(notices) ? notices : []
  if (typeof id === 'string' && id !== '') {
    return list.map((notice) => (notice.id === id ? { ...notice, readAt: at } : notice))
  }
  return list.map((notice) => (notice.readAt === undefined ? { ...notice, readAt: at } : notice))
}

/**
 * @param {Notice[]} list
 * @returns {Notice | null}
 */
function newest(list) {
  let top = null
  for (const notice of list) {
    if (notice && (top === null || notice.at > top.at)) top = notice
  }
  return top
}

/**
 * Roll every colleague's notices into what the sidebar row needs. L1 colleagues
 * are left out entirely: switching to L1 hides the dot without losing unread.
 * @param {Array<{slug: string, name: string, autonomy: string, notices: Notice[]}>} entries
 * @returns {{unread: number, latest: {slug: string, name: string, text: string, at: number} | null, bySlug: Record<string, {unread: number, latest: {text: string, at: number} | null}>}}
 */
export function aggregateNotices(entries) {
  /** @type {Record<string, {unread: number, latest: {text: string, at: number} | null}>} */
  const bySlug = {}
  let unread = 0
  /** @type {{slug: string, name: string, text: string, at: number} | null} */
  let latest = null

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.autonomy !== 'L2' && entry.autonomy !== 'L3') continue
    const open = (Array.isArray(entry.notices) ? entry.notices : []).filter(
      (notice) => notice && notice.readAt === undefined,
    )
    const top = newest(open)
    bySlug[entry.slug] = {
      unread: open.length,
      latest: top === null ? null : { text: top.text, at: top.at },
    }
    unread += open.length
    if (top !== null && (latest === null || top.at > latest.at)) {
      latest = { slug: entry.slug, name: entry.name, text: top.text, at: top.at }
    }
  }

  return { unread, latest, bySlug }
}
