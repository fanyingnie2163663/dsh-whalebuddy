/**
 * Whalebuddy · 浏览器半边。
 *
 * The DSH Web shell loads client plugins as plain scripts through
 * `window.__ModuleLoader__`; the factory hands us exactly one dependency —
 * `require('react')` — and expects back a cordis plugin descriptor. There is
 * no build step in this package: this file *is* the artifact, so it stays
 * plain ES2020 with `React.createElement` and no JSX.
 *
 * The console follows the 2026-11-11 design canvas, adapted to a host page:
 * structure from the canvas (rail, dossier header, five tabs, preview drawer,
 * four-step onboarding), colours from the shell's theme variables, serif only
 * for display type, clay only as a decorative mark.
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
  /** Below this panel width the preview becomes a drawer instead of a column. */
  var WIDE_PREVIEW = 1180

  /**
   * Route paths, DOCUMENT-RELATIVE on purpose: the harness serves the GUI with
   * `<base href="./">`, so a sub-path deployment keeps working. The host half
   * mirrors them as `/api/whalebuddy/...` (see lib/host/routes.js).
   */
  var API = {
    state: 'api/whalebuddy/state',
    save: 'api/whalebuddy/save',
    update: 'api/whalebuddy/update',
    create: 'api/whalebuddy/create',
    assign: 'api/whalebuddy/assign',
    notices: 'api/whalebuddy/notices',
    noticesRead: 'api/whalebuddy/notices/read',
  }

  /** The five surfaces, in tab order. */
  var TABS = [
    { id: 'profile', label: '档案' },
    { id: 'memory', label: '记忆' },
    { id: 'tasks', label: '待办', file: 'tasks', rel: 'memory/tasks.json' },
    { id: 'roster', label: '花名册', file: 'roster', rel: '_shared/roster.md' },
    { id: 'changelog', label: '变更', file: 'changelog', rel: 'memory/changelog.md', readOnly: true },
  ]

  /** The three memory files, grouped under the 记忆 tab. */
  var SECTIONS = [
    { file: 'hot', rel: 'memory/hot.md', label: '热记忆', note: '每次开场必注入 · 限 800 字', empty: '还没有热记忆。写一条她每次开场都该记得的事。' },
    { file: 'rapport', rel: 'memory/rapport.md', label: '私房默契', note: '只有你和她看得见', empty: '还没有默契。你纠正过她的点会攒在这里。' },
    { file: 'knowledge', rel: 'memory/knowledge.md', label: '知识', note: '带工作区归属', empty: '还没有知识条目。项目事实、决定、踩过的坑都放这里。' },
  ]

  /** Every text surface the console may edit: drafts, the dirty guard, and saves. */
  var EDITABLE = [
    { file: 'profile', rel: 'profile.md', label: '档案' },
    { file: 'hot', rel: 'memory/hot.md', label: '热记忆' },
    { file: 'rapport', rel: 'memory/rapport.md', label: '默契' },
    { file: 'knowledge', rel: 'memory/knowledge.md', label: '知识' },
    { file: 'tasks', rel: 'memory/tasks.json', label: '待办' },
    { file: 'roster', rel: '_shared/roster.md', label: '花名册' },
  ]

  /** L1/L2/L3, in the design's words. */
  var AUTONOMY = {
    L1: { name: '随叫随到', text: '只在会话里工作；收工时整理记忆。不主动发消息。' },
    L2: { name: '会来找你', text: '收工整理、到点提醒；每天最多两条主动消息。' },
    L3: { name: '自己找活', text: '后台常驻，从待办里自己挑活；外发动作仍需你点头。实验性。' },
  }

  /** The name pool from the design doc §7.3: the name carries the temperament. */
  var PERSONAS = [
    { name: '小白', latin: 'Beluga', role: '日常', temperament: '温和、耐心，适合日常与陪伴' },
    { name: '逆戟', latin: 'Orca', role: '写码', temperament: '锋利、直接、话少，适合写码与挑错' },
    { name: '座头', latin: 'Humpback', role: '复盘', temperament: '爱唱爱总结，适合复盘与讲故事' },
    { name: '一角', latin: 'Narwhal', role: '研究', temperament: '钻研、刨根问底，适合研究与查资料' },
    { name: '蓝鲸', latin: 'Blue', role: '重活', temperament: '大、稳、扛重活，适合长线项目' },
  ]

  /** The onboarding steps, in order. */
  var STEPS = ['名字', '岗位', '脾气', '档位']

  /** Suggested roles for step 2 (free text stays possible). */
  var ROLES = ['写码', '日常', '复盘', '研究', '重活', '挑错']

  /**
   * Theme variables owned by the shell; the only fixed colours here are the
   * decorative clay mark and its mixes, which never carry body text.
   */
  var CSS = [
    '.wb-root{--wb-serif:"Noto Serif SC","Source Han Serif SC","Songti SC",Georgia,serif;--wb-clay:#D97757;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);overflow:hidden;position:relative;container-type:inline-size;container-name:wb}',
    '.wb-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 18px 10px;min-height:32px}',
    '.wb-title{margin:0;font-family:var(--wb-serif);font-size:21px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}',
    '.wb-sub{margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wb-spacer{flex:1;min-width:8px}',
    '.wb-status{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:38ch;overflow:hidden;text-overflow:ellipsis}',
    '.wb-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}',
    '.wb-status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}',
    '.wb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
    '.wb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-btn:disabled{opacity:.45;cursor:default}',
    '.wb-btn[data-active]{background:var(--dsw-specific-input-major);border-color:var(--dsw-alias-border-l2)}',
    '.wb-btnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:600}',
    '.wb-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
    '.wb-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
    '.wb-body{flex:1;min-height:0;display:grid;grid-template-columns:264px minmax(0,1fr);border-top:1px solid var(--dsw-alias-border-l1);position:relative}',
    '.wb-list{min-height:0;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:10px 8px;display:flex;flex-direction:column;gap:2px}',
    '.wb-item{position:relative;display:grid;grid-template-columns:38px minmax(0,1fr) 8px;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid transparent;border-radius:12px;background:transparent;color:inherit;text-align:left;font-family:inherit;cursor:pointer}',
    '.wb-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-item[data-active]{background:var(--dsw-specific-input-major);border-color:var(--dsw-alias-border-l1)}',
    '.wb-item[data-active]::before{content:"";position:absolute;left:-1px;top:12px;bottom:12px;width:2px;border-radius:2px;background:var(--wb-clay)}',
    '.wb-avatar{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;font-family:var(--wb-serif);font-size:17px;line-height:1;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major)}',
    '@supports (color:color-mix(in oklab,red,blue)){.wb-avatar{background:color-mix(in oklab,var(--dsw-alias-bg-base) 84%,#D97757)}}',
    '.wb-avatarLg{width:56px;height:56px;font-size:25px}',
    '.wb-itemText{min-width:0}',
    '.wb-itemName{display:block;font-size:14.5px;font-weight:500;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wb-itemMeta{display:block;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wb-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.45}',
    '.wb-dot[data-level=fresh]{background:var(--dsw-alias-state-success-primary);opacity:1}',
    '.wb-dot[data-level=recent]{opacity:.8}',
    '.wb-listFoot{margin-top:auto;padding:8px 2px 2px}',
    '.wb-listFoot .wb-btn{width:100%;border-style:dashed;color:var(--dsw-alias-label-secondary)}',
    '.wb-empty{margin:0;padding:18px 8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.7}',
    '.wb-main{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
    '.wb-profileHead{flex:none;display:flex;align-items:center;gap:14px;padding:20px 22px 0;flex-wrap:wrap}',
    '.wb-nameBlock{min-width:0}',
    '.wb-name{margin:0;font-family:var(--wb-serif);font-size:27px;font-weight:600;letter-spacing:-.01em;line-height:1.2}',
    '.wb-roleLine{display:flex;align-items:center;gap:7px;margin:5px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}',
    '.wb-chips{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
    '.wb-chip{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
    '.wb-chipMono{font-family:var(--ds-font-family-code);font-size:10.5px}',
    '.wb-label-unread::after{content:"";display:inline-block;width:5px;height:5px;margin-left:7px;border-radius:50%;background:var(--wb-clay,#D97757);vertical-align:middle}',
    '.wb-iconDot{display:none}',
    '.wb-hover{position:fixed;z-index:2147483000;width:264px;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#2a2f38);border-radius:10px;background:var(--dsw-alias-bg-base,#14171c);color:var(--dsw-alias-label-primary,#e8ebf0);font:12.5px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.38)}',
    '.wb-hoverHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#7c8593)}',
    '.wb-hoverHead b{font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,#7c8593)}',
    '.wb-hoverText{margin:6px 0 0;font-size:13px;line-height:1.55;word-break:break-word}',
    '.wb-hoverMeta{margin:4px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b1bd)}',
    '.wb-hoverFoot{margin:8px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#7c8593)}',
    '.wb-tabs{flex:none;display:flex;gap:2px;margin-top:14px;padding:0 22px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}',
    '.wb-tab{flex:none;height:38px;padding:0;margin-right:22px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
    '.wb-tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
    '.wb-tab:disabled{opacity:.45;cursor:default}',
    '.wb-tab[data-active]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--wb-clay);font-weight:600}',
    '.wb-tabCount{margin-left:6px;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
    '.wb-tab[data-active] .wb-tabCount{color:var(--dsw-alias-label-secondary)}',
    '.wb-pane{flex:1;min-height:0;overflow-y:auto;padding:18px 22px 28px;display:flex;flex-direction:column;gap:14px}',
    '.wb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px 18px}',
    '.wb-cardHead{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}',
    '.wb-cardTitle{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary)}',
    '.wb-cardAction{margin-left:auto;display:flex;align-items:center;gap:8px}',
    '.wb-big{margin:0;font-family:var(--wb-serif);font-size:20px;font-weight:600;line-height:1.3}',
    '.wb-copy{margin:7px 0 0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}',
    '.wb-meter{display:flex;gap:4px;margin-top:12px}',
    '.wb-meter span{flex:1;height:3px;border-radius:2px;background:var(--dsw-alias-border-l2)}',
    '.wb-meter span[data-on]{background:var(--dsw-alias-label-primary)}',
    '.wb-levels{display:flex;gap:6px;margin-top:2px}',
    '.wb-level{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:inherit;font-family:inherit;font-size:12.5px;text-align:left;cursor:pointer}',
    '.wb-level:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-level[data-on]{border-color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major)}',
    '.wb-level:disabled{opacity:.5;cursor:default}',
    '.wb-levelName{font-weight:600}',
    '.wb-levelMeta{color:var(--dsw-alias-label-tertiary)}',
    '.wb-notice{padding:6px 0}',
    '.wb-notice + .wb-notice{border-top:1px solid var(--dsw-alias-border-l1)}',
    '.wb-noticeHead{display:flex;align-items:baseline;gap:8px}',
    '.wb-noticeTime{flex:none;font-family:var(--ds-font-family-code);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
    '.wb-noticeText{flex:1;min-width:0;font-size:13px;line-height:1.6;word-break:break-word}',
    '.wb-noticeRead{flex:none;border:0;background:transparent;padding:0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;cursor:pointer}',
    '.wb-noticeRead:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
    '.wb-noticeRead:disabled{opacity:.45;cursor:default}',
    '.wb-noticeDetail{margin:2px 0 0 44px}',
    '.wb-cap{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.wb-capLabel{color:var(--dsw-alias-label-tertiary)}',
    '.wb-stepBtn{width:22px;height:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:inherit;font-family:inherit;font-size:13px;line-height:1;cursor:pointer}',
    '.wb-stepBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-stepBtn:disabled{opacity:.4;cursor:default}',
    '.wb-capValue{min-width:12px;text-align:center;color:var(--dsw-alias-label-primary)}',
    '.wb-capUnit{color:var(--dsw-alias-label-tertiary)}',
    '.wb-field{display:flex;gap:10px;padding:5px 0;font-size:13px;line-height:1.6}',
    '.wb-fieldLabel{flex:none;width:52px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
    '.wb-fieldValue{min-width:0;word-break:break-word}',
    '.wb-entry{padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
    '.wb-entry:first-child{border-top:0;padding-top:0}',
    '.wb-entryText{margin:0;font-size:14px;line-height:1.75;white-space:pre-wrap;word-break:break-word}',
    '.wb-entryHead{margin:0;font-family:var(--wb-serif);font-size:16px;font-weight:600;line-height:1.4}',
    '.wb-src{margin:5px 0 0;font-family:var(--ds-font-family-code);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
    '.wb-inlineEmpty{margin:0;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}',
    '.wb-textarea{width:100%;box-sizing:border-box;min-height:150px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);outline:none;padding:10px 12px;font-family:var(--ds-font-family-code);font-size:12px;line-height:1.7}',
    '.wb-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
    '.wb-actions{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '.wb-actions .wb-hint{margin-left:auto}',
    '.wb-ws{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:12.5px;text-align:left;cursor:pointer}',
    '.wb-ws:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-ws:disabled{opacity:.5;cursor:default}',
    '.wb-wsName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wb-wsGo{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
    '.wb-wsAdd{width:100%;box-sizing:border-box;margin-top:6px;padding:6px 8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;text-align:left;cursor:pointer}',
    '.wb-wsAdd:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}',
    '.wb-task{display:flex;align-items:flex-start;gap:10px;padding:8px 6px;border-radius:8px;cursor:pointer;font-size:13.5px;line-height:1.55}',
    '.wb-task:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-task input{margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-state-business-primary)}',
    '.wb-taskText{flex:1;min-width:0}',
    '.wb-taskDone{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}',
    '.wb-taskDue{flex:none;margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
    '.wb-logRow{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;line-height:1.6}',
    '.wb-logRow:first-child{border-top:0;padding-top:0}',
    '.wb-logTime{flex:none;width:118px;font-family:var(--ds-font-family-code);font-size:10.5px;color:var(--dsw-alias-label-tertiary);padding-top:3px}',
    '.wb-logWhat{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word}',
    '.wb-logSource{color:var(--dsw-alias-label-secondary)}',
    '.wb-preview{display:none;min-width:0;min-height:0;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}',
    '.wb-root[data-preview=open] .wb-preview{display:flex}',
    '.wb-previewHead{flex:none;display:flex;align-items:center;gap:8px;padding:14px 14px 8px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
    '.wb-previewHead .wb-hint{margin-left:auto;font-weight:400}',
    '.wb-pre{flex:1;min-height:0;margin:0 14px 14px;padding:12px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:1.75;white-space:pre-wrap;word-break:break-word}',
    '.wb-preEmpty{color:var(--dsw-alias-label-tertiary)}',
    '.wb-scrim{display:none;position:absolute;inset:0;z-index:2;background:rgba(0,0,0,.28)}',
    '.wb-wizard{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}',
    '.wb-wizardHead{flex:none;display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
    '.wb-wizardTitle{margin:0;font-family:var(--wb-serif);font-size:18px;font-weight:600}',
    '.wb-steps{display:flex;gap:10px;margin-left:auto;flex-wrap:wrap}',
    '.wb-step{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
    '.wb-step b{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);font-size:10.5px;font-weight:600}',
    '.wb-step[data-on]{color:var(--dsw-alias-label-primary)}',
    '.wb-step[data-on] b{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:transparent}',
    '.wb-wizardBody{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:28px;padding:24px 22px}',
    '.wb-wizardMain{min-width:0}',
    '.wb-wizardH{margin:0;font-family:var(--wb-serif);font-size:24px;font-weight:600;line-height:1.3}',
    '.wb-wizardLead{margin:8px 0 0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
    '.wb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-top:16px}',
    '.wb-option{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:transparent;color:inherit;font-family:inherit;text-align:left;cursor:pointer}',
    '.wb-option:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.wb-option[data-on]{border-color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major)}',
    '.wb-optionText{min-width:0}',
    '.wb-optionName{display:block;font-size:13.5px;font-weight:500}',
    '.wb-optionMeta{display:block;margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4}',
    '.wb-input{width:100%;box-sizing:border-box;height:34px;margin-top:12px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);outline:none;font-family:inherit;font-size:13px}',
    '.wb-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
    '.wb-wizardPreview{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px;align-self:start}',
    '.wb-wizardPreview .wb-avatar{width:44px;height:44px;font-size:20px}',
    '.wb-wizardFoot{flex:none;display:flex;align-items:center;gap:8px;padding:12px 22px;border-top:1px solid var(--dsw-alias-border-l1)}',
    '.wb-wizardFoot .wb-hint{margin-left:auto}',
    '.wb-emptyHero{flex:1;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:10px;padding:32px 28px;max-width:520px}',
    '.wb-emptyHero h2{margin:0;font-family:var(--wb-serif);font-size:26px;font-weight:600;line-height:1.3}',
    '@container wb (min-width:1180px){.wb-root[data-preview=open] .wb-body{grid-template-columns:264px minmax(0,1fr) 320px}}',
    '@container wb (max-width:1179px){.wb-preview{position:absolute;z-index:3;top:0;right:0;bottom:0;width:min(380px,100%);box-shadow:-18px 0 44px rgba(0,0,0,.22)}.wb-root[data-preview=open] .wb-scrim{display:block}}',
    '@container wb (max-width:819px){.wb-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.wb-list{flex-direction:row;align-items:center;gap:6px;padding:8px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}.wb-item{width:172px;grid-template-columns:30px minmax(0,1fr);flex:none;padding:6px 8px}.wb-item .wb-avatar{width:30px;height:30px;font-size:14px}.wb-item .wb-dot{display:none}.wb-listFoot{position:sticky;right:-8px;margin:0;flex:none;padding:0 10px 0 6px;background:var(--dsw-alias-bg-base);box-shadow:-10px 0 12px -8px rgba(0,0,0,.22)}.wb-listFoot .wb-btn{width:auto}.wb-profileHead{padding:14px 16px 0}.wb-chips{margin-left:0;width:100%;justify-content:flex-start}.wb-tabs{padding:0 16px}.wb-pane{padding:14px 16px 22px}.wb-name{font-size:23px}}',
    '@container wb (max-width:900px){.wb-wizardBody{grid-template-columns:minmax(0,1fr)}.wb-wizardPreview{display:none}}',
    '.wb-root{color-scheme:light}',
    '.wb-root[data-wb-theme=dark]{color-scheme:dark;--dsw-alias-bg-base:#14171c;--dsw-alias-label-primary:#e8ebf0;--dsw-alias-label-secondary:#a9b1bd;--dsw-alias-label-tertiary:#7c8593;--dsw-alias-label-primary-foreground:#0e1117;--dsw-alias-border-l1:#262b33;--dsw-alias-border-l2:#343b45;--dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);--dsw-specific-input-major:#1b1f26;--dsw-alias-button-primary-fill:#7c8cff;--dsw-alias-button-primary-hover:#94a1ff;--dsw-alias-state-business-primary:#7c8cff;--dsw-alias-state-success-primary:#5fbe8a;--dsw-alias-state-error-primary:#ff8177}',
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
   * @returns {{ state: (slug?: string) => Promise<*>, save: (payload: object) => Promise<*>, update: (payload: object) => Promise<*>, notices: () => Promise<*>, markRead: (payload: object) => Promise<*>, create: (payload: object) => Promise<*>, assign: (payload: object) => Promise<*> }}
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
      update: function (payload) {
        return request(API.update, { method: 'POST', body: payload })
      },
      notices: function () {
        return request(API.notices)
      },
      markRead: function (payload) {
        return request(API.noticesRead, { method: 'POST', body: payload })
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
   * `18:42`, for the sidebar title and the notice card.
   * @param {unknown} stamp
   * @returns {string}
   */
  function clockOf(stamp) {
    if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return ''
    var date = new Date(stamp)
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  }

  /**
   * Keep the sidebar glyph honest without React: the shell owns the row, so we
   * poll the aggregate endpoint and paint our own SVG dot and title directly.
   * No document or no timers means no watcher; the plugin still mounts.
   * @param {{ api: ReturnType<typeof createApi>, document?: Document, timers?: { setInterval: Function, clearInterval: Function }, intervalMs?: number }} options
   * @returns {{ start: () => void, stop: () => void, refresh: () => Promise<void>, apply: (payload: *) => void }}
   */
  /**
   * The dot belongs after the row's own label ("Whalebuddy ●"), not on the
   * glyph and not at the row's far edge: find the deepest element whose text
   * is exactly the label and let the stylesheet append the dot to it.
   * @param {Document} doc
   * @param {number} unread
   * @returns {Element | null}
   */
  function paintRowBadge(doc, unread) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null
    var marked = doc.querySelectorAll('.wb-label-unread')
    for (var index = 0; index < marked.length; index += 1) {
      if (marked[index] && marked[index].classList) marked[index].classList.remove('wb-label-unread')
    }

    /** @type {Element | null} */
    var hit = null
    var all = doc.querySelectorAll('*')
    for (var node = 0; node < all.length; node += 1) {
      var label = all[node].textContent ? all[node].textContent.trim() : ''
      if (label === 'Whalebuddy') hit = all[node]
    }
    if (hit !== null && unread > 0 && hit.classList) hit.classList.add('wb-label-unread')
    return hit
  }

  function createNoticeWatcher(options) {
    var api = options.api
    var doc = options.document
    var timers = options.timers
    var intervalMs = options.intervalMs || 30000
    var timer = null
    var started = false
    var lastPayload = null
    /** @type {any} */
    var rowEl = null
    /** @type {any} */
    var cardEl = null

    /**
     * @param {*} parent
     * @param {*} child
     * @returns {boolean}
     */
    function contains(parent, child) {
      if (!parent || !child) return false
      if (parent === child) return true
      return typeof parent.contains === 'function' ? parent.contains(child) : false
    }

    /** @returns {void} */
    function hideCard() {
      if (cardEl === null) return
      var parent = cardEl.parentNode
      if (parent && typeof parent.removeChild === 'function') parent.removeChild(cardEl)
      cardEl = null
    }

    /**
     * @param {string} tag
     * @param {string} className
     * @param {string} [text]
     * @returns {*}
     */
    function make(tag, className, text) {
      var node = doc.createElement(tag)
      if (className !== '') node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    /** @returns {void} */
    function showCard() {
      if (!doc || typeof doc.createElement !== 'function' || !doc.body || rowEl === null) return
      hideCard()
      var payload = lastPayload || {}
      var latest = payload.latest || null
      var unread = typeof payload.unread === 'number' ? payload.unread : 0

      var card = make('div', 'wb-hover')
      card.setAttribute('role', 'tooltip')
      var head = make('div', 'wb-hoverHead')
      head.appendChild(make('b', '', '她的话'))
      head.appendChild(make('span', '', latest ? clockOf(latest.at) : ''))
      card.appendChild(head)

      card.appendChild(make('p', 'wb-hoverText', latest ? latest.name + '：' + latest.text : '现在没有未读。'))
      var meta = unread > 0 ? unread + ' 条未读' : '收工后她会留一句'
      card.appendChild(make('p', 'wb-hoverMeta', meta))
      card.appendChild(make('p', 'wb-hoverFoot', '点一下打开 Whalebuddy'))
      card.addEventListener('mouseleave', hideCard)
      card.addEventListener('click', function () {
        if (rowEl && typeof rowEl.click === 'function') rowEl.click()
      })

      doc.body.appendChild(card)
      cardEl = card

      if (typeof rowEl.getBoundingClientRect === 'function' && typeof card.getBoundingClientRect === 'function') {
        var row = rowEl.getBoundingClientRect()
        var box = card.getBoundingClientRect()
        var viewport = doc.documentElement && doc.documentElement.clientWidth ? doc.documentElement.clientWidth : 1200
        var left = row.right + 10
        if (left + box.width > viewport - 8) left = Math.max(8, row.left - box.width - 10)
        var top = row.top + (row.height || 0) / 2 - (box.height || 0) / 2
        if (top < 8) top = 8
        card.style.left = left + 'px'
        card.style.top = top + 'px'
      }
    }

    /** @param {*} event @returns {void} */
    function onMouseOver(event) {
      if (rowEl === null || !event || !event.target) return
      if (cardEl !== null && contains(cardEl, event.target)) return
      if (!contains(rowEl, event.target)) return
      hideCard()
      showCard()
    }

    /** @param {*} event @returns {void} */
    function onMouseOut(event) {
      if (cardEl === null) return
      var to = event ? event.relatedTarget : null
      if (to && (contains(rowEl, to) || contains(cardEl, to))) return
      hideCard()
    }

    /**
     * @param {*} payload
     * @returns {void}
     */
    function apply(payload) {
      if (!doc) return
      lastPayload = payload || null
      var unread = payload && typeof payload.unread === 'number' && payload.unread > 0 ? payload.unread : 0
      var label = paintRowBadge(doc, unread)
      rowEl = label && typeof label.closest === 'function'
        ? label.closest('button,a,[role="button"],[role="menuitem"],[tabindex]') || label
        : label
      var svg = typeof doc.querySelector === 'function' ? doc.querySelector('svg[data-wb-unread]') : null
      if (svg === null || svg === undefined || typeof svg.setAttribute !== 'function') return
      svg.setAttribute('data-wb-unread', unread > 0 ? '1' : '0')
      var title = typeof svg.querySelector === 'function' ? svg.querySelector('title') : null
      if (title !== null && title !== undefined) {
        var latest = payload && payload.latest ? payload.latest : null
        title.textContent = unread > 0 && latest
          ? latest.name + '：' + latest.text + '（' + clockOf(latest.at) + '）'
          : 'Whalebuddy'
      }
    }

    /** @returns {Promise<void>} */
    function refresh() {
      return Promise.resolve()
        .then(function () { return api.notices() })
        .then(apply)
        .catch(function () {})
    }

    /** @returns {void} */
    function start() {
      if (started || !doc || !timers || typeof timers.setInterval !== 'function') return
      started = true
      void refresh()
      timer = timers.setInterval(function () { void refresh() }, intervalMs)
      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', function () {
          if (doc.visibilityState === 'visible') void refresh()
        })
        doc.addEventListener('mouseover', onMouseOver, true)
        doc.addEventListener('mouseout', onMouseOut, true)
        doc.addEventListener('scroll', hideCard, true)
      }
    }

    /** @returns {void} */
    function stop() {
      if (timer !== null && timers && typeof timers.clearInterval === 'function') timers.clearInterval(timer)
      timer = null
      started = false
      hideCard()
    }

    return { start: start, stop: stop, refresh: refresh, apply: apply }
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
    for (var index = 0; index < EDITABLE.length; index += 1) {
      var spec = EDITABLE[index]
      var text = files[spec.file]
      drafts[spec.rel] = typeof text === 'string' ? text : ''
    }
    return drafts
  }

  /**
   * The first character of a display name, emoji-safe.
   * @param {unknown} name
   * @returns {string}
   */
  function initialOf(name) {
    var chars = Array.from(typeof name === 'string' ? name.trim() : '')
    return chars.length > 0 ? chars[0] : '?'
  }

  /**
   * "刚刚 / 12 分钟前 / 昨天 / 11 月 9 日" from a millisecond timestamp.
   * @param {number} stamp
   * @param {number} now
   * @returns {string}
   */
  function relativeTime(stamp, now) {
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return '还没有记录'
    var diff = Math.max(0, now - stamp)
    if (diff < 60 * 1000) return '刚刚'
    if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + ' 分钟前'
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / (60 * 60 * 1000)) + ' 小时前'
    if (diff < 48 * 60 * 60 * 1000) return '昨天'
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / (24 * 60 * 60 * 1000)) + ' 天前'
    var date = new Date(stamp)
    return date.getMonth() + 1 + ' 月 ' + date.getDate() + ' 日'
  }

  /**
   * fresh: touched today; recent: this week; stale: anything older.
   * @param {number} stamp
   * @param {number} now
   * @returns {'fresh' | 'recent' | 'stale'}
   */
  function activityLevel(stamp, now) {
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return 'stale'
    var diff = Math.max(0, now - stamp)
    if (diff < 24 * 60 * 60 * 1000) return 'fresh'
    if (diff < 7 * 24 * 60 * 60 * 1000) return 'recent'
    return 'stale'
  }

  /**
   * Pull the "- 岗位：…" style lines out of a profile.
   * @param {string} text
   * @returns {{role: string, autonomy: string, workspaces: string[], temperament: string}}
   */
  function profileFields(text) {
    var out = { role: '', autonomy: '', workspaces: [], temperament: '' }
    var lines = String(text || '').split(/\r?\n/)
    for (var index = 0; index < lines.length; index += 1) {
      var match = /^-[ \t]*(岗位|档位|工作区|脾气)[:：][ \t]*(.*)$/.exec(lines[index].trim())
      if (match === null) continue
      var value = match[2].trim()
      if (match[1] === '岗位') out.role = value
      else if (match[1] === '档位') out.autonomy = value
      else if (match[1] === '脾气') out.temperament = value
      else {
        out.workspaces = value
          .split(/[,，]/)
          .map(function (path) { return path.trim() })
          .filter(function (path) { return path !== '' })
      }
    }
    return out
  }

  /**
   * Non-empty lines with their 1-based line number, for source references.
   * @param {string} text
   * @returns {Array<{line: number, text: string}>}
   */
  function memoryLines(text) {
    var lines = String(text || '').split(/\r?\n/)
    var out = []
    for (var index = 0; index < lines.length; index += 1) {
      var trimmed = lines[index].trim()
      if (trimmed === '') continue
      out.push({ line: index + 1, text: trimmed })
    }
    return out
  }

  /**
   * Count readable entries (headings are structure, not entries).
   * @param {string} text
   * @returns {number}
   */
  function countEntries(text) {
    var rows = memoryLines(text)
    var total = 0
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index].text.charAt(0) !== '#') total += 1
    }
    return total
  }

  /**
   * Parse the append-only change log into newest-first rows.
   * @param {string} text
   * @returns {Array<{time: string, source: string, what: string}>}
   */
  function changelogRows(text) {
    var lines = String(text || '').split(/\r?\n/)
    var rows = []
    for (var index = 0; index < lines.length; index += 1) {
      var raw = lines[index].trim()
      if (raw === '') continue
      var match = /^-[ \t]*\[([^\]]+)\][ \t]*(.*)$/.exec(raw)
      if (match === null) {
        rows.push({ time: '', source: '', what: raw })
        continue
      }
      var body = match[2]
      var cut = body.indexOf('：')
      if (cut === -1) cut = body.indexOf(':')
      if (cut === -1) rows.push({ time: match[1], source: '', what: body })
      else rows.push({ time: match[1], source: body.slice(0, cut), what: body.slice(cut + 1) })
    }
    rows.reverse()
    return rows
  }

  /**
   * One display line: the list marker is noise once every entry has its own row.
   * @param {string} text
   * @returns {string}
   */
  function displayLine(text) {
    return String(text).replace(/^[-*+]\s+/, '')
  }

  /**
   * Parse the tasks file; a corrupt list reads as empty, never throws.
   * @param {string} text
   * @returns {Array<*>}
   */
  function parseTasks(text) {
    try {
      var parsed = JSON.parse(String(text || '') === '' ? '[]' : String(text))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
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
          'data-wb-unread': '0',
          'aria-hidden': 'true',
        },
        React.createElement('title', { key: 'title' }, 'Whalebuddy'),
        React.createElement('circle', { key: 'head', cx: 8.8, cy: 7.4, r: 3.3 }),
        React.createElement('path', { key: 'body', d: 'M2.9 19.9c0-3.3 2.6-5.9 5.9-5.9s5.9 2.6 5.9 5.9' }),
        React.createElement('path', { key: 'second-head', d: 'M15.6 4.4a3.2 3.2 0 0 1 0 6' }),
        React.createElement('path', { key: 'second-body', d: 'M17.3 13.9c2.3.6 4 2.7 4 6' }),
        React.createElement('circle', {
          key: 'dot',
          className: 'wb-iconDot',
          'data-wb-dot': '',
          cx: 21,
          cy: 3,
          r: 2.5,
          fill: 'var(--wb-clay,#D97757)',
          stroke: 'none',
        }),
      )
    }
  }

  /** Stored theme key; a blocked storage falls back to dark. */
  var THEME_KEY = 'whalebuddy.theme'

  /**
   * The console's own light/dark choice. It does not follow the shell theme:
   * the owner asked for a dark default, and a per-panel switch is the only way
   * to honour that inside a light shell.
   * @returns {'dark' | 'light'}
   */
  function storedTheme() {
    try {
      if (typeof window === 'undefined' || window.localStorage === undefined) return 'dark'
      return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  }

  /**
   * @param {'dark' | 'light'} theme
   * @returns {void}
   */
  function rememberTheme(theme) {
    try {
      if (typeof window !== 'undefined' && window.localStorage !== undefined) {
        window.localStorage.setItem(THEME_KEY, theme)
      }
    } catch {
      // A blocked storage must not break the toggle.
    }
  }

  /**
   * Build the page component. It owns only view state; the files on disk stay
   * the single source of truth, and the preview always comes back from the
   * host's save answer.
   * @param {*} React
   * @param {ReturnType<typeof createApi>} api
   * @param {{ startSession?: (workspaceId: string, presetId: string) => void, notices?: { apply: (payload: *) => void, refresh: () => Promise<void> } }} [options]
   * @returns {*} the `main` slot page component
   */
  function createPage(React, api, options) {
    var h = React.createElement
    var notices = options && options.notices
    var startSession = (options && options.startSession) || function () {
      throw new Error('当前界面不支持从面板开会话')
    }

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

      var editingHook = React.useState(null)
      var editing = editingHook[0]
      var setEditing = editingHook[1]

      var previewHook = React.useState(true)
      var previewOpen = previewHook[0]
      var setPreviewOpen = previewHook[1]

      var themeHook = React.useState(storedTheme)
      var theme = themeHook[0]
      var setTheme = themeHook[1]

      var wizardHook = React.useState(null)
      var wizard = wizardHook[0]
      var setWizard = wizardHook[1]

      var wsOpenHook = React.useState(false)
      var wsOpen = wsOpenHook[0]
      var setWsOpen = wsOpenHook[1]

      var requestRef = React.useRef(0)
      var rootRef = React.useRef(null)

      var employees = (state && state.employees) || []
      var selected = state && state.selected ? state.selected : ''
      var colleague = state && state.colleague ? state.colleague : null
      var files = (colleague && colleague.files) || {}
      var preview = colleague && typeof colleague.preview === 'string' ? colleague.preview : ''
      var workspaces = state && Array.isArray(state.workspaces) ? state.workspaces : []
      var bound = colleague && Array.isArray(colleague.bound) ? colleague.bound : []
      var selectedEmployee = null
      for (var employeeIndex = 0; employeeIndex < employees.length; employeeIndex += 1) {
        if (employees[employeeIndex].slug === selected) {
          selectedEmployee = employees[employeeIndex]
          break
        }
      }
      var presetId = selected === '' ? '' : 'whalebuddy:' + selected
      var now = Date.now()

      /** Draft-or-disk text for every editable surface, by file key. */
      var textOfFile = {}
      for (var fileIndex = 0; fileIndex < EDITABLE.length; fileIndex += 1) {
        var fileSpec = EDITABLE[fileIndex]
        var fromDraft = drafts[fileSpec.rel]
        var fromDisk = files[fileSpec.file]
        textOfFile[fileSpec.file] = typeof fromDraft === 'string'
          ? fromDraft
          : typeof fromDisk === 'string' ? fromDisk : ''
      }

      // Read-only surfaces never enter drafts, but the change log still needs text.
      textOfFile.changelog = typeof files.changelog === 'string' ? files.changelog : ''

      var memoryCount =
        countEntries(textOfFile.hot) + countEntries(textOfFile.rapport) + countEntries(textOfFile.knowledge)
      var taskItems = parseTasks(textOfFile.tasks)
      var openTaskCount = 0
      for (var taskIndex = 0; taskIndex < taskItems.length; taskIndex += 1) {
        if (taskItems[taskIndex].status === 'open') openTaskCount += 1
      }

      /**
       * @param {string} file
       * @returns {boolean}
       */
      function isDirty(file) {
        var saved = typeof files[file] === 'string' ? files[file] : ''
        return textOfFile[file] !== saved
      }

      var hasUnsaved = false
      for (var dirtyIndex = 0; dirtyIndex < EDITABLE.length; dirtyIndex += 1) {
        if (isDirty(EDITABLE[dirtyIndex].file)) {
          hasUnsaved = true
          break
        }
      }

      /**
       * @param {*} next
       * @returns {void}
       */
      function adopt(next) {
        setState(next)
        setDrafts(filesFrom(next))
        setTab('profile')
        setEditing(null)
        setWizard(null)
        setWsOpen(false)
        setStatus(null)
      }

      /**
       * Replace one draft without mutating the state object.
       * @param {string} rel
       * @param {string} text
       * @returns {void}
       */
      function setDraft(rel, text) {
        setDrafts(function (current) {
          var next = {}
          var keys = Object.keys(current || {})
          for (var index = 0; index < keys.length; index += 1) next[keys[index]] = current[keys[index]]
          next[rel] = text
          return next
        })
      }

      /**
       * Adopt one panel payload, dropping stale answers.
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

      // First paint only: the preview column is wide-screen furniture, the
      // drawer is the narrow-screen form. A resize keeps the user's choice.
      React.useEffect(function () {
        var node = rootRef.current
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return
        var width = node.getBoundingClientRect().width
        if (typeof width === 'number' && width > 0 && width < WIDE_PREVIEW) setPreviewOpen(false)
      }, [])

      /**
       * Select one colleague, asking before unsaved drafts are dropped.
       * @param {*} employee
       * @returns {void}
       */
      function selectEmployee(employee) {
        if (employee.slug === selected) return
        if (hasUnsaved && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('「' + (employee.name || employee.slug) + '」还没保存，切走会丢掉这些改动。继续？')) return
        }
        void load(employee.slug)
      }

      /**
       * Save one surface, then adopt the regenerated preview.
       * @param {string} rel
       * @param {string} file
       * @returns {Promise<void>}
       */
      async function save(rel, file) {
        if (selected === '' || busy) return
        var text = typeof drafts[rel] === 'string' ? drafts[rel] : textOfFile[file]
        setBusy(true)
        try {
          var answer = await api.save({ slug: selected, rel: rel, text: text })
          setState(function (current) {
            if (current === null || current.colleague === null || current.colleague === undefined) return current
            var nextFiles = {}
            var keys = Object.keys(current.colleague.files || {})
            for (var index = 0; index < keys.length; index += 1) nextFiles[keys[index]] = current.colleague.files[keys[index]]
            nextFiles[file] = text
            return {
              employees: answer && Array.isArray(answer.employees) ? answer.employees : current.employees,
              selected: current.selected,
              workspaces: current.workspaces,
              colleague: {
                slug: current.colleague.slug,
                files: nextFiles,
                bound: answer && Array.isArray(answer.bound) ? answer.bound : current.colleague.bound || [],
                preview: answer && typeof answer.preview === 'string' ? answer.preview : current.colleague.preview,
              },
            }
          })
          setEditing(null)
          setStatus({ kind: 'ok', text: '已保存 · ' + text.length + ' 字' })
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
          setDrafts(function (current) {
            var copy = {}
            var keys = Object.keys(current || {})
            for (var index = 0; index < keys.length; index += 1) copy[keys[index]] = current[keys[index]]
            copy['memory/tasks.json'] = text
            return copy
          })
          setState(function (current) {
            if (current === null || current.colleague === null || current.colleague === undefined) return current
            var nextFiles = {}
            var keys = Object.keys(current.colleague.files || {})
            for (var index = 0; index < keys.length; index += 1) nextFiles[keys[index]] = current.colleague.files[keys[index]]
            nextFiles.tasks = text
            return {
              employees: current.employees,
              selected: current.selected,
              workspaces: current.workspaces,
              colleague: {
                slug: current.colleague.slug,
                files: nextFiles,
                bound: current.colleague.bound || [],
                preview: answer && typeof answer.preview === 'string' ? answer.preview : current.colleague.preview,
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

      /**
       * Bind (when needed) and open one workspace with this colleague's preset.
       * `uiWorkspace.startSession` reuses a reusable blank Session or creates one,
       * then navigates to it; the panel disappears with that navigation.
       * @param {{id: string, title: string, path: string}} workspace
       * @returns {Promise<void>}
       */
      async function openWorkspace(workspace) {
        if (selected === '' || busy || workspace.id === '') return
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
          setStatus({ kind: 'ok', text: '已交给「' + (selectedEmployee === null ? selected : selectedEmployee.name || selected) + '」' })
        } catch (error) {
          setStatus({ kind: 'error', text: '开会话失败：' + describe(error) })
        } finally {
          setBusy(false)
        }
      }

      /** @returns {void} */
      function toggleTheme() {
        /** @type {'dark' | 'light'} */
        var next = theme === 'dark' ? 'light' : 'dark'
        setTheme(next)
        rememberTheme(next)
      }

      /** @returns {void} */
      function openWizard() {
        setWizard({ step: 0, name: '', role: '', temperament: '', autonomy: 'L2', persona: '' })
        setEditing(null)
        setStatus(null)
      }

      /**
       * @param {Record<string, unknown>} patch
       * @returns {void}
       */
      function setWizardField(patch) {
        setWizard(function (current) {
          if (current === null) return current
          return Object.assign({}, current, patch)
        })
      }

      /** @returns {void} */
      function wizardNext() {
        if (wizard === null) return
        if (wizard.step === 0 && wizard.name.trim() === '') {
          setStatus({ kind: 'error', text: '先给她起个名字' })
          return
        }
        setStatus(null)
        setWizardField({ step: Math.min(STEPS.length - 1, wizard.step + 1) })
      }

      /** @returns {void} */
      function wizardBack() {
        if (wizard === null) return
        setStatus(null)
        setWizardField({ step: Math.max(0, wizard.step - 1) })
      }

      /**
       * @param {{name: string, role: string, temperament: string}} persona
       * @returns {void}
       */
      function pickPersona(persona) {
        setWizardField({ persona: persona.name, name: persona.name, role: persona.role, temperament: persona.temperament })
      }

      /** @returns {Promise<void>} */
      async function submitWizard() {
        if (wizard === null || busy) return
        var name = wizard.name.trim()
        if (name === '') {
          setStatus({ kind: 'error', text: '先给她起个名字' })
          return
        }
        setBusy(true)
        try {
          var next = await api.create({
            name: name,
            role: wizard.role.trim(),
            autonomy: wizard.autonomy,
            temperament: wizard.temperament.trim(),
          })
          adopt(next)
          setStatus({ kind: 'ok', text: '已新建「' + name + '」' })
        } catch (error) {
          setStatus({ kind: 'error', text: '新建失败：' + describe(error) })
        } finally {
          setBusy(false)
        }
      }

      /**
       * @param {unknown} name
       * @param {boolean} [large]
       * @returns {*}
       */
      function avatar(name, large) {
        return h('span', { className: 'wb-avatar' + (large === true ? ' wb-avatarLg' : ''), 'aria-hidden': 'true' }, initialOf(name))
      }

      /**
       * @param {string} label
       * @param {string} value
       * @returns {*}
       */
      function field(label, value) {
        return h('div', { className: 'wb-field', key: label },
          h('span', { className: 'wb-fieldLabel' }, label),
          h('span', { className: 'wb-fieldValue' }, value)
        )
      }

      var list = h('aside', { className: 'wb-list', 'data-dsh-part': 'colleague-list' },
        employees.length === 0
          ? h('p', { className: 'wb-empty' }, state === null && busy ? '载入中…' : '还没有同事')
          : employees.map(function (employee) {
              var update = relativeTime(employee.updatedAt, now)
              return h('button', {
                key: employee.slug,
                type: 'button',
                className: 'wb-item',
                'data-active': employee.slug === selected ? '' : undefined,
                title: (employee.name || employee.slug) + ' · 记忆更新于 ' + update,
                onClick: function () { selectEmployee(employee) },
              },
                avatar(employee.name || employee.slug, false),
                h('span', { className: 'wb-itemText' },
                  h('span', { className: 'wb-itemName' }, employee.name || employee.slug),
                  h('span', { className: 'wb-itemMeta' }, (employee.role || '岗位未定') + ' · ' + update)
                ),
                h('span', { className: 'wb-dot', 'data-level': activityLevel(employee.updatedAt, now) })
              )
            }),
        h('div', { className: 'wb-listFoot' },
          h('button', { type: 'button', className: 'wb-btn', disabled: busy, onClick: openWizard }, '＋ 新同事')
        )
      )

      var subtitle = employees.length === 0 ? '还没有同事' : '· ' + employees.length + ' 位'
      var header = h('header', { className: 'wb-head' },
        h('h1', { className: 'wb-title' }, '同事'),
        h('p', { className: 'wb-sub' }, subtitle),
        h('span', { className: 'wb-spacer' }),
        status !== null ? h('span', { className: 'wb-status', 'data-kind': status.kind, role: 'status' }, status.text) : null,
        h('button', {
          type: 'button',
          className: 'wb-btn',
          title: '切换深浅色',
          'aria-label': '切换深浅色',
          onClick: toggleTheme,
        }, theme === 'dark' ? '浅色' : '深色'),
        h('button', {
          type: 'button',
          className: 'wb-btn',
          'data-active': previewOpen ? '' : undefined,
          'aria-pressed': previewOpen,
          onClick: function () { setPreviewOpen(!previewOpen) },
        }, '注入预览')
      )

      function profileHead() {
        var level = selectedEmployee === null ? 'L2' : selectedEmployee.autonomy
        var info = AUTONOMY[level] || AUTONOMY.L2
        var workspaceLabel = '未绑工作区'
        if (bound.length > 0) {
          var firstTitle = bound[0]
          for (var index = 0; index < workspaces.length; index += 1) {
            if (workspaces[index].path === bound[0]) firstTitle = workspaces[index].title || workspaces[index].path
          }
          workspaceLabel = firstTitle + (bound.length > 1 ? ' +' + (bound.length - 1) : '')
        }
        var stamp = selectedEmployee === null ? 0 : selectedEmployee.updatedAt
        return h('div', { className: 'wb-profileHead' },
          avatar(selectedEmployee === null ? selected : selectedEmployee.name, true),
          h('div', { className: 'wb-nameBlock' },
            h('h2', { className: 'wb-name' }, selectedEmployee === null ? selected : selectedEmployee.name),
            h('p', { className: 'wb-roleLine' },
              h('span', { className: 'wb-dot', 'data-level': activityLevel(stamp, now) }),
              (selectedEmployee !== null && selectedEmployee.role ? selectedEmployee.role : '岗位未定') + ' · 记忆更新于 ' + relativeTime(stamp, now)
            )
          ),
          h('div', { className: 'wb-chips' },
            h('span', { className: 'wb-chip' }, level + ' · ' + info.name),
            h('span', { className: 'wb-chip' }, workspaceLabel),
            h('span', { className: 'wb-chip wb-chipMono' }, presetId)
          )
        )
      }

      var tabs = h('nav', { className: 'wb-tabs', role: 'tablist' },
        TABS.map(function (spec) {
          var count = spec.id === 'memory' ? memoryCount : spec.id === 'tasks' ? openTaskCount : -1
          return h('button', {
            key: spec.id,
            type: 'button',
            role: 'tab',
            className: 'wb-tab',
            'aria-selected': spec.id === tab,
            'data-active': spec.id === tab ? '' : undefined,
            disabled: colleague === null,
            onClick: function () { setTab(spec.id); setStatus(null) },
          },
            spec.label,
            count >= 0 ? h('span', { className: 'wb-tabCount' }, count) : null
          )
        })
      )

      /**
       * @param {string} rel
       * @param {string} file
       * @returns {*}
       */
      function editor(rel, file) {
        var value = textOfFile[file]
        return h('div', { className: 'wb-editor' },
          h('textarea', {
            className: 'wb-textarea',
            value: value,
            spellCheck: false,
            'data-dsh-part': 'colleague-textarea',
            onChange: function (event) { setDraft(rel, event.target.value) },
          }),
          h('div', { className: 'wb-actions' },
            h('button', {
              type: 'button',
              className: 'wb-btn wb-btnPrimary',
              disabled: busy,
              onClick: function () { void save(rel, file) },
            }, busy ? '保存中…' : '保存'),
            h('button', { type: 'button', className: 'wb-btn', disabled: busy, onClick: function () { setEditing(null) } }, '取消'),
            h('span', { className: 'wb-hint' }, value.length + ' 字 · ' + (isDirty(file) ? '未保存' : '已保存'))
          )
        )
      }

      var boundRows = bound.map(function (path) {
        var found = null
        for (var index = 0; index < workspaces.length; index += 1) {
          if (workspaces[index].path === path) found = workspaces[index]
        }
        var title = found === null ? path : found.title || found.path
        return h('button', {
          key: path,
          type: 'button',
          className: 'wb-ws',
          title: path,
          disabled: busy || found === null,
          onClick: function () { if (found !== null) void openWorkspace(found) },
        },
          h('span', { className: 'wb-wsName' }, title),
          h('span', { className: 'wb-wsGo' }, '开')
        )
      })

      var unboundRows = workspaces
        .filter(function (workspace) { return !bound.includes(workspace.path) })
        .map(function (workspace) {
          return h('button', {
            key: workspace.id,
            type: 'button',
            className: 'wb-ws',
            title: workspace.path,
            disabled: busy,
            onClick: function () { void openWorkspace(workspace) },
          },
            h('span', { className: 'wb-wsName' }, workspace.title || workspace.path),
            h('span', { className: 'wb-wsGo' }, '绑')
          )
        })

      var autonomy = selectedEmployee === null ? 'L2' : selectedEmployee.autonomy
      if (AUTONOMY[autonomy] === undefined) autonomy = 'L2'
      var autonomyInfo = AUTONOMY[autonomy]
      // Changing the level rewrites the profile file; an unsaved profile edit
      // would be silently overwritten, so the picker waits for it to be saved.
      var autonomyLocked = busy || isDirty('profile')

      /**
       * Persist one autonomy level. The host rewrites the profile line and the
       * state snapshot, then answers with the whole panel, so the dossier chip,
       * the card and the injected preview agree after one round trip.
       * @param {string} level
       * @returns {Promise<void>}
       */
      async function setAutonomyLevel(level) {
        if (selected === '' || busy) return
        var current = selectedEmployee === null ? 'L2' : selectedEmployee.autonomy
        if (level === current) return
        setBusy(true)
        setStatus(null)
        var ticket = requestRef.current
        try {
          var next = await api.update({ slug: selected, autonomy: level })
          // Another colleague was selected while this was in flight; that load wins.
          if (ticket !== requestRef.current) return
          setState(next)
          setDrafts(function (currentDrafts) {
            var copy = {}
            var keys = Object.keys(currentDrafts || {})
            for (var index = 0; index < keys.length; index += 1) copy[keys[index]] = currentDrafts[keys[index]]
            delete copy['profile.md']
            return copy
          })
          setStatus({ kind: 'ok', text: '主动性已改为 ' + level + ' · ' + AUTONOMY[level].name })
        } catch (error) {
          setStatus({ kind: 'error', text: '改档位失败：' + describe(error) })
        } finally {
          if (ticket === requestRef.current) setBusy(false)
        }
      }

      var recentNotices = (colleague && Array.isArray(colleague.notices) ? colleague.notices : []).slice(-5)
      var unreadNotices = 0
      for (var noticeIndex = 0; noticeIndex < recentNotices.length; noticeIndex += 1) {
        if (recentNotices[noticeIndex] && recentNotices[noticeIndex].readAt === undefined) unreadNotices += 1
      }
      var noticeCap = colleague && Number.isInteger(colleague.noticeCap) ? colleague.noticeCap : 2

      /**
       * Mark one note read; the host answers with the new roll-up, which also
       * repaints the sidebar dot without a reload.
       * @param {string} id
       * @returns {Promise<void>}
       */
      async function markNoticeRead(id) {
        if (selected === '' || busy) return
        setBusy(true)
        setStatus(null)
        var ticket = requestRef.current
        try {
          var aggregate = await api.markRead({ slug: selected, id: id })
          if (ticket !== requestRef.current) return
          var stamp = Date.now()
          setState(function (current) {
            if (current === null || current.colleague === null || current.colleague === undefined) return current
            var list = Array.isArray(current.colleague.notices) ? current.colleague.notices : []
            return {
              employees: current.employees,
              selected: current.selected,
              workspaces: current.workspaces,
              colleague: Object.assign({}, current.colleague, {
                notices: list.map(function (notice) {
                  return notice && notice.id === id ? Object.assign({}, notice, { readAt: stamp }) : notice
                }),
              }),
            }
          })
          if (notices && typeof notices.apply === 'function') notices.apply(aggregate)
          setStatus({ kind: 'ok', text: '知道了' })
        } catch (error) {
          setStatus({ kind: 'error', text: '标记失败：' + describe(error) })
        } finally {
          if (ticket === requestRef.current) setBusy(false)
        }
      }

      /**
       * @param {number} next
       * @returns {Promise<void>}
       */
      async function changeNoticeCap(next) {
        if (selected === '' || busy || next < 1 || next > 5) return
        setBusy(true)
        setStatus(null)
        var ticket = requestRef.current
        try {
          var answer = await api.update({ slug: selected, noticeCap: next })
          if (ticket !== requestRef.current) return
          setState(answer)
          setStatus({ kind: 'ok', text: '每天最多 ' + next + ' 条' })
        } catch (error) {
          setStatus({ kind: 'error', text: '改上限失败：' + describe(error) })
        } finally {
          if (ticket === requestRef.current) setBusy(false)
        }
      }

      var noticeCard = h('section', { className: 'wb-card', 'data-dsh-part': 'colleague-notices' },
        h('div', { className: 'wb-cardHead' },
          h('h3', { className: 'wb-cardTitle' }, '她的话'),
          recentNotices.length === 0
            ? null
            : h('span', { className: 'wb-cardAction wb-hint' },
                recentNotices.length + ' 条' + (unreadNotices > 0 ? ' · 未读 ' + unreadNotices : ''))
        ),
        recentNotices.length === 0
          ? h('div', null,
              h('p', { className: 'wb-inlineEmpty' },
                autonomy === 'L1' ? '现在是 L1：随叫随到，她不会主动找你。' : '今天还没找过你。'),
              autonomy === 'L1'
                ? null
                : h('p', { className: 'wb-hint', style: { marginTop: '4px' } },
                    '她收工后留一句，每天最多 ' + noticeCap + ' 条。')
            )
          : recentNotices.map(function (notice, index) {
              return h('div', { key: notice.id || String(index), className: 'wb-notice' },
                h('div', { className: 'wb-noticeHead' },
                  h('span', { className: 'wb-noticeTime' }, clockOf(notice.at)),
                  h('span', { className: 'wb-noticeText' }, notice.text),
                  notice.readAt === undefined
                    ? h('button', {
                        type: 'button',
                        className: 'wb-noticeRead',
                        disabled: busy,
                        onClick: function () { void markNoticeRead(notice.id) },
                      }, '知道了')
                    : h('span', { className: 'wb-hint' }, '已读')
                ),
                notice.detail ? h('p', { className: 'wb-hint wb-noticeDetail' }, notice.detail) : null
              )
            })
      )

      var profilePane = h('div', { className: 'wb-pane', 'data-dsh-part': 'colleague-pane-profile' },
        noticeCard,
        h('section', { className: 'wb-card', 'data-dsh-part': 'colleague-autonomy' },
          h('div', { className: 'wb-cardHead' },
            h('h3', { className: 'wb-cardTitle' }, '主动性'),
            h('span', { className: 'wb-cardAction wb-hint' }, busy ? '保存中…' : '随时可调')
          ),
          h('div', { className: 'wb-levels', role: 'group', 'aria-label': '主动性档位' },
            ['L1', 'L2', 'L3'].map(function (level) {
              var info = AUTONOMY[level]
              return h('button', {
                key: level,
                type: 'button',
                className: 'wb-level',
                'data-on': level === autonomy ? '' : undefined,
                'aria-pressed': level === autonomy,
                disabled: autonomyLocked,
                onClick: function () { void setAutonomyLevel(level) },
              },
                h('b', { className: 'wb-levelName' }, level),
                h('span', { className: 'wb-levelMeta' }, ' · ' + info.name)
              )
            })
          ),
          h('p', { className: 'wb-copy' }, autonomyInfo.text),
          autonomy === 'L1'
            ? null
            : h('div', { className: 'wb-cap', 'data-dsh-part': 'colleague-notice-cap' },
                h('span', { className: 'wb-capLabel' }, '每天最多'),
                h('button', {
                  type: 'button',
                  className: 'wb-stepBtn',
                  'aria-label': '减少上限',
                  disabled: busy || isDirty('profile') || noticeCap <= 1,
                  onClick: function () { void changeNoticeCap(noticeCap - 1) },
                }, '−'),
                h('b', { className: 'wb-capValue' }, String(noticeCap)),
                h('button', {
                  type: 'button',
                  className: 'wb-stepBtn',
                  'aria-label': '增加上限',
                  disabled: busy || isDirty('profile') || noticeCap >= 5,
                  onClick: function () { void changeNoticeCap(noticeCap + 1) },
                }, '+'),
                h('span', { className: 'wb-capUnit' }, '条')
              ),
          isDirty('profile')
            ? h('p', { className: 'wb-hint', style: { marginTop: '6px' } }, '档案有未保存的改动，保存后再改档位。')
            : null,
          h('div', { className: 'wb-meter', 'aria-hidden': 'true' },
            [1, 2, 3].map(function (step) {
              return h('span', { key: step, 'data-on': step <= Number(autonomy.slice(1)) ? '' : undefined })
            })
          )
        ),
        h('section', { className: 'wb-card', 'data-dsh-part': 'colleague-workspaces' },
          h('div', { className: 'wb-cardHead' },
            h('h3', { className: 'wb-cardTitle' }, '工作区'),
            h('span', { className: 'wb-cardAction wb-hint' }, bound.length + ' 个已绑定')
          ),
          boundRows.length !== 0
            ? boundRows
            : h('p', { className: 'wb-inlineEmpty' }, '还没绑工作区——绑一个，她才好在那个目录里干活。'),
          h('button', {
            type: 'button',
            className: 'wb-wsAdd',
            disabled: busy,
            onClick: function () { setWsOpen(!wsOpen) },
          }, wsOpen ? '收起' : '＋ 指定工作区'),
          wsOpen ? unboundRows : null,
          wsOpen && unboundRows.length === 0 ? h('p', { className: 'wb-inlineEmpty' }, '全部已指定') : null
        ),
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-cardHead' },
            h('h3', { className: 'wb-cardTitle' }, '档案原文'),
            h('div', { className: 'wb-cardAction' },
              h('button', {
                type: 'button',
                className: 'wb-btn',
                disabled: busy,
                onClick: function () { setEditing(editing === 'profile' ? null : 'profile') },
              }, editing === 'profile' ? '收起' : '编辑')
            )
          ),
          editing === 'profile'
            ? editor('profile.md', 'profile')
            : (function () {
                var parsed = profileFields(textOfFile.profile)
                return h('div', null,
                  field('岗位', parsed.role || (selectedEmployee !== null && selectedEmployee.role ? selectedEmployee.role : '未定')),
                  field('档位', parsed.autonomy || (selectedEmployee === null ? 'L2' : selectedEmployee.autonomy)),
                  field('脾气', parsed.temperament || '未定'),
                  field('工作区', parsed.workspaces.length === 0 ? '未绑定' : parsed.workspaces.join('，'))
                )
              })()
        )
      )

      var memoryPane = h('div', { className: 'wb-pane', 'data-dsh-part': 'colleague-pane-memory' },
        SECTIONS.map(function (section) {
          var text = textOfFile[section.file]
          var entries = memoryLines(text)
          var editingHere = editing === section.file
          var note = section.file === 'hot' ? entries.length + ' 条 · ' + section.note : section.note
          return h('section', { className: 'wb-card', key: section.file },
            h('div', { className: 'wb-cardHead' },
              h('h3', { className: 'wb-cardTitle' }, section.label),
              h('div', { className: 'wb-cardAction' },
                h('span', { className: 'wb-hint' }, note),
                h('button', {
                  type: 'button',
                  className: 'wb-btn',
                  disabled: busy,
                  onClick: function () { setEditing(editingHere ? null : section.file) },
                }, editingHere ? '收起' : '编辑')
              )
            ),
            editingHere
              ? editor(section.rel, section.file)
              : (entries.length === 0
                  ? h('p', { className: 'wb-inlineEmpty' }, section.empty)
                  : entries.map(function (entry) {
                      return h('article', { className: 'wb-entry', key: entry.line },
                        entry.text.charAt(0) === '#'
                          ? h('p', { className: 'wb-entryHead' }, entry.text.replace(/^#+\s*/, ''))
                          : h('p', { className: 'wb-entryText' }, displayLine(entry.text)),
                        h('p', { className: 'wb-src' }, section.rel + ' · 第 ' + entry.line + ' 行')
                      )
                    }))
          )
        })
      )

      var taskRows = taskItems.map(function (task) {
        var done = task.status !== 'open'
        return h('label', { className: 'wb-task', key: task.id },
          h('input', {
            type: 'checkbox',
            checked: done,
            disabled: busy,
            onChange: function () { void toggleTask(task.id) },
          }),
          h('span', { className: 'wb-taskText' + (done ? ' wb-taskDone' : '') }, task.text),
          typeof task.due === 'string' && task.due !== '' ? h('span', { className: 'wb-taskDue' }, task.due) : null
        )
      })

      var tasksPane = h('div', { className: 'wb-pane', 'data-dsh-part': 'colleague-pane-tasks' },
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-cardHead' },
            h('h3', { className: 'wb-cardTitle' }, '待办'),
            h('span', { className: 'wb-cardAction wb-hint' }, openTaskCount + ' 件未完成')
          ),
          taskRows.length === 0
            ? h('p', { className: 'wb-inlineEmpty' }, '还没有待办。她答应你的事、你交办的事都会落到这里。')
            : taskRows
        ),
        h('p', { className: 'wb-hint' }, '勾选即保存')
      )

      var rosterPane = h('div', { className: 'wb-pane', 'data-dsh-part': 'colleague-pane-roster' },
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-cardHead' },
            h('h3', { className: 'wb-cardTitle' }, '花名册'),
            h('div', { className: 'wb-cardAction' },
              h('span', { className: 'wb-hint' }, '全员可见'),
              h('button', {
                type: 'button',
                className: 'wb-btn',
                disabled: busy,
                onClick: function () { setEditing(editing === 'roster' ? null : 'roster') },
              }, editing === 'roster' ? '收起' : '编辑')
            )
          ),
          editing === 'roster'
            ? editor('_shared/roster.md', 'roster')
            : (memoryLines(textOfFile.roster).length === 0
                ? h('p', { className: 'wb-inlineEmpty' }, '还没有花名册。写下谁在、各做什么，所有同事都会读到。')
                : memoryLines(textOfFile.roster).map(function (entry) {
                    return h('article', { className: 'wb-entry', key: entry.line },
                      entry.text.charAt(0) === '#'
                        ? h('p', { className: 'wb-entryHead' }, entry.text.replace(/^#+\s*/, ''))
                        : h('p', { className: 'wb-entryText' }, displayLine(entry.text)),
                      h('p', { className: 'wb-src' }, '_shared/roster.md · 第 ' + entry.line + ' 行')
                    )
                  }))
        )
      )

      var logRows = changelogRows(textOfFile.changelog)
      var changelogPane = h('div', { className: 'wb-pane', 'data-dsh-part': 'colleague-pane-changelog' },
        h('section', { className: 'wb-card' },
          h('div', { className: 'wb-cardHead' },
            h('h3', { className: 'wb-cardTitle' }, '变更'),
            h('span', { className: 'wb-cardAction wb-hint' }, '只读 · 每次保存追加一行')
          ),
          logRows.length === 0
            ? h('p', { className: 'wb-inlineEmpty' }, '还没有变更记录。')
            : logRows.map(function (row, index) {
                return h('div', { className: 'wb-logRow', key: String(index) },
                  h('span', { className: 'wb-logTime' }, row.time === '' ? '—' : row.time),
                  h('div', { className: 'wb-logWhat' },
                    row.source === '' ? null : h('span', { className: 'wb-logSource' }, row.source + '：'),
                    row.what
                  )
                )
              })
        )
      )

      var panes = {
        profile: profilePane,
        memory: memoryPane,
        tasks: tasksPane,
        roster: rosterPane,
        changelog: changelogPane,
      }
      var activePane = panes[tab] || profilePane

      var previewPane = h('aside', { className: 'wb-preview', 'data-dsh-part': 'colleague-preview' },
        h('div', { className: 'wb-previewHead' },
          '她开场收到什么',
          h('span', { className: 'wb-hint' }, preview === '' ? '' : preview.length + ' 字'),
          h('button', { type: 'button', className: 'wb-btn', onClick: function () { setPreviewOpen(false) } }, '收起')
        ),
        h('pre', {
          className: 'wb-pre' + (preview === '' ? ' wb-preEmpty' : ''),
          'data-dsh-part': 'colleague-preview-text',
        }, preview === '' ? '（先选一个同事）' : preview)
      )

      var emptyHero = h('div', { className: 'wb-emptyHero' },
        h('h2', null, '还没有同事。'),
        h('p', { className: 'wb-copy' }, '建一个：起个名字、挑个岗位，她就能带着档案和记忆上岗。记忆是文件，随时能看、能改、能带走。'),
        h('button', { type: 'button', className: 'wb-btn wb-btnPrimary', onClick: openWizard }, '＋ 新同事')
      )

      var main = colleague === null
        ? h('div', { className: 'wb-main' }, emptyHero)
        : h('div', { className: 'wb-main' },
            profileHead(),
            tabs,
            activePane
          )

      /**
       * @returns {*}
       */
      function wizardStep() {
        var draft = wizard
        if (draft === null) return null
        if (draft.step === 0) {
          return h('div', null,
            h('h3', { className: 'wb-wizardH' }, '先给她起个名字。'),
            h('p', { className: 'wb-wizardLead' }, '名字自带脾气——你选的不只是称呼，是她以后说话的方式。挑一个顺眼的，也可以自己起。'),
            h('div', { className: 'wb-grid' },
              PERSONAS.map(function (persona) {
                return h('button', {
                  key: persona.name,
                  type: 'button',
                  className: 'wb-option',
                  'data-on': draft.persona === persona.name ? '' : undefined,
                  onClick: function () { pickPersona(persona) },
                },
                  avatar(persona.name, false),
                  h('span', { className: 'wb-optionText' },
                    h('span', { className: 'wb-optionName' }, persona.name + ' ' + persona.latin),
                    h('span', { className: 'wb-optionMeta' }, persona.temperament)
                  )
                )
              })
            ),
            h('input', {
              className: 'wb-input',
              placeholder: '或者自己起一个，比如 阿望',
              value: draft.name,
              onChange: function (event) { setWizardField({ name: event.target.value, persona: '' }) },
            }),
            h('p', { className: 'wb-hint', style: { marginTop: '8px' } }, '名字会写进档案，之后也能改。')
          )
        }
        if (draft.step === 1) {
          return h('div', null,
            h('h3', { className: 'wb-wizardH' }, '她做什么活？'),
            h('p', { className: 'wb-wizardLead' }, '岗位决定她默认的工具和口吻；写进档案，列表里也会显示。'),
            h('div', { className: 'wb-grid' },
              ROLES.map(function (role) {
                return h('button', {
                  key: role,
                  type: 'button',
                  className: 'wb-option',
                  'data-on': draft.role === role ? '' : undefined,
                  onClick: function () { setWizardField({ role: role }) },
                },
                  h('span', { className: 'wb-optionText' }, h('span', { className: 'wb-optionName' }, role))
                )
              })
            ),
            h('input', {
              className: 'wb-input',
              placeholder: '也可以写自己的，比如 视频、美术',
              value: draft.role,
              onChange: function (event) { setWizardField({ role: event.target.value }) },
            })
          )
        }
        if (draft.step === 2) {
          return h('div', null,
            h('h3', { className: 'wb-wizardH' }, '她是什么脾气？'),
            h('p', { className: 'wb-wizardLead' }, '一句话就够。她会照这个调整说话方式；以后改档案也行。'),
            h('input', {
              className: 'wb-input',
              maxLength: 80,
              placeholder: '比如：温和、耐心，先给结论再解释',
              value: draft.temperament,
              onChange: function (event) { setWizardField({ temperament: event.target.value }) },
            }),
            h('p', { className: 'wb-hint', style: { marginTop: '8px' } }, draft.temperament.length + ' / 80 字')
          )
        }
        return h('div', null,
          h('h3', { className: 'wb-wizardH' }, '她主动到什么程度？'),
          h('p', { className: 'wb-wizardLead' }, '随时能改，任何一档都能一键降到 L1。'),
          h('div', { className: 'wb-grid' },
            ['L1', 'L2', 'L3'].map(function (level) {
              var info = AUTONOMY[level]
              return h('button', {
                key: level,
                type: 'button',
                className: 'wb-option',
                'data-on': draft.autonomy === level ? '' : undefined,
                onClick: function () { setWizardField({ autonomy: level }) },
              },
                h('span', { className: 'wb-optionText' },
                  h('span', { className: 'wb-optionName' }, level + ' · ' + info.name),
                  h('span', { className: 'wb-optionMeta' }, info.text)
                )
              )
            })
          )
        )
      }

      /**
       * @returns {*}
       */
      function wizardPreview() {
        var draft = wizard
        if (draft === null) return null
        return h('aside', { className: 'wb-wizardPreview' },
          h('div', { className: 'wb-cardHead' }, h('h3', { className: 'wb-cardTitle' }, '她大概会是这样')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            avatar(draft.name || '?', false),
            h('div', { style: { minWidth: '0' } },
              h('div', { className: 'wb-optionName' }, draft.name.trim() === '' ? '还没名字' : draft.name),
              h('div', { className: 'wb-optionMeta' }, draft.role.trim() === '' ? '岗位待选' : draft.role)
            )
          ),
          h('div', { style: { marginTop: '12px' } },
            field('档位', draft.autonomy + ' · ' + AUTONOMY[draft.autonomy].name),
            field('脾气', draft.temperament.trim() === '' ? '待定' : draft.temperament)
          )
        )
      }

      var wizardLayer = wizard === null ? null : h('div', {
        className: 'wb-wizard',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '新建同事',
        onKeyDown: function (event) { if (event.key === 'Escape') setWizard(null) },
      },
        h('div', { className: 'wb-wizardHead' },
          h('h2', { className: 'wb-wizardTitle' }, '新同事'),
          h('span', { className: 'wb-hint' }, '第 ' + (wizard.step + 1) + ' 步，共 ' + STEPS.length + ' 步'),
          h('div', { className: 'wb-steps' },
            STEPS.map(function (label, index) {
              return h('span', { key: label, className: 'wb-step', 'data-on': index === wizard.step ? '' : undefined },
                h('b', null, String(index + 1)),
                label
              )
            })
          )
        ),
        h('div', { className: 'wb-wizardBody' },
          h('div', { className: 'wb-wizardMain' }, wizardStep()),
          wizardPreview()
        ),
        h('div', { className: 'wb-wizardFoot' },
          h('button', { type: 'button', className: 'wb-btn', disabled: wizard.step === 0, onClick: wizardBack }, '上一步'),
          h('button', { type: 'button', className: 'wb-btn', onClick: function () { setWizard(null) } }, '取消'),
          h('span', { className: 'wb-hint' }, '两分钟就能上岗；名字之后也能改。'),
          wizard.step === STEPS.length - 1
            ? h('button', { type: 'button', className: 'wb-btn wb-btnPrimary', disabled: busy, onClick: function () { void submitWizard() } }, busy ? '创建中…' : '建她')
            : h('button', { type: 'button', className: 'wb-btn wb-btnPrimary', onClick: wizardNext }, '下一步')
        )
      )

      return h('div', {
        className: 'wb-root',
        'data-dsh-plugin': 'whalebuddy',
        'data-preview': previewOpen ? 'open' : 'closed',
        'data-wb-theme': theme,
        ref: rootRef,
      },
        header,
        h('div', { className: 'wb-body' },
          list,
          main,
          previewPane,
          h('div', { className: 'wb-scrim', onClick: function () { setPreviewOpen(false) } })
        ),
        wizardLayer
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
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.warn('[whalebuddy] slots service missing; colleague console not mounted')
          return
        }

        var watcher = createNoticeWatcher({
          api: api,
          document: typeof document === 'undefined' ? undefined : document,
          timers: typeof window !== 'undefined' && typeof window.setInterval === 'function' ? window : undefined,
        })
        var Page = createPage(React, api, { startSession: startSession, notices: watcher })
        var disposers = [function () { watcher.stop() }]
        watcher.start()
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
