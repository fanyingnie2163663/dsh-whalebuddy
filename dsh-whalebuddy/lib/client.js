/**
 * Whalebuddy · 浏览器半边。
 *
 * The DSH Web shell loads client plugins as plain scripts through
 * `window.__ModuleLoader__`; the factory hands us exactly one dependency —
 * `require('react')` — and expects back a cordis plugin descriptor. There is
 * no build step in this package: this file *is* the artifact, so it stays
 * plain ES2020 with `React.createElement` and no JSX.
 *
 * What it mounts (official slot seats, same ones the shipped Plugins /
 * Schedule pages and the skill center use):
 *
 * - a row in the shell's own left sidebar list (`sidebar.panellist`), whose
 *   click the shell turns into a panel switch;
 * - the page for that row (`main`, keyed by the same id), only mounted while
 *   the row is selected — the conversation keeps the center column otherwise.
 *
 * Both go through `ctx.slots.inject`, so load order against the shell plugins
 * does not matter and a shell without the seats simply leaves the row absent.
 *
 * Failure policy: registration problems are logged, never thrown — an external
 * plugin must not take the whole GUI boot down.
 *
 * @module dsh-whalebuddy/client
 */
(function () {
  'use strict'

  /** The row id, shared with the `main` slot key. */
  var PANEL_ID = 'whalebuddy'
  var SLOT_PANEL_LIST = 'sidebar.panellist'
  var SLOT_MAIN = 'main'
  /** Row order among the shell's global panel rows (Plugins 0, Schedule 10, board 20, skill center 30). */
  var PANEL_ORDER = 40
  /** Style tag identity, so a re-apply never stacks duplicate sheets. */
  var STYLE_KEY = 'dsh-whalebuddy/console'

  /**
   * Route paths, DOCUMENT-RELATIVE on purpose: the harness serves the GUI with
   * `<base href="./">`, so a sub-path deployment keeps working. The host half
   * mirrors them as `/api/whalebuddy/...` (see lib/host/routes.js).
   */
  var API = {
    state: 'api/whalebuddy/state',
    save: 'api/whalebuddy/save',
    create: 'api/whalebuddy/create',
    assign: 'api/whalebuddy/assign',
  }

  /** The six surfaces, in tab order. `readOnly` marks a record the panel only displays. */
  var TABS = [
    { id: 'profile', rel: 'profile.md', file: 'profile', label: '档案' },
    { id: 'hot', rel: 'memory/hot.md', file: 'hot', label: '热记忆' },
    { id: 'rapport', rel: 'memory/rapport.md', file: 'rapport', label: '默契' },
    { id: 'knowledge', rel: 'memory/knowledge.md', file: 'knowledge', label: '知识' },
    { id: 'tasks', rel: 'memory/tasks.json', file: 'tasks', label: '待办', kind: 'tasks' },
    { id: 'roster', rel: '_shared/roster.md', file: 'roster', label: '花名册' },
    { id: 'changelog', rel: 'memory/changelog.md', file: 'changelog', label: '变更', readOnly: true },
  ]

  var AUTONOMY_LEVELS = ['L1', 'L2', 'L3']

  /** Theme variables owned by the shell; no hard-coded palette here. */
  var CSS = [
    '.wb-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);overflow:hidden}',
    '.wb-head{flex:none;display:flex;align-items:baseline;gap:10px;padding:14px 16px 10px}',
    '.wb-title{margin:0;font-size:16px;font-weight:700;white-space:nowrap}',
    '.wb-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wb-spacer{flex:1}',
    '.wb-status{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
    '.wb-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}',
    '.wb-status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}',
    '.wb-body{flex:1;min-height:0;display:grid;grid-template-columns:190px minmax(0,1.15fr) minmax(0,1fr);border-top:1px solid var(--dsw-alias-border-l1)}',
    '.wb-list{min-height:0;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:8px;display:flex;flex-direction:column;gap:2px}',
    '.wb-item{width:100%;display:flex;align-items:baseline;gap:8px;text-align:left;background:0 0;border:none;border-radius:8px;color:var(--dsw-alias-label-primary);cursor:pointer;padding:7px 9px;font-size:13px}',
    '.wb-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-item[data-active]{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}',
    '.wb-itemName{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wb-itemRole{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;white-space:nowrap}',
    '.wb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;padding:22px 8px;margin:0}',
    '.wb-listFoot{margin-top:auto;padding:8px 2px 2px}',
    '.wb-editor{min-width:0;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1)}',
    '.wb-tabs{flex:none;display:flex;gap:2px;overflow-x:auto;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    '.wb-tab{background:0 0;border:none;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:6px 11px;font-size:12.5px;white-space:nowrap}',
    '.wb-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-tab[data-active]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}',
    '.wb-editorBody{flex:1;min-height:0;display:flex;flex-direction:column;padding:10px}',
    '.wb-textarea{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);outline:none;padding:10px 12px;font-family:var(--ds-font-family-code);font-size:12.5px;line-height:1.65}',
    '.wb-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
    '.wb-editorFoot{flex:none;display:flex;align-items:center;gap:10px;padding-top:9px}',
    '.wb-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}',
    '.wb-primary{margin-left:auto;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none;border-radius:8px;cursor:pointer;padding:6px 14px;font-size:12.5px;font-weight:600;white-space:nowrap}',
    '.wb-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
    '.wb-primary:disabled{opacity:.45;cursor:default}',
    '.wb-ghost{width:100%;background:0 0;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:6px 10px;font-size:12px}',
    '.wb-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}',
    '.wb-form{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px}',
    '.wb-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);outline:none;padding:5px 8px;font-family:inherit;font-size:12px}',
    '.wb-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
    '.wb-formRow{display:flex;gap:6px}',
    '.wb-formRow .wb-primary{margin-left:0;flex:1}',
    '.wb-formRow .wb-ghost{width:auto;border-style:solid}',
    '.wb-preview{min-width:0;min-height:0;display:flex;flex-direction:column}',
    '.wb-previewHead{flex:none;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;padding:12px 14px 8px}',
    '.wb-pre{flex:1;min-height:0;margin:0 14px 12px;padding:10px 12px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}',
    '.wb-preEmpty{color:var(--dsw-alias-label-tertiary);font-style:normal}',
    '.wb-wsBlock{flex:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:1px}',
    '.wb-wsTitle{color:var(--dsw-alias-label-tertiary);font-size:10.5px;padding:2px 9px 4px}',
    '.wb-ws{display:flex;align-items:baseline;gap:8px;background:0 0;border:none;border-radius:7px;color:var(--dsw-alias-label-primary);cursor:pointer;padding:5px 9px;font-size:12px;text-align:left}',
    '.wb-ws:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-ws:disabled{opacity:.5;cursor:default}',
    '.wb-wsName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wb-wsGo{color:var(--dsw-alias-state-business-primary);font-size:11px}',
    '.wb-wsAdd{background:0 0;border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11.5px;padding:4px 8px;margin:2px 2px 0;text-align:left}',
    '.wb-wsAdd:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}',
    '.wb-wsEmpty{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:2px 9px}',
    '.wb-tasks{flex:1;min-height:0;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:2px}',
    '.wb-task{display:flex;align-items:baseline;gap:8px;padding:6px 7px;border-radius:7px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-primary)}',
    '.wb-task:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-task input{accent-color:var(--dsw-alias-state-business-primary);margin:0}',
    '.wb-taskText{flex:1;min-width:0}',
    '.wb-taskDone{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}',
    '.wb-taskDue{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}',
    '.wb-tasksEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px}',
  ].join('\n')

  /**
   * Install the console stylesheet once. Safe without a document (tests).
   * @returns {void}
   */
  function ensureStyle() {
    if (typeof document === 'undefined' || document.head === undefined) return
    if (document.querySelector('style[data-plugin-css="' + STYLE_KEY + '"]') !== null) return
    var tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-whalebuddy'
    tag.dataset.pluginCss = STYLE_KEY
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  /**
   * @param {unknown} error
   * @returns {string}
   */
  function describe(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * The HTTP face of the console. Kept separate from the components so it can
   * be handed a stub in tests.
   * @param {typeof fetch} [fetchImpl]
   * @returns {{ state: (slug?: string) => Promise<*>, save: (payload: object) => Promise<*>, create: (payload: object) => Promise<*>, assign: (payload: object) => Promise<*> }}
   */
  function createApi(fetchImpl) {
    var run = typeof fetchImpl === 'function' ? fetchImpl : function () {
      var args = arguments
      return fetch.apply(undefined, args)
    }

    /**
     * @param {string} path
     * @param {{ method?: string, body?: unknown }} [options]
     * @returns {Promise<*>}
     */
    async function request(path, options) {
      var settings = options || {}
      var hasBody = settings.body !== undefined
      var response = await run(path, {
        method: settings.method || 'GET',
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(settings.body) : undefined,
      })
      var body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        var message = body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status
        throw new Error(message)
      }
      return body
    }

    return {
      state: function (slug) {
        return request(API.state + (slug ? '?slug=' + encodeURIComponent(slug) : ''))
      },
      save: function (payload) {
        return request(API.save, { method: 'POST', body: payload })
      },
      create: function (payload) {
        return request(API.create, { method: 'POST', body: payload })
      },
      assign: function (payload) {
        return request(API.assign, { method: 'POST', body: payload })
      },
    }
  }

  /**
   * Draft text for every editable surface of one panel payload.
   * @param {*} state
   * @returns {Record<string, string>}
   */
  function filesFrom(state) {
    var files = (state && state.colleague && state.colleague.files) || {}
    /** @type {Record<string, string>} */
    var drafts = {}
    for (var index = 0; index < TABS.length; index += 1) {
      var spec = TABS[index]
      var text = files[spec.file]
      drafts[spec.rel] = typeof text === 'string' ? text : ''
    }
    return drafts
  }

  /**
   * The sidebar row glyph. The shell owns the button, label and rail geometry;
   * this draws only the glyph, like every other panel row.
   * @param {*} React
   * @returns {*}
   */
  function createIcon(React) {
    /**
     * @param {{ size?: number, active?: boolean }} props the shell's icon share
     * @returns {*}
     */
    return function WhalebuddyIcon(props) {
      var size = typeof props?.size === 'number' ? props.size : 16
      // Two colleagues: one in front, one peeking from behind. Drawn on a
      // 24 grid at the shell's line weight (2 → ~1.33px at 16), which is the
      // only thing that survives sidebar size — the old whale lost every
      // detail below 32px and read as a scribble.
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'data-dsh-panel-entry': PANEL_ID,
          'aria-hidden': 'true',
        },
        React.createElement('circle', { key: 'head', cx: 8.8, cy: 7.4, r: 3.3 }),
        React.createElement('path', { key: 'body', d: 'M2.9 19.9c0-3.3 2.6-5.9 5.9-5.9s5.9 2.6 5.9 5.9' }),
        React.createElement('path', { key: 'second-head', d: 'M15.6 4.4a3.2 3.2 0 0 1 0 6' }),
        React.createElement('path', { key: 'second-body', d: 'M17.3 13.9c2.3.6 4 2.7 4 6' }),
      )
    }
  }

  /**
   * Build the page component. It owns only view state; the files on disk stay
   * the single source of truth, and the preview always comes back from the
   * host's save answer.
   * @param {*} React
   * @param {ReturnType<typeof createApi>} api
   * @returns {*} the `main` slot page component
   */
  function createPage(React, api, options) {
    var h = React.createElement
    var startSession = (options && options.startSession) || function () {
      throw new Error('当前界面不支持从面板开会话')
    }

    /** @returns {*} */
    return function ColleagueConsole() {
      var stateHook = React.useState(null)
      var state = stateHook[0]
      var setState = stateHook[1]

      var tabHook = React.useState('profile')
      var tab = tabHook[0]
      var setTab = tabHook[1]

      var draftsHook = React.useState({})
      var drafts = draftsHook[0]
      var setDrafts = draftsHook[1]

      var statusHook = React.useState(null)
      var status = statusHook[0]
      var setStatus = statusHook[1]

      var busyHook = React.useState(false)
      var busy = busyHook[0]
      var setBusy = busyHook[1]

      var creatingHook = React.useState(false)
      var creating = creatingHook[0]
      var setCreating = creatingHook[1]

      var wsOpenHook = React.useState(false)
      var wsOpen = wsOpenHook[0]
      var setWsOpen = wsOpenHook[1]

      var formHook = React.useState({ name: '', role: '', autonomy: 'L2' })
      var form = formHook[0]
      var setForm = formHook[1]

      var requestRef = React.useRef(0)

      var employees = (state && state.employees) || []
      var selected = state && state.selected ? state.selected : ''
      var spec = TABS[0]
      for (var index = 0; index < TABS.length; index += 1) {
        if (TABS[index].id === tab) spec = TABS[index]
      }
      var currentText = drafts[spec.rel] !== undefined ? drafts[spec.rel] : ''
      var savedText = state && state.colleague && state.colleague.files ? state.colleague.files[spec.file] : ''
      var dirty = currentText !== (typeof savedText === 'string' ? savedText : '')

      // Unsaved work can sit in a tab that is not the visible one: switching
      // colleagues replaces every draft, so the guard has to look at all of them.
      var savedFiles = (state && state.colleague && state.colleague.files) || {}
      var hasUnsaved = false
      for (var guardIndex = 0; guardIndex < TABS.length; guardIndex += 1) {
        var guardTab = TABS[guardIndex]
        var guardDraft = drafts[guardTab.rel]
        var guardSaved = savedFiles[guardTab.file]
        if (typeof guardDraft === 'string' && guardDraft !== (typeof guardSaved === 'string' ? guardSaved : '')) {
          hasUnsaved = true
          break
        }
      }

      var preview = state && state.colleague && typeof state.colleague.preview === 'string' ? state.colleague.preview : ''

      var workspaces = state && Array.isArray(state.workspaces) ? state.workspaces : []
      var bound = state && state.colleague && Array.isArray(state.colleague.bound) ? state.colleague.bound : []
      var selectedEmployee = null
      for (var employeeIndex = 0; employeeIndex < employees.length; employeeIndex += 1) {
        if (employees[employeeIndex].slug === selected) {
          selectedEmployee = employees[employeeIndex]
          break
        }
      }
      var presetId = selected === '' ? '' : 'whalebuddy:' + selected

      /**
       * Adopt one panel payload: selection, drafts, tab.
       * @param {*} next
       * @returns {void}
       */
      function adopt(next) {
        setState(next)
        setDrafts(filesFrom(next))
        setTab('profile')
        setWsOpen(false)
        setStatus(null)
      }

      /**
       * Bind (when needed) and open one workspace with this colleague's preset.
       * `uiWorkspace.startSession` reuses a reusable blank Session or creates one,
       * then navigates to it; the panel disappears with that navigation.
       * @param {{id: string, title: string, path: string}} workspace
       * @returns {Promise<void>}
       */
      async function openWorkspace(workspace) {
        if (selected === '' || busy) return
        setBusy(true)
        setStatus(null)
        try {
          if (!bound.includes(workspace.path)) {
            var answer = await api.assign({ slug: selected, workspaceId: workspace.id })
            setState(function (current) {
              if (current === null || current.colleague === null || current.colleague === undefined) return current
              return {
                employees: current.employees,
                selected: current.selected,
                workspaces: current.workspaces,
                colleague: {
                  slug: current.colleague.slug,
                  files: current.colleague.files,
                  bound: answer.bound,
                  preview: answer.preview,
                },
              }
            })
          }
          startSession(workspace.id, presetId)
          setStatus({
            kind: 'ok',
            text: '已交给「' + (selectedEmployee === null ? selected : selectedEmployee.name || selected) + '」',
          })
        } catch (error) {
          setStatus({ kind: 'error', text: '开会话失败：' + describe(error) })
        } finally {
          setBusy(false)
        }
      }

      /**
       * Load one colleague (an empty slug asks the host for its default).
       * Stale answers are dropped so fast clicking cannot flip the selection.
       * @param {string} slug
       * @returns {Promise<void>}
       */
      async function load(slug) {
        requestRef.current += 1
        var ticket = requestRef.current
        setBusy(true)
        try {
          var next = await api.state(slug)
          if (ticket !== requestRef.current) return
          adopt(next)
        } catch (error) {
          if (ticket !== requestRef.current) return
          setStatus({ kind: 'error', text: '读取失败：' + describe(error) })
        } finally {
          if (ticket === requestRef.current) setBusy(false)
        }
      }

      React.useEffect(function () {
        void load('')
      }, [])

      /** @returns {Promise<void>} */
      async function save() {
        if (selected === '' || spec.readOnly === true) return
        setBusy(true)
        try {
          var answer = await api.save({ slug: selected, rel: spec.rel, text: currentText })
          setState(function (current) {
            if (current === null || current.colleague === null || current.colleague === undefined) return current
            var files = {}
            var keys = Object.keys(current.colleague.files || {})
            for (var key = 0; key < keys.length; key += 1) files[keys[key]] = current.colleague.files[keys[key]]
            files[spec.file] = currentText
            return {
              employees: current.employees,
              selected: current.selected,
              workspaces: current.workspaces,
              colleague: {
                slug: current.colleague.slug,
                files: files,
                bound: answer && Array.isArray(answer.bound) ? answer.bound : current.colleague.bound || [],
                preview: answer && answer.preview ? answer.preview : current.colleague.preview,
              },
            }
          })
          setStatus({ kind: 'ok', text: '已保存 · ' + currentText.length + ' 字' })
        } catch (error) {
          setStatus({ kind: 'error', text: '保存失败：' + describe(error) })
        } finally {
          setBusy(false)
        }
      }

      /**
       * Toggle one task and persist the whole list through the save route, so
       * the host keeps the same validation and changelog as a text save.
       * @param {string} id
       * @returns {Promise<void>}
       */
      async function toggleTask(id) {
        if (selected === '' || busy) return
        var next = taskItems.map(function (task) {
          if (task.id !== id) return task
          return Object.assign({}, task, { status: task.status === 'open' ? 'done' : 'open' })
        })
        var text = JSON.stringify(next, null, 2) + '\n'
        setBusy(true)
        try {
          var answer = await api.save({ slug: selected, rel: 'memory/tasks.json', text: text })
          var nextDrafts = {}
          var draftKeys = Object.keys(drafts)
          for (var draftIndex = 0; draftIndex < draftKeys.length; draftIndex += 1) {
            nextDrafts[draftKeys[draftIndex]] = drafts[draftKeys[draftIndex]]
          }
          nextDrafts['memory/tasks.json'] = text
          setDrafts(nextDrafts)
          setState(function (current) {
            if (current === null || current.colleague === null || current.colleague === undefined) return current
            var files = {}
            var keys = Object.keys(current.colleague.files || {})
            for (var index = 0; index < keys.length; index += 1) files[keys[index]] = current.colleague.files[keys[index]]
            files.tasks = text
            return {
              employees: current.employees,
              selected: current.selected,
              workspaces: current.workspaces,
              colleague: {
                slug: current.colleague.slug,
                files: files,
                bound: current.colleague.bound || [],
                preview: answer && answer.preview ? answer.preview : current.colleague.preview,
              },
            }
          })
          setStatus({ kind: 'ok', text: '已更新待办' })
        } catch (error) {
          setStatus({ kind: 'error', text: '待办保存失败：' + describe(error) })
        } finally {
          setBusy(false)
        }
      }

      /** @returns {Promise<void>} */
      async function create() {
        var name = form.name.trim()
        if (name === '') {
          setStatus({ kind: 'error', text: '先给她起个名字' })
          return
        }
        setBusy(true)
        try {
          var next = await api.create({
            name: name,
            role: form.role.trim(),
            autonomy: form.autonomy,
            temperament: '',
          })
          setCreating(false)
          setForm({ name: '', role: '', autonomy: 'L2' })
          adopt(next)
          setStatus({ kind: 'ok', text: '已新建「' + name + '」' })
        } catch (error) {
          setStatus({ kind: 'error', text: '新建失败：' + describe(error) })
        } finally {
          setBusy(false)
        }
      }

      var boundRows = workspaces
        .filter(function (workspace) {
          return bound.includes(workspace.path)
        })
        .map(function (workspace) {
          return h(
            'button',
            {
              key: workspace.id,
              type: 'button',
              className: 'wb-ws',
              title: workspace.path,
              disabled: busy,
              onClick: function () {
                void openWorkspace(workspace)
              },
            },
            h('span', { className: 'wb-wsName' }, workspace.title || workspace.path),
            h('span', { className: 'wb-wsGo' }, '开'),
          )
        })
      var unboundRows = workspaces
        .filter(function (workspace) {
          return !bound.includes(workspace.path)
        })
        .map(function (workspace) {
          return h(
            'button',
            {
              key: workspace.id,
              type: 'button',
              className: 'wb-ws',
              title: workspace.path,
              disabled: busy,
              onClick: function () {
                void openWorkspace(workspace)
              },
            },
            h('span', { className: 'wb-wsName' }, workspace.title || workspace.path),
            h('span', { className: 'wb-wsGo' }, '绑'),
          )
        })
      var workspaceBlock =
        workspaces.length === 0
          ? null
          : h(
              'div',
              { className: 'wb-wsBlock', 'data-dsh-part': 'colleague-workspaces' },
              h(
                'div',
                { className: 'wb-wsTitle' },
                selectedEmployee === null ? '工作区' : (selectedEmployee.name || selected) + ' 的工作区',
              ),
              boundRows,
              h(
                'button',
                {
                  type: 'button',
                  className: 'wb-wsAdd',
                  disabled: busy,
                  onClick: function () {
                    setWsOpen(!wsOpen)
                  },
                },
                wsOpen ? '收起' : '＋ 指定工作区',
              ),
              wsOpen ? unboundRows : null,
              wsOpen && unboundRows.length === 0 ? h('div', { className: 'wb-wsEmpty' }, '全部已指定') : null,
            )

      var taskItems = []
      if (spec.kind === 'tasks') {
        try {
          var parsedTasks = JSON.parse(currentText === '' ? '[]' : currentText)
          if (Array.isArray(parsedTasks)) taskItems = parsedTasks
        } catch {
          taskItems = []
        }
      }
      var taskPane =
        taskItems.length === 0
          ? h('p', { className: 'wb-tasksEmpty' }, '还没有待办')
          : taskItems.map(function (task) {
              var done = task.status !== 'open'
              return h(
                'label',
                { className: 'wb-task', key: task.id },
                h('input', {
                  type: 'checkbox',
                  checked: done,
                  disabled: busy,
                  onChange: function () {
                    void toggleTask(task.id)
                  },
                }),
                h('span', { className: 'wb-taskText' + (done ? ' wb-taskDone' : '') }, task.text),
                typeof task.due === 'string' && task.due !== ''
                  ? h('span', { className: 'wb-taskDue' }, task.due)
                  : null,
              )
            })

      var list = h(
        'aside',
        { className: 'wb-list', 'data-dsh-part': 'colleague-list' },
        employees.length === 0
          ? h('p', { className: 'wb-empty' }, selected === '' && busy ? '载入中…' : '还没有同事')
          : employees.map(function (employee) {
              return h(
                'button',
                {
                  key: employee.slug,
                  type: 'button',
                  className: 'wb-item',
                  'data-active': employee.slug === selected ? '' : undefined,
                  onClick: function () {
                    if (employee.slug === selected) return
                    // Switching throws the current draft away: ask first.
                    if (hasUnsaved && typeof window !== 'undefined' && typeof window.confirm === 'function') {
                      if (!window.confirm('「' + (employee.name || employee.slug) + '」还没保存，切走会丢掉这些改动。继续？')) return
                    }
                    void load(employee.slug)
                  },
                },
                h('span', { className: 'wb-itemName' }, employee.name || employee.slug),
                h('span', { className: 'wb-itemRole' }, employee.role || '未定'),
              )
            }),
        workspaceBlock,
        h(
          'div',
          { className: 'wb-listFoot' },
          creating
            ? h(
                'div',
                { className: 'wb-form' },
                h('input', {
                  className: 'wb-input',
                  placeholder: '名字',
                  value: form.name,
                  autoFocus: true,
                  onChange: function (event) {
                    setForm({ name: event.target.value, role: form.role, autonomy: form.autonomy })
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') void create()
                    if (event.key === 'Escape') setCreating(false)
                  },
                }),
                h('input', {
                  className: 'wb-input',
                  placeholder: '岗位（可留空）',
                  value: form.role,
                  onChange: function (event) {
                    setForm({ name: form.name, role: event.target.value, autonomy: form.autonomy })
                  },
                }),
                h(
                  'select',
                  {
                    className: 'wb-input',
                    value: form.autonomy,
                    onChange: function (event) {
                      setForm({ name: form.name, role: form.role, autonomy: event.target.value })
                    },
                  },
                  AUTONOMY_LEVELS.map(function (level) {
                    return h('option', { key: level, value: level }, level)
                  }),
                ),
                h(
                  'div',
                  { className: 'wb-formRow' },
                  h(
                    'button',
                    { type: 'button', className: 'wb-primary', disabled: busy, onClick: function () { void create() } },
                    '建',
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'wb-ghost', onClick: function () { setCreating(false) } },
                    '取消',
                  ),
                ),
              )
            : h(
                'button',
                { type: 'button', className: 'wb-ghost', onClick: function () { setCreating(true) } },
                '＋ 新建同事',
              ),
        ),
      )

      var editor = h(
        'section',
        { className: 'wb-editor', 'data-dsh-part': 'colleague-editor' },
        h(
          'div',
          { className: 'wb-tabs', role: 'tablist' },
          TABS.map(function (candidate) {
            return h(
              'button',
              {
                key: candidate.id,
                type: 'button',
                role: 'tab',
                className: 'wb-tab',
                'aria-selected': candidate.id === tab,
                'data-active': candidate.id === tab ? '' : undefined,
                onClick: function () {
                  setTab(candidate.id)
                  setStatus(null)
                },
              },
              candidate.label,
            )
          }),
        ),
        h(
          'div',
          { className: 'wb-editorBody' },
          spec.kind === 'tasks'
            ? h('div', { className: 'wb-tasks' }, taskPane)
            : h('textarea', {
            className: 'wb-textarea',
            value: currentText,
            readOnly: spec.readOnly === true,
            spellCheck: false,
            placeholder: selected === '' ? '还没有选中同事' : spec.readOnly ? '还没有变更记录' : '写点什么…',
            disabled: selected === '',
            onChange: function (event) {
              var next = {}
              var keys = Object.keys(drafts)
              for (var key = 0; key < keys.length; key += 1) next[keys[key]] = drafts[keys[key]]
              next[spec.rel] = event.target.value
              setDrafts(next)
            },
          }),
          h(
            'div',
            { className: 'wb-editorFoot' },
            h(
              'span',
              { className: 'wb-hint' },
              spec.kind === 'tasks'
                ? '勾选即保存'
                : spec.readOnly
                  ? '只读 · 自动记录'
                  : currentText.length + ' 字' + (dirty ? ' · 未保存' : ''),
            ),
            spec.kind === 'tasks'
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'wb-primary',
                    disabled: busy || !dirty || selected === '' || spec.readOnly === true,
                    onClick: function () { void save() },
                  },
                  busy ? '保存中…' : '保存',
                ),
          ),
        ),
      )

      var previewPane = h(
        'section',
        { className: 'wb-preview', 'data-dsh-part': 'colleague-preview' },
        h('div', { className: 'wb-previewHead' }, '她开场收到什么'),
        h(
          'pre',
          { className: 'wb-pre' + (preview === '' ? ' wb-preEmpty' : '') },
          preview === '' ? '（先选一个同事）' : preview,
        ),
      )

      return h(
        'div',
        { className: 'wb-root', 'data-dsh-plugin': 'whalebuddy' },
        h(
          'header',
          { className: 'wb-head' },
          h('h2', { className: 'wb-title' }, 'Whalebuddy'),
          h('span', { className: 'wb-sub' }, '看她的记忆 · 改一行 · 看注入变成什么样'),
          h('span', { className: 'wb-spacer' }),
          status !== null ? h('span', { className: 'wb-status', 'data-kind': status.kind }, status.text) : null,
        ),
        h('div', { className: 'wb-body' }, list, editor, previewPane),
      )
    }
  }

  /**
   * Assemble the cordis plugin descriptor the module loader mounts.
   * @param {*} React
   * @param {{ api?: ReturnType<typeof createApi>, startSession?: (workspaceId: string, presetId: string) => void }} [options]
   * @returns {{ name: string, inject: string[], apply: (ctx: *) => void }}
   */
  function createPanelPlugin(React, options) {
    var api = (options && options.api) || createApi()
    var Icon = createIcon(React)
    var injectedStart = options && options.startSession

    return {
      name: 'whalebuddy',
      inject: ['slots'],
      /**
       * @param {*} ctx client root context (service: slots)
       * @returns {void}
       */
      apply(ctx) {
        ensureStyle()
        var startSession =
          typeof injectedStart === 'function'
            ? injectedStart
            : function (workspaceId, presetIdToStart) {
                var ui = null
                try {
                  ui = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
                } catch {
                  ui = undefined
                }
                if (!ui || typeof ui.startSession !== 'function') {
                  throw new Error('当前界面不支持从面板开会话（uiWorkspace.startSession 不可用）')
                }
                ui.startSession(workspaceId, { agentPreset: presetIdToStart })
              }
        var Page = createPage(React, api, { startSession: startSession })
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.warn('[whalebuddy] slots service missing; colleague console not mounted')
          return
        }
        var disposers = []
        try {
          disposers.push(
            ctx.slots.inject(SLOT_PANEL_LIST, function () {
              return ctx.slots.register(
                { name: SLOT_PANEL_LIST, id: PANEL_ID, order: PANEL_ORDER, label: function () { return 'Whalebuddy' } },
                Icon,
              )
            }),
          )
          disposers.push(
            ctx.slots.inject(SLOT_MAIN, function () {
              return ctx.slots.register({ name: SLOT_MAIN, key: PANEL_ID }, Page)
            }),
          )
        } catch (error) {
          console.warn('[whalebuddy] panel registration failed:', error)
        }
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              for (var index = 0; index < disposers.length; index += 1) {
                try {
                  disposers[index]()
                } catch (error) {
                  console.warn('[whalebuddy] slot dispose failed:', error)
                }
              }
              disposers.length = 0
            }
          }, 'whalebuddy: ui mounts')
        }
      },
    }
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: 'dsh-whalebuddy',
      factory(require) {
        return createPanelPlugin(require('react'))
      },
    })
  }
})()
