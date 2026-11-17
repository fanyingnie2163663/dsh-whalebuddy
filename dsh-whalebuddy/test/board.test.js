import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_STATES, parseBoard } from '../lib/host/board.js'

const TABLE = [
  '# 工作板',
  '',
  '| 状态 | 谁 | 什么 | 时间 |',
  '|---|---|---|---|',
  '| 待接 | 座头 | 审一遍 P1 的改动 | 2026-11-18 |',
  '| 在做 | 座头 | 把周报卡的底稿改成 720 宽 | 2026-11-18 14:05 |',
  '| 已交 | 一角 | 出天气卡的 BRIEF | 2026-11-17 18:20 |',
  '| 打回 | 弓头 | 关心版的三层引擎 | 2026-11-17 |',
].join('\n')

test('the four states parse in board order', () => {
  const view = parseBoard(TABLE)

  assert.equal(view.badRows, 0)
  assert.deepEqual(view.rows, [
    { status: '待接', who: '座头', what: '审一遍 P1 的改动', time: '2026-11-18' },
    { status: '在做', who: '座头', what: '把周报卡的底稿改成 720 宽', time: '2026-11-18 14:05' },
    { status: '已交', who: '一角', what: '出天气卡的 BRIEF', time: '2026-11-17 18:20' },
    { status: '打回', who: '弓头', what: '关心版的三层引擎', time: '2026-11-17' },
  ])
  assert.deepEqual(view.rows.map((row) => row.status), BOARD_STATES)
})

test('an unknown status is skipped and counted, never treated as a fifth state', () => {
  const view = parseBoard(TABLE.replace('| 打回 | 弓头 |', '| 已定 | 弓头 |'))

  assert.equal(view.rows.length, 3)
  assert.equal(view.rows.some((row) => row.status === '已定'), false)
  assert.equal(view.badRows, 1)
})

test('a row with missing columns is skipped and counted', () => {
  const view = parseBoard(TABLE.replace('| 待接 | 座头 | 审一遍 P1 的改动 | 2026-11-18 |', '| 待接 | 座头 |'))

  assert.equal(view.rows.length, 3)
  assert.equal(view.badRows, 1)
})

test('an empty cell is a bad row, not a task with no owner', () => {
  const view = parseBoard(TABLE.replace('| 待接 | 座头 |', '| 待接 |  |'))

  assert.equal(view.rows.length, 3)
  assert.equal(view.badRows, 1)
})

test('a decision section after the table is not parsed and not counted', () => {
  const view = parseBoard(
    TABLE +
      '\n\n## 已定（不算状态，不进图）\n\n' +
      '| 状态 | 谁 | 什么 | 时间 |\n' +
      '|---|---|---|---|\n' +
      '| 已定 | 蓝鲸 | 卡片口径：主标题 ≤9 字 | 2026-11-18 |\n',
  )

  assert.equal(view.rows.length, 4)
  assert.equal(view.badRows, 0)
})

test('header, alignment row, prose, CRLF and an empty board never throw', () => {
  const crlf = TABLE.replace(/\n/g, '\r\n')
  assert.equal(parseBoard(crlf).rows.length, 4)
  assert.equal(parseBoard('# 工作板\n\n没有表格。').rows.length, 0)
  assert.equal(parseBoard('').badRows, 0)
  assert.equal(parseBoard(null).rows.length, 0)
  assert.equal(parseBoard(undefined).badRows, 0)
  assert.equal(parseBoard(42).rows.length, 0)
})
