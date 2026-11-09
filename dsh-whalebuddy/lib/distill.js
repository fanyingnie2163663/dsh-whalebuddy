/**
 * Distillation: turn one session's transcript into memory changes.
 *
 * Pure on purpose — no Cordis imports, no I/O, no clock. The caller passes
 * `now` and performs every read/write, so this module stays unit-testable
 * without a live harness (plan §7.5).
 *
 * @typedef {import('./store.js').Task} Task
 *
 * @typedef {object} Extraction
 * @property {string} [report] 这次做了什么（进日志）
 * @property {string[]} [promises] 她答应你的、你交办的（进 tasks.json）
 * @property {string[]} [corrections] 你纠正她的点（进默契，最高优先级）
 * @property {string[]} [facts] 项目事实、决定（进知识）
 */

/**
 * @typedef {object} MemoryState
 * @property {string} hot
 * @property {string} rapport
 * @property {string} knowledge
 * @property {Task[]} tasks
 */

/**
 * @typedef {object} MergedMemory
 * @property {string} hot
 * @property {string} rapport
 * @property {string} knowledge
 * @property {Task[]} tasks
 * @property {string} logEntry
 */

/** `hot.md` only ever keeps the newest 800 characters (design §7.2). */
export const HOT_MEMORY_LIMIT = 800

/** `ruleExtractor` keeps the first 200 characters of the final paragraph. */
const REPORT_LIMIT = 200

/** The determinism contract: one sentence per `。！？` or newline. */
const SENTENCE_BREAK = /[。！？\n]/

/** A sentence with any of these is a correction (rapport, never compressed). */
const CORRECTION_MARKERS = ['别', '不要', '以后']

/** A sentence with any of these is a promise (an open task). */
const PROMISE_MARKERS = ['答应', '记得', '帮我']

/** The `rapport.md` convention: `- [日期] 纠错：…`. */
const CORRECTION_PREFIX = '纠错：'

/** Paragraph separator used to join one session's text blocks. */
const PARAGRAPH_BREAK = /\n{2,}/

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Trimmed, non-empty strings from an optional string list.
 * @param {unknown} value
 * @returns {string[]}
 */
function textsOf(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const texts = []
  for (const entry of value) {
    const text = textOf(entry)
    if (text !== '') texts.push(text)
  }
  return texts
}

/**
 * Append `- …` lines to a Markdown file. An empty body returns the previous
 * text untouched, so an extraction that yields nothing cannot rewrite a file.
 * @param {unknown} previous
 * @param {string[]} lines
 * @returns {string}
 */
function appendLines(previous, lines) {
  const base = typeof previous === 'string' ? previous : ''
  if (lines.length === 0) return base
  const body = lines.join('\n')
  const head = base.trimEnd()
  return head === '' ? `${body}\n` : `${head}\n${body}\n`
}

/**
 * Append the report to hot memory and keep only the newest 800 characters.
 * @param {unknown} previous
 * @param {string} report
 * @returns {string}
 */
function mergeHot(previous, report) {
  const base = typeof previous === 'string' ? previous : ''
  if (report === '') return base
  const joined = base.trim() === '' ? report : `${base.trimEnd()}\n${report}`
  return joined.length <= HOT_MEMORY_LIMIT ? joined : joined.slice(-HOT_MEMORY_LIMIT)
}

/**
 * One new open task per promise. The id is deterministic (date + position) and
 * unique within the task list the caller just read, which is enough for P1a.
 * @param {string[]} promises
 * @param {string} now
 * @param {number} offset
 * @returns {Task[]}
 */
function tasksOf(promises, now, offset) {
  return promises.map((text, index) => ({
    id: `${now}-${offset + index + 1}`,
    text,
    status: /** @type {'open'} */ ('open'),
    reminded: false,
  }))
}

/**
 * Merge one extraction into the existing memory. Only-appends: no previous
 * entry is removed or rewritten except through the 800-character hot cap.
 * @param {Partial<MemoryState>} [previous]
 * @param {Extraction | undefined} extraction
 * @param {string} now `YYYY-MM-DD`
 * @returns {MergedMemory}
 */
export function mergeExtraction(previous = {}, extraction = {}, now = '') {
  const before = previous ?? {}
  const source = extraction ?? {}
  const stamp = typeof now === 'string' ? now : ''

  const report = textOf(source.report)
  const corrections = textsOf(source.corrections)
  const promises = textsOf(source.promises)
  const facts = textsOf(source.facts)
  const priorTasks = Array.isArray(before.tasks) ? before.tasks : []

  return {
    hot: mergeHot(before.hot, report),
    rapport: appendLines(
      before.rapport,
      corrections.map((correction) => `- [${stamp}] ${CORRECTION_PREFIX}${correction}`),
    ),
    knowledge: appendLines(
      before.knowledge,
      facts.map((fact) => `- ${fact}`),
    ),
    tasks: promises.length === 0 ? priorTasks : [...priorTasks, ...tasksOf(promises, stamp, priorTasks.length)],
    logEntry: report === '' ? '' : `## ${stamp}\n- ${report}`,
  }
}

/**
 * One buffered message text block, tagged with its author. `index.js` keeps
 * these while a scoped instance runs; `/collect` caps the joined text from the
 * tail but still hands the full record over so the report is the newest
 * assistant message even when the cap cuts the transcript.
 *
 * @typedef {object} TranscriptBlock
 * @property {'user' | 'assistant'} role
 * @property {string} text
 */

/**
 * The text the sentence classifier may see. With a role-tagged record only the
 * user's own words count: a live session once wrote the assistant's echo
 * (`好的，记住了：以后不用反问句`) into `rapport.md` as the user's correction.
 * A string-only caller has no roles, so it keeps the legacy transcript scan.
 * @param {string} transcript
 * @param {TranscriptBlock[] | undefined} blocks
 * @returns {string}
 */
function classifiableText(transcript, blocks) {
  if (!Array.isArray(blocks)) return transcript
  return blocks
    .filter((block) => block?.role === 'user')
    .map((block) => textOf(block?.text))
    .filter((text) => text !== '')
    .join('\n\n')
}

/**
 * The report from the newest assistant block: its first 200 characters. An
 * empty or missing record falls back to the transcript's final paragraph.
 * @param {TranscriptBlock[] | undefined} blocks
 * @returns {string}
 */
function lastAssistantReport(blocks) {
  if (!Array.isArray(blocks)) return ''
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    const text = textOf(block?.text)
    if (block?.role === 'assistant' && text !== '') return text.slice(0, REPORT_LIMIT)
  }
  return ''
}

/**
 * The P1a deterministic extractor — no model call. It splits the transcript on
 * `。！？` and newlines and classifies every sentence; the model extractor is P2.
 *
 * With the role-tagged blocks, corrections and promises come from the user
 * blocks only — the assistant's echo is never the user's correction. A
 * string-only caller has no roles and keeps the whole-transcript fallback.
 *
 * The report is the last assistant message's first 200 characters — computed
 * before any tail cap, so a long session's newest reply is never replaced by a
 * stale paragraph. Without blocks the final paragraph is the best available
 * approximation (commands are not message events, so it is normally the
 * assistant's reply).
 * @param {string} transcript
 * @param {TranscriptBlock[]} [blocks]
 * @returns {Extraction}
 */
export function ruleExtractor(transcript, blocks) {
  const text = typeof transcript === 'string' ? transcript : ''
  const sentences = classifiableText(text, blocks)
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')

  /** @type {string[]} */
  const corrections = []
  /** @type {string[]} */
  const promises = []
  for (const sentence of sentences) {
    if (CORRECTION_MARKERS.some((marker) => sentence.includes(marker))) corrections.push(sentence)
    if (PROMISE_MARKERS.some((marker) => sentence.includes(marker))) promises.push(sentence)
  }

  const paragraphs = text
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
  const fallback = (paragraphs.length === 0 ? '' : paragraphs[paragraphs.length - 1]).slice(0, REPORT_LIMIT)
  const report = lastAssistantReport(blocks) || fallback

  return { report, corrections, promises }
}

/**
 * Serialize writes per employee: `push` chains a task after every earlier task
 * for the same slug and returns that task's own promise. The module-level
 * queue in `index.js` is shared by every scoped instance, so two sessions of
 * the same colleague can never interleave their read-modify-write.
 * @returns {{ push(slug: string, task: () => Promise<void>): Promise<void> }}
 */
export function createQueue() {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map()

  return {
    /**
     * @param {string} slug
     * @param {() => Promise<void>} task
     * @returns {Promise<void>}
     */
    push(slug, task) {
      const key = String(slug)
      const previous = tails.get(key) ?? Promise.resolve()
      const run = previous.then(() => task())
      const tail = run.catch(() => {})
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return run
    },
  }
}
