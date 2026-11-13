/**
 * The colleague console's HTTP half: three routes on the harness web server.
 *
 * The browser half talks to these over same-origin fetch. Everything that
 * decides what may be written lives behind `panel-data.js`; this module only
 * parses, fences and shapes the answers, so it can be exercised with a plain
 * `node:http` server and no harness at all.
 *
 * Route paths are root-absolute (`/api/whalebuddy/...`) because the host mounts
 * them on the origin; the client mirrors them *document-relative*
 * (`api/whalebuddy/...`) so a sub-path deployment still reaches them.
 *
 * @module dsh-whalebuddy/host/routes
 */
import { bindWorkspace, isWritable, readPanelState, saveFile } from './panel-data.js'

/** Route paths, shared by the mount code and the tests. */
export const ROUTES = Object.freeze({
  state: '/api/whalebuddy/state',
  save: '/api/whalebuddy/save',
  create: '/api/whalebuddy/create',
  assign: '/api/whalebuddy/assign',
})

/** The largest request body accepted: a 64 KB file plus JSON escaping. */
const BODY_LIMIT = 256 * 1024
/** The same cap `panel-data.saveFile` enforces, checked before reading a body. */
const FILE_LIMIT = 64 * 1024
/** Autonomy levels the panel may set; anything else falls back to L2. */
const DEFAULT_AUTONOMY = 'L2'
/** Name/role caps keep a stray paste from becoming a directory name. */
const NAME_LIMIT = 40
const ROLE_LIMIT = 40
const TEMPERAMENT_LIMIT = 80
/** JSON response headers: never cached, never referrer-leaking. */
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
})

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
function writeJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/**
 * The client half is served from the same origin as the GUI, so loopback is
 * the normal case. This fallback exists for builds with no `connection`
 * service; the remote-device fence, when present, still runs first.
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Resolve the optional host `connection` service without requiring injection.
 * @param {*} ctx
 * @returns {{ requestRejection(request: unknown): unknown } | undefined}
 */
function resolveConnection(ctx) {
  try {
    const candidate =
      typeof ctx?.get === 'function' ? ctx.get('connection', false) ?? ctx.get('connection') : ctx?.connection
    return candidate && typeof candidate.requestRejection === 'function' ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a request may enter any console route: the harness connection fence
 * when it is available, otherwise loopback.
 * @param {*} ctx
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function isConsoleRequestAllowed(ctx, request) {
  const connection = resolveConnection(ctx)
  if (connection !== undefined) {
    try {
      if (connection.requestRejection(request) === undefined) return true
    } catch {
      // A throwing fence must not turn into an open door; fall through.
    }
  }
  return isLoopbackRequest(request)
}

/**
 * Read a request body with a hard cap, writing 413 and resolving `undefined`
 * when it is exceeded.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<string | undefined>}
 */
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        writeJson(res, 413, { error: `request body is larger than ${BODY_LIMIT} bytes` })
        settle(undefined)
        // Keep draining: destroying mid-body would reset the socket before the
        // client reads the 413 it just got.
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => {
      writeJson(res, 400, { error: 'request stream failed' })
      settle(undefined)
    })
  })
}

/**
 * Parse one JSON object body; `undefined` means a response was already written.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function readJsonObject(req, res) {
  const raw = await readBody(req, res)
  if (raw === undefined) return undefined
  if (raw.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    writeJson(res, 400, { error: 'invalid JSON body' })
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    writeJson(res, 400, { error: 'expected a JSON object body' })
    return undefined
  }
  return parsed
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function clamp(text, limit) {
  const trimmed = text.trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {URL}
 */
function requestUrl(req) {
  return new URL(req.url ?? '/', 'http://localhost')
}

/**
 * Guard one route: fence first, then method. Returns false when it answered.
 * @param {(request: import('node:http').IncomingMessage) => boolean} allow
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} method
 * @returns {boolean}
 */
function guard(allow, req, res, method) {
  if (!allow(req)) {
    writeJson(res, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  if (req.method !== method) {
    writeJson(res, 405, { error: `method not allowed: ${req.method ?? ''}` })
    return false
  }
  return true
}

/**
 * @typedef {object} PanelRouteOptions
 * @property {import('../store.js').Store} store
 * @property {(request: import('node:http').IncomingMessage) => boolean} [allow]
 * @property {(employee: import('../store.js').EmployeeSummary) => Promise<void> | void} [onCreate]
 * @property {{ warn?: (message: string) => void }} [logger]
 * @property {() => Array<{id: string, title: string, path: string}>} [listWorkspaces]
 * @property {(id: string) => string | undefined} [workspacePath]
 */

/**
 * Build the console's route list for `webServer.register`.
 * @param {PanelRouteOptions} options
 * @returns {Array<{kind: 'exact', path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}>}
 */
export function createPanelRoutes({ store, allow, onCreate, logger, listWorkspaces, workspacePath }) {
  const permitted = typeof allow === 'function' ? allow : isLoopbackRequest

  const fail = (res, error) => {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 500, { error: message })
  }

  return [
    {
      kind: 'exact',
      path: ROUTES.state,
      async handler(req, res) {
        if (!guard(permitted, req, res, 'GET')) return
        try {
          const slug = requestUrl(req).searchParams.get('slug') ?? ''
          let workspaces = []
          try {
            workspaces = typeof listWorkspaces === 'function' ? listWorkspaces() ?? [] : []
          } catch {
            workspaces = []
          }
          writeJson(res, 200, { ...(await readPanelState(store, slug)), workspaces })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.save,
      async handler(req, res) {
        if (!guard(permitted, req, res, 'POST')) return
        const body = await readJsonObject(req, res)
        if (body === undefined) return

        const slug = textOf(body.slug)
        const rel = textOf(body.rel)
        const text = body.text

        if (slug === '') {
          writeJson(res, 400, { error: 'slug is required' })
          return
        }
        if (!isWritable(rel)) {
          writeJson(res, 403, { error: `refused: ${rel || '(empty)'} is not a console-editable file` })
          return
        }
        if (typeof text !== 'string') {
          writeJson(res, 400, { error: 'text must be a string' })
          return
        }
        if (text.length > FILE_LIMIT) {
          writeJson(res, 413, { error: `refused: file is larger than 64 KB` })
          return
        }

        // A write may create a directory, so the slug must be a known colleague.
        let employees
        try {
          employees = await store.list()
        } catch (error) {
          fail(res, error)
          return
        }
        if (rel.startsWith('_shared/') === false && !employees.some((employee) => employee.slug === slug)) {
          writeJson(res, 404, { error: `no colleague named "${slug}"` })
          return
        }

        try {
          writeJson(res, 200, await saveFile(store, slug, rel, text))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.assign,
      async handler(req, res) {
        if (!guard(permitted, req, res, 'POST')) return
        const body = await readJsonObject(req, res)
        if (body === undefined) return

        const slug = textOf(body.slug)
        const workspaceId = textOf(body.workspaceId)
        if (slug === '') {
          writeJson(res, 400, { error: 'slug is required' })
          return
        }
        if (workspaceId === '') {
          writeJson(res, 400, { error: 'workspaceId is required' })
          return
        }

        let employees
        try {
          employees = await store.list()
        } catch (error) {
          fail(res, error)
          return
        }
        if (!employees.some((employee) => employee.slug === slug)) {
          writeJson(res, 404, { error: `no colleague named "${slug}"` })
          return
        }

        let path
        try {
          path = typeof workspacePath === 'function' ? workspacePath(workspaceId) : undefined
        } catch (error) {
          writeJson(res, 503, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (typeof path !== 'string' || path === '') {
          writeJson(res, 404, { error: `no workspace "${workspaceId}"` })
          return
        }

        try {
          writeJson(res, 200, await bindWorkspace(store, slug, path))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.create,
      async handler(req, res) {
        if (!guard(permitted, req, res, 'POST')) return
        const body = await readJsonObject(req, res)
        if (body === undefined) return

        const name = clamp(textOf(body.name), NAME_LIMIT)
        if (name === '') {
          writeJson(res, 400, { error: 'name is required' })
          return
        }
        const role = clamp(textOf(body.role), ROLE_LIMIT)
        const rawAutonomy = textOf(body.autonomy).toUpperCase()
        const autonomy =
          rawAutonomy === 'L1' || rawAutonomy === 'L2' || rawAutonomy === 'L3' ? rawAutonomy : DEFAULT_AUTONOMY
        const temperament = clamp(textOf(body.temperament), TEMPERAMENT_LIMIT)

        let created
        try {
          created = await store.create({ name, role, autonomy, presetId: '', workspaces: [], temperament })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }

        // Registering the preset is best-effort: the colleague exists either way.
        if (typeof onCreate === 'function') {
          try {
            await onCreate(created)
          } catch (error) {
            logger?.warn?.(`同事「${created.slug}」的预设注册失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }

        try {
          writeJson(res, 200, { created, ...(await readPanelState(store, created.slug)) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
  ]
}
