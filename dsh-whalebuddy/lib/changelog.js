/**
 * Append-only memory change log: which surface changed what, when, and why.
 * It is for the owner to read; it is never injected into the prompt.
 * @module dsh-whalebuddy/changelog
 */

const CHANGELOG_FILE = 'memory/changelog.md'

/**
 * Local `YYYY-MM-DD HH:MM` stamp, matching the memory files' date style.
 * @param {Date} [date]
 * @returns {string}
 */
export function changeStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Append one change line. Existing lines are never rewritten.
 * @param {import('./store.js').Store} store
 * @param {string} slug
 * @param {string} source surface that made the change, e.g. 收工 / 控制台
 * @param {string} what one-line description
 * @returns {Promise<void>}
 */
export async function appendChange(store, slug, source, what) {
  const previous = (await store.read(slug, CHANGELOG_FILE)) ?? ''
  const head = previous.trimEnd()
  const line = `- [${changeStamp()}] ${source}：${what}`
  await store.write(slug, CHANGELOG_FILE, head === '' ? `${line}\n` : `${head}\n${line}\n`)
}
