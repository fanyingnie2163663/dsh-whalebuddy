import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NOTICE_CAP,
  aggregateNotices,
  appendWithinCap,
  collectNotice,
  isNoticeCap,
  markRead,
  noticeCapFromState,
  parseNotices,
  todayCount,
} from '../lib/notices.js'

const noon = new Date(2026, 10, 14, 12, 0, 0).getTime()
const notice = (over = {}) => ({ id: 'n1', at: noon, kind: 'collect', text: '改完了。', detail: '待办 +1', ...over })

test('parseNotices treats a broken or non-array file as empty', () => {
  assert.deepEqual(parseNotices('{not json'), [])
  assert.deepEqual(parseNotices(JSON.stringify({})), [])
  assert.deepEqual(parseNotices(undefined), [])
})

test('parseNotices keeps valid rows and drops malformed ones', () => {
  const text = JSON.stringify([notice(), { id: '', at: noon }, { id: 'x', at: 'no', text: 'y' }, 'z'])
  assert.deepEqual(parseNotices(text).map((n) => n.id), ['n1'])
})

test('only a 1..5 integer counts as a cap', () => {
  for (const value of [0, 6, 1.5, '2', null, undefined]) assert.equal(isNoticeCap(value), false)
  for (const value of [1, 2, 5]) assert.equal(isNoticeCap(value), true)
  assert.equal(DEFAULT_NOTICE_CAP, 2)
})

test('noticeCapFromState falls back to 2', () => {
  assert.equal(noticeCapFromState('{not json'), 2)
  assert.equal(noticeCapFromState('{"autonomy":"L2"}'), 2)
  assert.equal(noticeCapFromState('{"noticeCap":4}'), 4)
  assert.equal(noticeCapFromState('{"noticeCap":9}'), 2)
})

test('todayCount counts only the local day', () => {
  const list = [
    notice({ id: 'a' }),
    notice({ id: 'b' }),
    notice({ id: 'c', at: noon - 26 * 60 * 60 * 1000 }),
  ]
  assert.equal(todayCount(list, noon), 2)
})

test('collectNotice takes the first sentence of the report', () => {
  assert.deepEqual(collectNotice({ report: '改完了。还有尾巴。' }, '待办 +1', noon, 'n9'), {
    id: 'n9',
    at: noon,
    kind: 'collect',
    text: '改完了。',
    detail: '待办 +1',
  })
})

test('collectNotice falls back to the summary and refuses silence', () => {
  assert.equal(collectNotice({}, '', noon, 'x'), null)
  assert.equal(collectNotice({ report: '   ' }, '待办 +1', noon, 'y').text, '待办 +1')
})

test('appendWithinCap stops at the cap and ignores yesterday', () => {
  const old = notice({ id: 'old', at: noon - 26 * 60 * 60 * 1000 })
  const first = appendWithinCap([old], notice({ id: 'a' }), 1, noon)
  assert.equal(first.length, 2)
  assert.equal(appendWithinCap(first, notice({ id: 'b' }), 1, noon), null)
})

test('markRead marks one or all, keeping earlier read times', () => {
  const list = [notice({ id: 'a' }), notice({ id: 'b' })]
  const one = markRead(list, 'a', noon + 1000)
  assert.equal(one[0].readAt, noon + 1000)
  assert.equal(one[1].readAt, undefined)

  const all = markRead(one, undefined, noon + 3000)
  assert.equal(all[0].readAt, noon + 1000)
  assert.equal(all[1].readAt, noon + 3000)
})

test('aggregate skips L1 and reports the newest unread', () => {
  const entries = [
    { slug: 'a', name: '小白', autonomy: 'L2', notices: [notice({ id: 'a1' })] },
    { slug: 'b', name: '一角', autonomy: 'L1', notices: [notice({ id: 'b1' })] },
    {
      slug: 'c',
      name: '逆戟',
      autonomy: 'L3',
      notices: [notice({ id: 'c1', at: noon + 5000, text: '新的' }), notice({ id: 'c2', at: noon + 1000, readAt: noon + 2000 })],
    },
  ]

  const out = aggregateNotices(entries)
  assert.equal(out.unread, 2)
  assert.deepEqual(out.latest, { slug: 'c', name: '逆戟', text: '新的', at: noon + 5000 })
  assert.equal(out.bySlug.a.unread, 1)
  assert.equal(out.bySlug.b, undefined)
  assert.equal(out.bySlug.c.unread, 1)
})
