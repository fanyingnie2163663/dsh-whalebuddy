import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
 * @property {(slug: string, rel: string) => Promise<string | undefined>} read
 * @property {(slug: string, rel: string, text: string) => Promise<void>} write
 * @property {(slug: string) => Promise<Task[]>} tasks
 * @property {(slug: string, tasks: Task[]) => Promise<void>} saveTasks
 */

/** Characters replaced by "-" when turning a name into a directory name. */
const FORBIDDEN_IN_SLUG = /[\s/\\:*?"<>|]+/g

/** A name collision is retried as "<slug>-2" .. "<slug>-50", then refused. */
const DUPLICATE_SLUG_LIMIT = 50

const FALLBACK_SLUG = 'colleague'
const FALLBACK_TEMPERAMENT = '未定'
const INDEX_FILE = 'index.json'

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
 * Every mutation is atomic: write `<file>.tmp`, then rename it into place.
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
    const temp = `${file}.tmp`
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
    const employees = await list()
    employees.push(summary)
    await writeAtomic(join(rootDir, INDEX_FILE), `${JSON.stringify({ employees }, null, 2)}\n`)
    return summary
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

  return { list, create, read, write, tasks, saveTasks }
}
