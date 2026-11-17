// 分配工作区：把某个目录绑给一位同事。只有档案里写了「权限：…分配」的同事能用。
// 写档案的那一段复用控制台的 bindWorkspace，保证两个入口写出来的是同一行。
import { bindWorkspace } from './host/panel-data.js'

/** 档案里的一行：`- 权限：分配工作区`；同一行里多写几项也算。 */
export const ASSIGN_PERMISSION = /^-[ \t]*权限[:：][^\n]*分配/m

/** Windows 盘符路径或 POSIX 绝对路径。 */
const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\/)/

/**
 * @param {string} profile
 * @returns {boolean}
 */
export function canAssign(profile = '') {
  return ASSIGN_PERMISSION.test(String(profile))
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} actorSlug 发起人的 slug
 * @param {string} target 同事的名字或 slug
 * @param {string} path 工作区绝对路径
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function assignWorkspace(store, actorSlug, target, path) {
  const actorProfile = (await store.read(actorSlug, 'profile.md')) ?? ''
  if (!canAssign(actorProfile)) return { ok: false, text: '你没有分配工作区的权限。' }
  const name = String(target ?? '').trim()
  const dir = String(path ?? '').trim()
  if (name === '' || dir === '') return { ok: false, text: '需要 colleague 和 workspace 两个参数。' }
  if (!ABSOLUTE_PATH.test(dir)) return { ok: false, text: 'workspace 要是绝对路径。' }
  const employees = await store.list()
  const found = employees.find((e) => e.slug === name || e.name === name)
  if (!found) return { ok: false, text: `没有找到同事「${name}」。` }
  const result = await bindWorkspace(store, found.slug, dir)
  return { ok: true, text: `已把 ${dir} 绑给 ${found.name}（她现在有 ${result.bound.length} 个工作区）。` }
}
