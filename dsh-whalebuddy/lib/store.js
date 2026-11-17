import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isNoticeCap } from './notices.js'

/**
 * @typedef {object} CreateEmployeeInput
 * @property {string} name
 * @property {string} role
 * @property {string} presetId
 * @property {'L1' | 'L2' | 'L3'} autonomy
 * @property {string[]} workspaces
 * @property {string} [temperament]
 */

/**
 * @typedef {object} EmployeeSummary
 * @property {string} slug
 * @property {string} name
 * @property {string} role
 * @property {string} autonomy
 * @property {number} updatedAt
 */

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} text
 * @property {string} [sourceSession]
 * @property {string} [due]
 * @property {'open' | 'done'} status
 * @property {boolean} reminded
 */

/**
 * @typedef {object} Store
 * @property {() => Promise<EmployeeSummary[]>} list
 * @property {(input: CreateEmployeeInput) => Promise<EmployeeSummary>} create
 * @property {(slug: string, autonomy: 'L1' | 'L2' | 'L3') => Promise<EmployeeSummary>} setAutonomy
 * @property {(slug: string, cap: number) => Promise<void>} setNoticeCap
 * @property {(slug: string) => Promise<Record<string, unknown>>} state
 * @property {(slug: string, kit: string[]) => Promise<string[]>} setKit
 * @property {(slug: string, rel: string) => Promise<string | undefined>} read
 * @property {(slug: string, rel: string, text: string) => Promise<void>} write
 * @property {(slug: string) => Promise<Task[]>} tasks
 * @property {(slug: string, tasks: Task[]) => Promise<void>} saveTasks
 * @property {(slug: string, options?: {limit?: number}) => Promise<Array<{ id: string, text: string }>>} orders
 * @property {() => Promise<{ employees: EmployeeSummary[], changed: boolean }>} repair
 */

/** Characters replaced by "-" when turning a name into a directory name. */
const FORBIDDEN_IN_SLUG = /[\s/\\:*?"<>|]+/g

/** A name collision is retried as "<slug>-2" .. "<slug>-50", then refused. */
const DUPLICATE_SLUG_LIMIT = 50

const FALLBACK_SLUG = 'colleague'
const FALLBACK_TEMPERAMENT = '未定'
const INDEX_FILE = 'index.json'

/** The levels the console may set; anything else is refused. */
const AUTONOMY_LEVELS = Object.freeze(['L1', 'L2', 'L3'])

/** The profile line holding the colleague's autonomy level. */
const AUTONOMY_LINE = /^-[ \t]*档位[:：][ \t]*(.*)$/m

/** Distinguishes the temp files of concurrent writers in this process. */
let tempSequence = 0

/**
 * Serialize the index read-modify-write per data root. Every store instance in
 * the process shares it, so two colleague creations cannot drop each other's
 * entry.
 * @type {Map<string, Promise<unknown>>}
 */
const indexTails = new Map()

/**
 * @template T
 * @param {string} root
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serializeIndex(root, task) {
  const previous = indexTails.get(root) ?? Promise.resolve()
  const run = previous.then(() => task())
  const tail = run.catch(() => {})
  indexTails.set(root, tail)
  void tail.then(() => {
    if (indexTails.get(root) === tail) indexTails.delete(root)
  })
  return run
}

/**
 * Turn a colleague name into a directory-safe slug.
 * NFKC -> lowercase -> separators to "-" -> collapse "-" runs -> trim "-".
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  const slug = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(FORBIDDEN_IN_SLUG, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || FALLBACK_SLUG
}

/**
 * Open the employee store rooted at `~/.dsh/whalebuddy` (or any directory).
 * Every mutation is atomic: write a private temp file beside the target, then
 * rename it into place.
 * @param {string} root
 * @returns {Store}
 */
export function createStore(root) {
  const rootDir = root

  /**
   * @param {string} file
   * @returns {Promise<string | undefined>}
   */
  async function readTextIfExists(file) {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * @param {string} file
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function writeAtomic(file, text) {
    await mkdir(dirname(file), { recursive: true })
    // A fixed `.tmp` name lets two writers collide; keep every attempt private.
    tempSequence += 1
    const temp = `${file}.${process.pid}.${tempSequence}.tmp`
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Resolve a path inside one employee directory, refusing traversal.
   * @param {string} slug
   * @param {string} rel
   * @returns {string}
   */
  function employeeFile(slug, rel) {
    if (typeof slug !== 'string' || slug === '' || slug === '.' || slug === '..' || /[\\/:]/.test(slug)) {
      throw new Error(`invalid employee slug: ${String(slug)}`)
    }
    const segments = String(rel ?? '').split(/[\\/]+/)
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`invalid path inside employee "${slug}": ${String(rel)}`)
    }
    return join(rootDir, slug, ...segments)
  }

  /**
   * Claim a fresh directory for the employee; existing directories are never reused.
   * @param {string} base
   * @returns {Promise<string>}
   */
  async function reserveSlug(base) {
    for (let attempt = 1; attempt <= DUPLICATE_SLUG_LIMIT; attempt += 1) {
      const slug = attempt === 1 ? base : `${base}-${attempt}`
      try {
        await mkdir(join(rootDir, slug))
        return slug
      } catch (error) {
        if (error?.code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error(`cannot create "${base}": all 50 candidate directories are taken`)
  }

  /** @returns {Promise<EmployeeSummary[]>} */
  async function list() {
    const raw = await readTextIfExists(join(rootDir, INDEX_FILE))
    if (raw === undefined) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.employees) ? parsed.employees : []
  }

  /**
   * Read the index without throwing: a missing or corrupt index is a cache miss,
   * and `repair` rebuilds it from the directories.
   * @returns {Promise<EmployeeSummary[]>}
   */
  async function readIndexSafely() {
    try {
      return await list()
    } catch {
      return []
    }
  }

  /**
   * Rebuild one summary from the files in its directory; `undefined` means the
   * directory is not a colleague (neither profile.md nor state.json exists).
   * @param {string} slug
   * @returns {Promise<EmployeeSummary | undefined>}
   */
  async function summaryOf(slug) {
    const dir = join(rootDir, slug)
    const profile = await readTextIfExists(join(dir, 'profile.md'))
    const state = await readTextIfExists(join(dir, 'state.json'))
    if (profile === undefined && state === undefined) return undefined

    const name = profile?.match(/^#[ \t]+(.+?)[ \t]*$/m)?.[1] ?? slug
    const role = profile?.match(/^-[ \t]*岗位[:：][ \t]*(.*?)[ \t]*$/m)?.[1] ?? ''
    let stateAutonomy = ''
    if (state !== undefined) {
      try {
        const parsed = JSON.parse(state)
        if (parsed?.autonomy === 'L1' || parsed?.autonomy === 'L2' || parsed?.autonomy === 'L3') {
          stateAutonomy = parsed.autonomy
        }
      } catch {
        // A corrupt state file falls back to the profile line.
      }
    }
    const profileAutonomy = profile?.match(/^-[ \t]*档位[:：][ \t]*(L[123])/m)?.[1] ?? ''
    const autonomy = stateAutonomy || profileAutonomy || 'L2'

    let updatedAt = 0
    for (const file of ['profile.md', 'state.json']) {
      try {
        updatedAt = Math.max(updatedAt, (await stat(join(dir, file))).mtimeMs)
      } catch {
        // A missing file contributes no timestamp.
      }
    }
    return { slug, name, role, autonomy, updatedAt }
  }

  /**
   * Reconcile `index.json` with the directories: the files are the truth and the
   * index is only a cache (design §7.2/§7.9). A colleague directory copied in
   * appears; an index row whose directory vanished is dropped; a corrupt index is
   * rebuilt from the profile files. Returns the reconciled list.
   * @returns {Promise<{ employees: EmployeeSummary[], changed: boolean }>}
   */
  async function repair() {
    return serializeIndex(rootDir, async () => {
      const indexed = await readIndexSafely()
      const entries = await readdir(rootDir, { withFileTypes: true }).catch((error) => {
        if (error?.code === 'ENOENT') return []
        throw error
      })

      /** @type {Set<string>} */
      const present = new Set()
      /** @type {EmployeeSummary[]} */
      const discovered = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const slug = entry.name
        if (slug.startsWith('.') || slug.startsWith('_')) continue
        const summary = await summaryOf(slug)
        if (summary === undefined) continue
        present.add(slug)
        if (indexed.some((employee) => employee?.slug === slug)) continue
        discovered.push(summary)
      }
      discovered.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))

      /** @type {Set<string>} */
      const seen = new Set()
      const kept = indexed.filter((employee) => {
        if (typeof employee?.slug !== 'string' || !present.has(employee.slug) || seen.has(employee.slug)) return false
        seen.add(employee.slug)
        return true
      })
      const employees = [...kept, ...discovered]
      const changed = JSON.stringify(employees) !== JSON.stringify(indexed)
      if (changed) await writeAtomic(join(rootDir, INDEX_FILE), `${JSON.stringify({ employees }, null, 2)}\n`)
      return { employees, changed }
    })
  }

  /**
   * @param {CreateEmployeeInput} input
   * @returns {Promise<EmployeeSummary>}
   */
  async function create(input) {
    const name = typeof input?.name === 'string' ? input.name : ''
    const role = String(input?.role ?? '')
    const autonomy = String(input?.autonomy ?? '')

    await mkdir(rootDir, { recursive: true })
    const slug = await reserveSlug(slugify(name))
    const dir = join(rootDir, slug)

    await mkdir(join(dir, 'memory', 'log'), { recursive: true })
    await mkdir(join(dir, 'skills'))
    await mkdir(join(dir, 'pending'))

    const workspaces = Array.isArray(input?.workspaces) ? input.workspaces.join(', ') : ''
    const temperament = typeof input?.temperament === 'string' ? input.temperament.trim() : ''
    const profile = [
      `# ${name}`,
      `- 岗位：${role}`,
      `- 档位：${autonomy}`,
      `- 工作区：${workspaces}`,
      `- 脾气：${temperament || FALLBACK_TEMPERAMENT}`,
      '',
    ].join('\n')
    await writeAtomic(join(dir, 'profile.md'), profile)

    const state = { presetId: String(input?.presetId ?? ''), autonomy }
    await writeAtomic(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)

    const summary = { slug, name, role, autonomy, updatedAt: Date.now() }
    await serializeIndex(rootDir, async () => {
      const employees = await list()
      // `repair` may have discovered this very directory while the create was in
      // flight; replace that placeholder instead of listing the colleague twice.
      const existing = employees.findIndex((employee) => employee?.slug === slug)
      if (existing === -1) employees.push(summary)
      else employees[existing] = summary
      await writeAtomic(join(rootDir, INDEX_FILE), `${JSON.stringify({ employees }, null, 2)}\n`)
    })
    return summary
  }

  /**
   * Read one colleague's state snapshot; a missing or corrupt file is an empty
   * object, so the caller fills in what it knows.
   * @param {string} slug
   * @returns {Promise<Record<string, unknown>>}
   */
  async function stateOf(slug) {
    const raw = await readTextIfExists(join(rootDir, slug, 'state.json'))
    if (raw === undefined) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * @param {string} slug
   * @param {Record<string, unknown>} state
   * @returns {Promise<void>}
   */
  async function writeState(slug, state) {
    await writeAtomic(join(rootDir, slug, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  }

  /**
   * Change one colleague's autonomy level, keeping the two places it lives in
   * agreement: the profile line the model reads, and the state snapshot the
   * index and the console read. Unknown slugs and levels are refused before
   * anything is written.
   * @param {string} slug
   * @param {'L1' | 'L2' | 'L3'} autonomy
   * @returns {Promise<EmployeeSummary>}
   */
  async function setAutonomy(slug, autonomy) {
    if (!AUTONOMY_LEVELS.includes(autonomy)) {
      throw new TypeError(`invalid autonomy: ${String(autonomy)}`)
    }
    const existing = await summaryOf(slug)
    if (existing === undefined) throw new Error(`no colleague named "${slug}"`)

    const dir = join(rootDir, slug)
    const state = await stateOf(slug)
    if (typeof state.presetId !== 'string') state.presetId = ''
    state.autonomy = autonomy
    await writeState(slug, state)

    const profile = (await readTextIfExists(join(dir, 'profile.md'))) ?? ''
    const line = `- 档位：${autonomy}`
    const trimmed = profile.trimEnd()
    const nextProfile = AUTONOMY_LINE.test(profile)
      ? profile.replace(AUTONOMY_LINE, line)
      : `${trimmed}${trimmed === '' ? '' : '\n'}${line}\n`
    await writeAtomic(join(dir, 'profile.md'), nextProfile)

    const summary = (await summaryOf(slug)) ?? {
      slug,
      name: existing.name,
      role: existing.role,
      autonomy,
      updatedAt: Date.now(),
    }
    await serializeIndex(rootDir, async () => {
      const employees = await list()
      const at = employees.findIndex((employee) => employee?.slug === slug)
      if (at === -1) employees.push(summary)
      else employees[at] = summary
      await writeAtomic(join(rootDir, INDEX_FILE), `${JSON.stringify({ employees }, null, 2)}\n`)
    })
    return summary
  }

  /**
   * Change one colleague's daily notice cap. Only the state snapshot carries
   * it: the profile template stays human-stable and the index has no cap field.
   * @param {string} slug
   * @param {number} cap
   * @returns {Promise<void>}
   */
  async function setNoticeCap(slug, cap) {
    if (!isNoticeCap(cap)) throw new TypeError(`invalid notice cap: ${String(cap)}`)
    const existing = await summaryOf(slug)
    if (existing === undefined) throw new Error(`no colleague named "${slug}"`)
    const state = await stateOf(slug)
    if (typeof state.presetId !== 'string') state.presetId = ''
    state.noticeCap = cap
    await writeState(slug, state)
  }

  /**
   * Replace one colleague's capability kit, keeping the rest of her state.
   * The kit is order-preserving, de-duplicated, and must name at least one
   * pack; an empty list is refused rather than silently resetting to default.
   * @param {string} slug
   * @param {string[]} kit
   * @returns {Promise<string[]>}
   */
  async function setKit(slug, kit) {
    const existing = await summaryOf(slug)
    if (existing === undefined) throw new Error('no colleague named "' + slug + '"')
    const next = Array.isArray(kit) ? [...new Set(kit.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))] : []
    if (next.length === 0) throw new Error('kit must name at least one pack')
    const state = await stateOf(slug)
    if (typeof state.presetId !== 'string') state.presetId = ''
    state.kit = next
    await writeState(slug, state)
    return next
  }

  /**
   * @param {string} slug
   * @param {string} rel
   * @returns {Promise<string | undefined>}
   */
  async function read(slug, rel) {
    return readTextIfExists(employeeFile(slug, rel))
  }

  /**
   * @param {string} slug
   * @param {string} rel
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function write(slug, rel, text) {
    await writeAtomic(employeeFile(slug, rel), text)
  }

  /**
   * @param {string} slug
   * @returns {Promise<Task[]>}
   */
  async function tasks(slug) {
    const raw = await read(slug, 'memory/tasks.json')
    if (raw === undefined) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error(`tasks for "${slug}" must be a JSON array`)
    return parsed
  }

  /**
   * @param {string} slug
   * @param {Task[]} tasks
   * @returns {Promise<void>}
   */
  async function saveTasks(slug, tasks) {
    if (!Array.isArray(tasks)) throw new TypeError('saveTasks expects an array of tasks')
    await write(slug, 'memory/tasks.json', `${JSON.stringify(tasks, null, 2)}\n`)
  }

  /**
   * Read a colleague's work orders: `inbox/*.md`, name order first, capped.
   * A missing inbox directory means "no orders" — a colleague without one is normal.
   * @param {string} slug
   * @param {{limit?: number}} [options]
   * @returns {Promise<Array<{ id: string, text: string }>>}
   */
  async function orders(slug, { limit = 3 } = {}) {
    const dir = join(rootDir, slug, 'inbox')
    let names
    try {
      names = await readdir(dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const picked = names.filter((name) => name.endsWith('.md')).sort().slice(0, Math.max(0, limit))
    const items = []
    for (const name of picked) {
      const text = await readTextIfExists(join(dir, name))
      if (typeof text === 'string' && text.trim() !== '') items.push({ id: name.replace(/\.md$/, ''), text: text.trim() })
    }
    return items
  }

  return { list, create, setAutonomy, setNoticeCap, state: stateOf, setKit, read, write, tasks, saveTasks, orders, repair }
}
