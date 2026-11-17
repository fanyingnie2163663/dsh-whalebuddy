/**
 * The shared work board (_shared/board.md) is the one place a task's state
 * actually lives. The panel reads it; nothing in this module writes it.
 *
 * The board is hand-written Markdown, so parsing is deliberately forgiving:
 * a row with the wrong number of columns, an empty cell, or a status outside
 * the four fixed words is skipped and counted rather than thrown. The count is
 * shown to the owner so a broken row cannot disappear silently.
 *
 * @module dsh-whalebuddy/host/board
 */

/** The four task states, spelling fixed by the design. */
export const BOARD_STATES = Object.freeze(['待接', '在做', '已交', '打回'])

/** Status cells only accept these; \`已定\` is a decision, not a task. */
const STATUS = new Set(BOARD_STATES)

/** The table header, in the only order the board uses. */
const HEADER = Object.freeze(['状态', '谁', '什么', '时间'])

/** A Markdown alignment row: \`---\`, \`:---:\`, ... */
const SEPARATOR = /^:?-{3,}:?$/

/**
 * @typedef {object} TaskRow
 * @property {'待接'|'在做'|'已交'|'打回'} status
 * @property {string} who
 * @property {string} what
 * @property {string} time
 */

/**
 * @typedef {object} TasksView
 * @property {TaskRow[]} rows
 * @property {number} badRows
 */

/**
 * Split one table line into cells, or return null when it is not a table line.
 * The outer pipes are structural; everything between them is data.
 * @param {string} line
 * @returns {string[] | null}
 */
function cellsOf(line) {
  const trimmed = line.trim()
  if (trimmed.charAt(0) !== '|') return null
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * Parse the board into rows the panel can render.
 *
 * Never throws, including for null, undefined, or a board that is not a table.
 * @param {unknown} text
 * @returns {TasksView}
 */
export function parseBoard(text) {
  const source = typeof text === 'string' ? text : ''
  const rows = []
  let badRows = 0
  let seenTable = false

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    // The table is the first section. A later \`## \` heading is a different
    // document (decisions, notes) and must not be parsed as more tasks.
    if (trimmed.startsWith('## ')) {
      if (seenTable) break
      continue
    }
    const cells = cellsOf(line)
    if (cells === null) continue
    seenTable = true

    // Header and alignment rows are structure, not data.
    if (cells.length === HEADER.length && cells.every((cell, index) => cell === HEADER[index])) continue
    if (cells.length > 0 && cells.every((cell) => SEPARATOR.test(cell))) continue

    if (
      cells.length !== HEADER.length ||
      cells.some((cell) => cell === '') ||
      !STATUS.has(cells[0])
    ) {
      badRows += 1
      continue
    }

    rows.push({
      status: /** @type {TaskRow['status']} */ (cells[0]),
      who: cells[1],
      what: cells[2],
      time: cells[3],
    })
  }

  return { rows, badRows }
}
