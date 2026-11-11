// ==UserScript==
// @name         Qianchuan Live Speed Scheduler (Android)
// @namespace    local.qianchuan.live-speed-scheduler
// @version      1.2.7
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-android.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-android.user.js
// @description  Android edition based on Windows v1.2.3: scheduled live tasks, automatic verification and local takeover.
// @match        https://qianchuan.jinritemai.com/overall-prom*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const ROOT = 'qc-live-speed-scheduler-root';
  if (window.top !== window.self || document.getElementById(ROOT)) return;
  const host = document.createElement('div');
  host.id = ROOT;
  host.style.cssText = 'position:fixed;right:0;top:60%;z-index:2147483646;padding:10px;background:#eaf3ff;color:#175aaf;border-radius:10px 0 0 10px;font:12px sans-serif;pointer-events:auto';
  host.textContent = '\u8C03\u901F\u52A9\u624B\u6B63\u5728\u542F\u52A8';
  document.documentElement.appendChild(host);
  try {

  const LEGACY_RUN_KEY = 'qc-live-speed-scheduler-run-v1';
  const LEGACY_LOG_KEY = 'qc-live-speed-scheduler-report-v1';
  const TAB_KEY = 'qc-live-speed-scheduler-tab-v1';
  const PLAN_KEY_PREFIX = 'qc-live-speed-scheduler-plan-v2-';
  const LAUNCHER_KEY = 'qc-live-speed-scheduler-launcher-top-v1';
  const TICK_MS = 5000;
  const LATE_MS = 5 * 60 * 1000;
  const MAX_SCAN_PAGES = 100;
  const SUBMIT_VERIFY_MS = 3 * 60 * 1000;
  const VERIFY_RETRY_MS = 5000;
  const MAX_VERIFY_SCANS = 8;
  let tabToken = '';
  try {
    tabToken = sessionStorage.getItem(TAB_KEY) || '';
    if (!tabToken) {
      tabToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(TAB_KEY, tabToken);
    }
  } catch (_) { /* \u65E0\u6CD5\u8DE8\u5237\u65B0\u786E\u8BA4\u539F\u6807\u7B7E\u9875\u65F6\u4E0D\u81EA\u52A8\u7EED\u8DD1 */ }
  const RUN_KEY = 'qc-live-speed-scheduler-run-v2-' + tabToken;
  const LOG_KEY = 'qc-live-speed-scheduler-report-v2-' + tabToken;
  const CFG_KEY = 'qc-live-speed-scheduler-config-v2-' + tabToken;
  function planRunKey(run) { return PLAN_KEY_PREFIX + run.accountId + '-' + run.planId; }
  function activeRun(run) { return !!run && ['scheduled', 'submitting', 'needs_review'].includes(run.status); }
  function runDay(run) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(run?.day || '')) return run.day;
    const startedAt = Number(run?.startedAt);
    return Number.isFinite(startedAt) && startedAt > 0 ? localDay(new Date(startedAt)) : '';
  }
  function retireOldPlanLease(lock, saved) {
    const key = planRunKey(lock);
    const other = GM_getValue(key, null);
    if (!activeRun(other)) return other;
    const oldDay = runDay(other);
    const orphanedInThisTab = other.owner === tabToken &&
      (!activeRun(saved) || saved.startedAt !== other.startedAt);
    if (!(oldDay && oldDay < localDay()) && !orphanedInThisTab) return other;
    const latest = GM_getValue(key, null);
    if (!latest || latest.owner !== other.owner || latest.startedAt !== other.startedAt ||
        latest.status !== other.status) return latest;
    GM_setValue(key, { ...latest, status: 'complete', updatedAt: Date.now(),
      reason: oldDay && oldDay < localDay() ? '\u524D\u4E00\u65E5\u8F6E\u6B21\u5DF2\u7ED3\u675F' : '\u672C\u6807\u7B7E\u9875\u65E0\u5BF9\u5E94\u7684\u8FD0\u884C\u8F6E\u6B21' });
    return null;
  }
  let initialRun = GM_getValue(RUN_KEY, null);
  if (!initialRun && tabToken) {
    const legacy = GM_getValue(LEGACY_RUN_KEY, null);
    if (legacy && legacy.owner === tabToken) {
      initialRun = legacy;
      GM_setValue(RUN_KEY, legacy);
      const previous = GM_getValue(planRunKey(legacy), null);
      if (!activeRun(previous) ||
          (previous.owner === legacy.owner && previous.startedAt === legacy.startedAt)) {
        GM_setValue(planRunKey(legacy), { owner: legacy.owner, startedAt: legacy.startedAt,
          day: runDay(legacy), status: legacy.status, updatedAt: Date.now() });
      }
    }
  }
  if (activeRun(initialRun) && runDay(initialRun) && runDay(initialRun) < localDay()) {
    initialRun.status = 'complete';
    initialRun.nextAt = 0;
    initialRun.reason = '\u524D\u4E00\u65E5\u8F6E\u6B21\u5DF2\u7ED3\u675F\uFF1B\u6628\u65E5\u672A\u786E\u8BA4\u7684\u63D0\u4EA4\u8BF7\u4EBA\u5DE5\u6838\u5BF9';
    GM_setValue(RUN_KEY, initialRun);
    retireOldPlanLease(initialRun, initialRun);
  }
  const initialReport = GM_getValue(LOG_KEY,
    initialRun ? GM_getValue(LEGACY_LOG_KEY, '') : '');
  const cfg = Object.assign({ budget: '', hours: '', intervalHours: '', dailyCap: '' },
    GM_getValue(CFG_KEY, GM_getValue('qc-live-speed-scheduler-config-v1', {})));
  if (cfg.intervalHours === '' && Number(cfg.intervalMinutes) > 0) cfg.intervalHours = Number(cfg.intervalMinutes) / 60;
  const state = {
    open: false, busy: false, reloading: false, stopAfterSubmit: false, stopRequested: false, phase: '\u8BF7\u9501\u5B9A\u5F53\u524D\u76F4\u64AD\u8BA1\u5212',
    lock: null, run: initialRun, rows: [], selectedId: '',
    logs: [], report: initialReport, panelScroll: 0,
    launcherTop: Math.max(12, Math.min(88, Number(GM_getValue(LAUNCHER_KEY, 66)) || 66))
  };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function text(el) { return (el && (el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' '); }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  function layoutVisible(el) {
    if (!el || !el.isConnected) return false;
    for (let node=el;node&&node.nodeType===1;node=node.parentElement) {
      const style=getComputedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||node.hidden||node.getAttribute('aria-hidden')==='true')return false;
    }
    return visible(el)||Array.from(el.querySelectorAll('th,td,input,button,label,span')).some(visible);
  }
  function normalizeHeader(value) {
    return String(value||'').replace(/\s+/g,'').replace(/\uFF08/g,'(').replace(/\uFF09/g,')').replace(/\((?:\u5143|\u5C0F\u65F6)\)/g,'').replace(/[\uFF1A:]$/,'');
  }
  function taskHeaderCells(table) {
    return Array.from(table.querySelectorAll('thead tr')).map(row=>Array.from(row.querySelectorAll(':scope > th')))
      .sort((a,b)=>b.length-a.length)[0]||[];
  }
  const taskHeaderMap=new WeakMap();
  function taskColumn(headers, aliases) {
    const indices=headers.map((value,index)=>aliases.includes(value)?index:-1).filter(index=>index>=0);
    if(indices.length!==1)throw new Error('\u4EFB\u52A1\u5217\u5E94\u552F\u4E00\uFF1A'+aliases[0]+'\uFF0C\u5B9E\u9645'+indices.length+'\u5904');
    return indices[0];
  }
  function one(items, label) {
    const found = Array.from(items).filter(layoutVisible);
    if (found.length !== 1) throw new Error(label + '\u5E94\u6070\u597D\u51FA\u73B0\u4E00\u6B21\uFF0C\u5B9E\u9645 ' + found.length + ' \u6B21');
    return found[0];
  }
  function localDay(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const get = type => parts.find(x => x.type === type).value;
    return get('year') + '-' + get('month') + '-' + get('day');
  }
  function moneyCents(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) - n * 100) > 0.000001) return NaN;
    return Math.round(n * 100);
  }
  function yuan(cents) { return (cents / 100).toFixed(2); }
  function timeText(ms) {
    return ms ? new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '\u2014';
  }
  function durationText(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '00:00:00';
    const seconds = Math.ceil(ms / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
      .map(n => String(n).padStart(2, '0')).join(':');
  }
  function saveRun() {
    GM_setValue(RUN_KEY, state.run);
    if (state.run) {
      const key = planRunKey(state.run), current = GM_getValue(key, null);
      if (!current || (!activeRun(current) && Number(state.run.startedAt) > Number(current.startedAt || 0)) ||
          (current.owner === state.run.owner && current.startedAt === state.run.startedAt)) {
        GM_setValue(key, { owner: state.run.owner, startedAt: state.run.startedAt,
          day: state.run.day, status: state.run.status, updatedAt: Date.now() });
      }
    }
    render();
  }
  function saveCfg() { GM_setValue(CFG_KEY, cfg); }
  function log(message) {
    const line = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '  ' + message;
    state.logs.push(line);
    state.logs = state.logs.slice(-100);
    if (state.run) {
      state.run.logs = (state.run.logs || []).concat(line).slice(-120);
      saveRun();
    }
    render();
  }
  function phase(message) { state.phase = message; render(); }
  function report(message) {
    const r = state.run;
    state.report = [
      '\u5343\u5DDD\u76F4\u64AD\u5B9A\u65F6\u4E00\u952E\u8C03\u901F\u52A9\u624B',
      r ? '\u8D26\u6237 ID\uFF1A' + r.accountId + '\uFF1B\u8BA1\u5212\uFF1A' + r.planName + '\uFF08' + r.planId + '\uFF09' : '\u672A\u542F\u52A8',
      r ? '\u65E5\u671F\uFF1A' + r.day + '\uFF1B\u5355\u6B21\u9884\u7B97\uFF1A' + yuan(r.budgetCents) + '\u5143\uFF1B\u65F6\u957F\uFF1A' + r.hours + '\u5C0F\u65F6\uFF1B\u95F4\u9694\uFF1A' + r.intervalMinutes / 60 + '\u5C0F\u65F6\uFF1B\u5F53\u65E5\u4E0A\u9650\uFF1A' + yuan(r.capCents) + '\u5143' : '',
      r ? '\u672C\u8F6E\u5DF2\u786E\u8BA4\u4EFB\u52A1\uFF1A' + (r.confirmed || []).length + ' \u6B21\uFF1B\u6700\u8FD1\u6838\u5BF9\u7684\u8BE5\u8BA1\u5212\u4ECA\u65E5\u8C03\u63A7\u9884\u7B97\uFF1A' + yuan(r.lastTodayCents || 0) + '\u5143' : '',
      r ? '\u72B6\u6001\uFF1A' + r.status + '\uFF1B\u4E0B\u6B21\u6267\u884C\uFF1A' + timeText(r.nextAt) : '',
      '\u7ED3\u679C\uFF1A' + message,
      '', ...(r && r.logs || state.logs).slice(-50)
    ].filter(Boolean).join('\n');
    GM_setValue(LOG_KEY, state.report);
    render();
  }
  function stopRun(message, status = 'stopped') {
    if (state.run) {
      state.run.status = status;
      state.run.nextAt = 0;
      state.run.reason = message;
      saveRun();
    }
    phase((status === 'complete' ? '\u5F53\u65E5\u5B8C\u6210\uFF1A' : '\u5DF2\u505C\u6B62\uFF1A') + message);
    log(message);
    report(message);
  }
  function blockCheck() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .main-vmok-plugin-modal__wrap, .tools-vmok-plugin-modal__wrap'))
      .filter(visible);
    const words = dialogs.map(text).join(' ');
    if (/\u9A8C\u8BC1\u7801|\u6ED1\u5757\u9A8C\u8BC1|\u767B\u5F55\u5931\u6548|\u6743\u9650\u4E0D\u8DB3|\u8BBF\u95EE\u53D7\u9650|\u5E73\u53F0\u98CE\u63A7/.test(words)) {
      throw new Error('\u51FA\u73B0\u767B\u5F55\u3001\u9A8C\u8BC1\u3001\u6743\u9650\u6216\u98CE\u63A7\u63D0\u793A');
    }
    if (dialogs.some(el => !text(el).includes('\u65B0\u5EFA\u8C03\u63A7\u4EFB\u52A1'))) {
      throw new Error('\u51FA\u73B0\u5176\u4ED6\u5343\u5DDD\u5F39\u7A97\uFF1B\u8BF7\u5148\u4EBA\u5DE5\u5904\u7406');
    }
  }
  function assertLease() {
    if (!activeRun(state.run)) return;
    const saved = GM_getValue(RUN_KEY, null);
    const plan = GM_getValue(planRunKey(state.run), null);
    if (!saved || saved.owner !== tabToken || saved.startedAt !== state.run.startedAt ||
        saved.status !== state.run.status || !plan || plan.owner !== tabToken ||
        plan.startedAt !== state.run.startedAt || plan.status !== state.run.status) {
      throw new Error('\u672C\u8F6E\u5DF2\u5728\u53E6\u4E00\u6807\u7B7E\u9875\u6539\u53D8\u6216\u505C\u6B62');
    }
  }
  function urlContext() {
    const u = new URL(location.href);
    if (u.origin !== 'https://qianchuan.jinritemai.com' ||
        !['/overall-prom', '/overall-prom/detail'].includes(u.pathname) ||
        !u.hash.includes('marGoal=2') || u.searchParams.get('campaignType') !== '1' ||
        u.searchParams.get('uniTab') !== 'ad' || !/^\d+$/.test(u.searchParams.get('aavid') || '')) {
      throw new Error('\u8BF7\u8FDB\u5165\u5343\u5DDD\u4E58\u65B9\u7684\u76F4\u64AD\u8BA1\u5212\u9875\u9762');
    }
    return { accountId: u.searchParams.get('aavid'), detail: u.pathname.endsWith('/detail'), planId: u.searchParams.get('adId') || '' };
  }
  function overviewRows() {
    const u = urlContext();
    if (u.detail) return [];
    return Array.from(document.querySelectorAll('tr[data-row-key]')).filter(visible).map(row => {
      const id = row.getAttribute('data-row-key') || '';
      const cells = row.querySelectorAll('td');
      const nameEl = row.querySelector('[id="ad-name-' + id + '"] .aurora-qc-typography-content');
      return { id, name: text(nameEl), active: cells.length > 2 && /\u6295\u653E\u4E2D/.test(text(cells[2])), row };
    }).filter(item => /^\d+$/.test(item.id) && item.name);
  }
  function detailIdentity() {
    const u = urlContext();
    if (!u.detail) throw new Error('\u5F53\u524D\u4E0D\u662F\u8BA1\u5212\u8BE6\u60C5\u9875');
    const drawer = one(document.querySelectorAll('.ad-detail-wrapper'), '\u76F4\u64AD\u8BA1\u5212\u8BE6\u60C5');
    const identity=text(drawer).match(/\u8BA1\u5212\s*ID\s*[\uFF1A:]\s*(\d+)/i);
    if(!identity||identity[1]!==u.planId)throw new Error('\u8BA1\u5212\u8BE6\u60C5ID\u4E0E\u7F51\u5740\u4E0D\u4E00\u81F4\u6216\u5C1A\u672A\u52A0\u8F7D');
    const name = text(drawer.querySelector('[class*="title-"]')) || '';
    return { accountId: u.accountId, planId: u.planId, name, active: /\u6295\u653E\u4E2D/.test(drawer.innerText.slice(0, 650)), drawer };
  }
  function assertIdentity() {
    blockCheck();
    if (!state.run && !state.lock) throw new Error('\u5C1A\u672A\u9501\u5B9A\u76F4\u64AD\u8BA1\u5212');
    const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
    if (!lock) throw new Error('\u5C1A\u672A\u9501\u5B9A\u76F4\u64AD\u8BA1\u5212');
    const u = urlContext();
    if (u.accountId !== lock.accountId) throw new Error('\u8D26\u6237\u5DF2\u5207\u6362');
    if (u.detail) {
      const d = detailIdentity();
      if (d.planId !== lock.planId || !d.active) throw new Error('\u8BA1\u5212\u5DF2\u5207\u6362\u6216\u4E0D\u5728\u6295\u653E\u4E2D');
      return d;
    }
    const row = overviewRows().find(x => x.id === lock.planId);
    if (!row || !row.active || row.name !== lock.planName) throw new Error('\u5F53\u524D\u9875\u627E\u4E0D\u5230\u9501\u5B9A\u7684\u5728\u6295\u76F4\u64AD\u8BA1\u5212');
    return { accountId: u.accountId, planId: row.id, name: row.name, active: true, row: row.row };
  }
  async function wait(check, label, timeout = 16000) {
    const end = Date.now() + timeout;
    while (true) {
      blockCheck();
      const value = check();
      if (value) return value;
      if (Date.now() >= end) break;
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    throw new Error(label + '\u7B49\u5F85\u8D85\u65F6');
  }
  async function click(el, label) {
    const resolve = typeof el === 'function' ? el : () => el;
    let target = resolve();
    if (!target || !target.isConnected) throw new Error(label + '\u4E0D\u5B58\u5728');
    if (state.stopRequested && state.run?.status !== 'submitting') throw new Error('\u7528\u6237\u8BF7\u6C42\u505C\u6B62\uFF0C\u672A\u7EE7\u7EED\u63D0\u4EA4');
    assertLease();
    assertIdentity();
    phase('\u5373\u5C06\u64CD\u4F5C\uFF1A' + label);
    await new Promise(resolve => setTimeout(resolve, 180));
    target = typeof el === 'function' ? await wait(() => {
      try { const fresh = resolve(); return fresh?.isConnected ? fresh : null; }
      catch (_) { return null; }
    }, label + '\u5237\u65B0\u540E\u5165\u53E3', 10000) : resolve();
    if (!target || !target.isConnected) throw new Error(label + '\u5728\u70B9\u51FB\u524D\u6D88\u5931');
    if (state.stopRequested && state.run?.status !== 'submitting') throw new Error('\u7528\u6237\u8BF7\u6C42\u505C\u6B62\uFF0C\u672A\u7EE7\u7EED\u63D0\u4EA4');
    assertLease();
    assertIdentity();
    target.click();
    await new Promise(resolve => setTimeout(resolve, 420));
  }
  function chooseLock() {
    try {
      if (state.busy) throw new Error('\u6267\u884C\u4E2D\u4E0D\u53EF\u66F4\u6362\u8BA1\u5212');
      if (state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status)) {
        throw new Error('\u5DF2\u6709\u672A\u7ED3\u675F\u7684\u4E00\u952E\u8C03\u901F\u8F6E\u6B21');
      }
      const u = urlContext();
      let selected;
      if (u.detail) {
        const d = detailIdentity();
        if (!d.active || !d.name) throw new Error('\u5F53\u524D\u8BE6\u60C5\u672A\u80FD\u786E\u8BA4\u5728\u6295\u8BA1\u5212\u540D\u79F0');
        selected = { id: d.planId, name: d.name };
      } else {
        const rows = overviewRows().filter(x => x.active);
        selected = rows.find(x => x.id === state.selectedId) || (rows.length === 1 ? rows[0] : null);
        if (!selected) throw new Error('\u8BF7\u5148\u5728\u52A9\u624B\u4E2D\u9009\u62E9\u5F53\u524D\u9875\u7684\u4E00\u6761\u5728\u6295\u76F4\u64AD\u8BA1\u5212');
      }
      if (state.run && (state.run.planId !== selected.id || state.run.accountId !== u.accountId) &&
          !['scheduled', 'submitting', 'needs_review'].includes(state.run.status)) {
        state.run = null;
        GM_setValue(RUN_KEY, null);
      }
      state.lock = { accountId: u.accountId, planId: selected.id, planName: selected.name };
      state.selectedId = selected.id;
      phase('\u5DF2\u9501\u5B9A ' + selected.name + '\uFF08' + selected.id + '\uFF09');
      log('\u9501\u5B9A\u8D26\u6237 ' + u.accountId + ' \u2192 ' + selected.name + '\uFF08' + selected.id + '\uFF09');
    } catch (error) { phase('\u9501\u5B9A\u5931\u8D25\uFF1A' + error.message); }
  }
  function readCfg() {
    for (const [key, id] of [['budget', 'budget'], ['hours', 'hours'], ['intervalHours', 'interval'], ['dailyCap', 'cap']]) {
      const el = shadow.getElementById(id);
      if (!el) throw new Error('\u52A9\u624B\u8868\u5355\u7F3A\u5C11 ' + id);
      cfg[key] = Number(el.value);
    }
    const budgetCents = moneyCents(cfg.budget), capCents = moneyCents(cfg.dailyCap);
    if (!Number.isInteger(budgetCents)) throw new Error('\u5355\u6B21\u9884\u7B97\u987B\u4E3A\u5927\u4E8E 0 \u4E14\u6700\u591A\u4E24\u4F4D\u5C0F\u6570\u7684\u91D1\u989D');
    if (!Number.isInteger(capCents) || capCents < budgetCents) throw new Error('\u5F53\u65E5\u4E0A\u9650\u987B\u4E0D\u5C0F\u4E8E\u5355\u6B21\u9884\u7B97');
    if (!Number.isFinite(cfg.hours) || cfg.hours < 0.5 || cfg.hours > 24 || !Number.isInteger(cfg.hours * 2)) {
      throw new Error('\u8C03\u63A7\u65F6\u957F\u987B\u4E3A 0.5\u201324 \u5C0F\u65F6\uFF0C\u4E14\u662F 0.5 \u7684\u6574\u6570\u500D');
    }
    const intervalMinutes = cfg.intervalHours * 60;
    if (!Number.isFinite(cfg.intervalHours) || cfg.intervalHours < 0.5 || cfg.intervalHours > 24 ||
        !Number.isInteger(cfg.intervalHours * 2) || !Number.isInteger(intervalMinutes)) {
      throw new Error('\u7EED\u6295\u95F4\u9694\u987B\u4E3A 0.5\u201324 \u5C0F\u65F6\uFF0C\u4E14\u662F 0.5 \u7684\u6574\u6570\u500D');
    }
    saveCfg();
    return { budgetCents, capCents, hours: cfg.hours, intervalMinutes };
  }
  function taskTable(drawer) {
    const selectedTab = drawer.querySelector('[id$="-tab-uni_task_center"][aria-selected="true"]');
    if (!selectedTab) throw new Error('\u5F53\u524D\u4E0D\u662F\u8BA1\u5212\u7684\u8C03\u63A7\u9875');
    if (Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-filter-echo-item')).some(visible)) {
      throw new Error('\u8C03\u63A7\u4EFB\u52A1\u5217\u8868\u5DF2\u6709\u989D\u5916\u7B5B\u9009\uFF0C\u65E0\u6CD5\u6838\u5BF9\u5F53\u65E5\u5168\u90E8\u9884\u7B97\uFF1B\u8BF7\u6E05\u9664\u7B5B\u9009');
    }
    if (drawer.querySelector('input[placeholder="\u8F93\u5165\u4EFB\u52A1\u540D\u79F0\u6216ID\u641C\u7D22"]')?.value.trim()) {
      throw new Error('\u8C03\u63A7\u4EFB\u52A1\u5217\u8868\u6B63\u5728\u6309\u4EFB\u52A1\u540D\u79F0\u6216 ID \u641C\u7D22\uFF1B\u8BF7\u6E05\u7A7A\u641C\u7D22');
    }
    if (Array.from(drawer.querySelectorAll('input[placeholder="\u8BF7\u9009\u62E9"]'))
      .some(input => visible(input) && input.value.trim())) {
      throw new Error('\u8C03\u63A7\u4EFB\u52A1\u5217\u8868\u5DF2\u6709\u72B6\u6001\u7B5B\u9009\uFF0C\u65E0\u6CD5\u6838\u5BF9\u5F53\u65E5\u5168\u90E8\u9884\u7B97\uFF1B\u8BF7\u6E05\u9664\u7B5B\u9009');
    }
    const tab = one(Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(x => text(x) === '\u4E00\u952E\u8C03\u901F'), '\u4E00\u952E\u8C03\u901F\u4EFB\u52A1\u6807\u7B7E');
    if (!tab.className.includes('--checked')) throw new Error('\u5F53\u524D\u8C03\u63A7\u5217\u8868\u4E0D\u662F\u4E00\u952E\u8C03\u901F');
    const tables=Array.from(drawer.querySelectorAll('table')).filter(layoutVisible);
    const required=[['\u4EFB\u52A1\u540D\u79F0'],['\u8C03\u63A7\u72B6\u6001'],['\u8C03\u63A7\u65B9\u5F0F'],['\u8D77\u91CF\u63A2\u7D22\u76EE\u6807'],['\u8C03\u63A7\u9884\u7B97','\u8C03\u63A7\u603B\u9884\u7B97'],['\u8C03\u63A7\u65F6\u957F'],['\u521B\u5EFA\u65F6\u95F4']];
    const candidates=tables.map(head=>({head,headers:taskHeaderCells(head).map(cell=>normalizeHeader(text(cell)))}))
      .filter(candidate=>required.every(aliases=>aliases.some(label=>candidate.headers.includes(label))));
    if(!candidates.length)throw new Error('\u8C03\u63A7\u5217\u8868\u9884\u7B97\u3001\u65F6\u957F\u6216\u521B\u5EFA\u65F6\u95F4\u8868\u5934\u672A\u5C31\u7EEA');
    const pairs=[];
    for(const candidate of candidates){
      for(let root=candidate.head;root&&drawer.contains(root);root=root.parentElement){
        const bodies=(root===candidate.head?[root]:Array.from(root.querySelectorAll('table'))).filter(layoutVisible)
          .filter(body=>{
            const rows=Array.from(body.querySelectorAll('tbody tr')).filter(layoutVisible)
              .filter(row=>!/(?:\u6682\u65E0\u6570\u636E|\u6682\u65E0\u4EFB\u52A1|\u6682\u65E0\u8BB0\u5F55|\u5171\s*0\s*\u6761)/.test(text(row)));
            return rows.length&&rows.every(row=>row.querySelectorAll(':scope > td').length===candidate.headers.length&&/ID[\uFF1A:]\s*\d+/.test(text(row)));
          });
        if(bodies.length){for(const data of bodies)pairs.push({...candidate,data});break;}
        if(root===drawer)break;
      }
    }
    const signatures=new Set(pairs.map(pair=>pair.headers.join('|')+':'+text(pair.data)));
    if(signatures.size>1)throw new Error('\u8C03\u63A7\u5217\u8868\u5B58\u5728\u4E0D\u4E00\u81F4\u7684\u4EFB\u52A1\u8868\uFF0C\u7B49\u5F85\u9875\u9762\u52A0\u8F7D\u5B8C\u6210');
    const pair=pairs[0];
    const data=pair?.data||null;
    if(data)taskHeaderMap.set(data,pair.headers);
    const footers=Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper')).filter(layoutVisible);
    if(footers.length>1)throw new Error('\u4EFB\u52A1\u5206\u9875\u680F\u51FA\u73B0\u591A\u4E2A\uFF0C\u65E0\u6CD5\u6838\u5BF9\u4EFB\u52A1');
    return {data,footer:footers[0]||null};
  }

  function emptyTaskList(drawer, table) {
    if (table.data && taskRows(table.data).length) return false;
    const panel = drawer.querySelector('[id$="-panel-uni_task_center"]') || drawer;
    const labels = [panel, table.footer, ...panel.querySelectorAll(
      '.main-vmok-plugin-page-total, .main-vmok-plugin-empty, .main-vmok-plugin-table-empty, ' +
      '[class*="empty"], tbody td[colspan]')].filter(layoutVisible);
    return labels.some(el => /\u5171\s*0\s*\u6761|\u6682\u65E0(?:\u6570\u636E|\u4EFB\u52A1|\u8BB0\u5F55)|\u6CA1\u6709(?:\u6570\u636E|\u4EFB\u52A1|\u8BB0\u5F55)/.test(text(el)));
  }
  function taskListReady(drawer) {
    const table = taskTable(drawer);
    return (table.data && taskRows(table.data).length > 0) || emptyTaskList(drawer, table);
  }
  function taskRows(data) {
    if(!data)return [];
    const headers=taskHeaderMap.get(data);
    if(!headers)throw new Error('\u5C1A\u672A\u6838\u5BF9\u4EFB\u52A1\u8868\u5934\uFF0C\u8BF7\u7B49\u5F85\u4EFB\u52A1\u8868\u52A0\u8F7D');
    const nameIndex=taskColumn(headers,['\u4EFB\u52A1\u540D\u79F0']),stateIndex=taskColumn(headers,['\u8C03\u63A7\u72B6\u6001']);
    const modeIndex=taskColumn(headers,['\u8C03\u63A7\u65B9\u5F0F']),goalIndex=taskColumn(headers,['\u8D77\u91CF\u63A2\u7D22\u76EE\u6807']);
    const budgetIndex=taskColumn(headers,['\u8C03\u63A7\u9884\u7B97','\u8C03\u63A7\u603B\u9884\u7B97']),hoursIndex=taskColumn(headers,['\u8C03\u63A7\u65F6\u957F']),createdIndex=taskColumn(headers,['\u521B\u5EFA\u65F6\u95F4']);
    return Array.from(data.querySelectorAll('tbody tr')).filter(layoutVisible).map(tr=>{
      const cells=Array.from(tr.querySelectorAll(':scope > td'));
      if(cells.length<headers.length&&/\u5171\s*0\s*\u6761|\u6682\u65E0(?:\u6570\u636E|\u4EFB\u52A1|\u8BB0\u5F55)|\u6CA1\u6709(?:\u6570\u636E|\u4EFB\u52A1|\u8BB0\u5F55)/.test(text(tr)))return null;
      if(cells.length!==headers.length)throw new Error('\u8C03\u63A7\u4EFB\u52A1\u5217\u6570\u5C1A\u672A\u4E0E\u8868\u5934\u4E00\u81F4');
      const nameCell=text(cells[nameIndex]),id=(nameCell.match(/ID[\uFF1A:]\s*(\d+)/)||[])[1];
      const name=nameCell.replace(/\s*ID[\uFF1A:]\s*\d+[\s\S]*$/,'').trim();
      const created=text(cells[createdIndex]),day=(created.match(/\d{4}-\d{2}-\d{2}/)||[])[0];
      const time=(created.match(/\d{2}:\d{2}:\d{2}/)||[])[0];
      const budgetRaw=text(cells[budgetIndex]).replace(/[,\uFFE5\u00A5\s]/g,'');
      const budget=/^\d+(?:\.\d{1,2})?$/.test(budgetRaw)?Number(budgetRaw):NaN;
      const hoursMatch=text(cells[hoursIndex]).match(/^(\d+(?:\.\d+)?)(?=\s|\u5C0F\u65F6|$)/);
      const hours=hoursMatch?Number(hoursMatch[1]):NaN;
      if(!id||!name||!day||!time||!Number.isFinite(budget)||!Number.isFinite(hours))throw new Error('\u8C03\u63A7\u4EFB\u52A1\u540D\u79F0\u3001\u65E5\u671F\u6216\u91D1\u989D\u672A\u5C31\u7EEA');
      const [year,month,date]=day.split('-').map(Number),[hour,minute,second]=time.split(':').map(Number);
      return {id,name,day,budgetCents:Math.round(budget*100),hours,mode:text(cells[modeIndex]),goal:text(cells[goalIndex]),
        state:text(cells[stateIndex]),createdAt:Date.UTC(year,month-1,date,hour-8,minute,second)};
    }).filter(Boolean);
  }
  function taskDateRange(drawer) {
    const prefixes = Array.from(drawer.querySelectorAll('.main-vmok-plugin-custom-input__prefix'))
      .filter(x => visible(x) && text(x) === '\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\uFF1A');
    if (!prefixes.length) return null;
    const prefix = one(prefixes, '\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\u7B5B\u9009\u6807\u7B7E');
    const range = prefix.closest('.main-vmok-plugin-range-picker');
    if (!range) throw new Error('\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\u7B5B\u9009\u6807\u7B7E\u7ED3\u6784\u672A\u5C31\u7EEA');
    return {
      start: range.querySelector('input[placeholder="\u5F00\u59CB\u65E5\u671F"]')?.value || '',
      end: range.querySelector('input[placeholder="\u7ED3\u675F\u65E5\u671F"]')?.value || ''
    };
  }
  async function applyTodayFilter(drawer) {
    const today = localDay(), selected = taskDateRange(drawer);
    if (selected?.start === today && selected.end === today) {
      await wait(() => {
        try { const table = taskTable(drawer); return taskListReady(drawer) &&
          taskRows(table.data).every(x => x.day === today); }
        catch (_) { return false; }
      },
        '\u4ECA\u5929\u7684\u8C03\u63A7\u4EFB\u52A1\u6570\u636E\u52A0\u8F7D', 20000);
      return;
    }
    let range;
    if (selected) {
      const prefix = one(Array.from(drawer.querySelectorAll('.main-vmok-plugin-custom-input__prefix'))
        .filter(x => text(x) === '\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\uFF1A'), '\u5F53\u524D\u4EFB\u52A1\u65E5\u671F\u7B5B\u9009\u6807\u7B7E');
      range = prefix.closest('.main-vmok-plugin-range-picker');
      if (!range) throw new Error('\u5F53\u524D\u4EFB\u52A1\u65E5\u671F\u7B5B\u9009\u63A7\u4EF6\u4E0D\u5B58\u5728');
    } else {
      const more = one(Array.from(drawer.querySelectorAll('button'))
        .filter(x => text(x).startsWith('\u66F4\u591A\u7B5B\u9009')), '\u8C03\u63A7\u4EFB\u52A1\u66F4\u591A\u7B5B\u9009');
      await click(more, '\u6253\u5F00\u8C03\u63A7\u4EFB\u52A1\u66F4\u591A\u7B5B\u9009');
      range = await wait(() => {
        const editors = Array.from(document.querySelectorAll(
          '.main-vmok-plugin-oc-filter-date-range-filter .main-vmok-plugin-range-picker'))
          .filter(visible);
        if (editors.length === 1) return editors[0];
        const inputs = Array.from(document.querySelectorAll('input[placeholder="\u5F00\u59CB\u65E5\u671F"]'))
          .filter(visible);
        const ranges = inputs.map(x => x.closest('.main-vmok-plugin-range-picker'))
          .filter(x => x && x.querySelector('input[placeholder="\u7ED3\u675F\u65E5\u671F"]'));
        return ranges.length === 1 ? ranges[0] : null;
      }, '\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\u7B5B\u9009\u63A7\u4EF6');
    }
    await click(range.querySelector('input[placeholder="\u5F00\u59CB\u65E5\u671F"]'), '\u6253\u5F00\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\u65E5\u671F\u9009\u62E9\u5668');
    const shortcut = await wait(() => {
      try {
        return one(Array.from(document.querySelectorAll('.main-vmok-plugin-oc-range-picker-shortcut-item'))
          .filter(x => text(x) === '\u4ECA\u5929'), '\u65E5\u671F\u9009\u62E9\u5668\u201C\u4ECA\u5929\u201D\u5FEB\u6377\u9879');
      } catch (_) { return null; }
    }, '\u4ECA\u5929\u5FEB\u6377\u9879');
    await click(shortcut, '\u9009\u62E9\u4ECA\u5929\u7684\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4');
    await wait(() => range.querySelector('input[placeholder="\u5F00\u59CB\u65E5\u671F"]')?.value === today &&
      range.querySelector('input[placeholder="\u7ED3\u675F\u65E5\u671F"]')?.value === today,
    '\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\u8BBE\u4E3A\u4ECA\u5929', 5000);
    if (!selected) {
      const confirms = Array.from(document.querySelectorAll('button'))
        .filter(x => visible(x) && text(x) === '\u786E\u5B9A');
      if (confirms.length === 1) await click(confirms[0], '\u5E94\u7528\u4ECA\u5929\u7684\u4EFB\u52A1\u65E5\u671F\u7B5B\u9009');
    }
    await wait(() => {
      try {
        const applied = taskDateRange(drawer), table = taskTable(drawer);
        if (applied?.start !== today || applied.end !== today) return false;
        const rows = taskRows(table.data);
        return rows.every(x => x.day === today) && taskListReady(drawer);
      } catch (_) { return false; }
    }, '\u4ECA\u5929\u7684\u8C03\u63A7\u4EFB\u52A1\u5217\u8868\u5237\u65B0', 20000);
    log('\u5DF2\u5C06\u5F53\u524D\u8BA1\u5212\u7684\u4E00\u952E\u8C03\u901F\u4EFB\u52A1\u5F00\u59CB\u65F6\u95F4\u7B5B\u9009\u4E3A ' + today);
  }
  async function openTasks() {
    const where = await wait(() => {
      try { return assertIdentity(); } catch (_) { return null; }
    }, '\u9501\u5B9A\u8BA1\u5212\u9875\u9762\u5237\u65B0', 20000);
    if (!where.row) {
      const tab = where.drawer.querySelector('[id$="-tab-uni_task_center"]');
      if (!tab) throw new Error('\u627E\u4E0D\u5230\u8C03\u63A7\u6807\u7B7E');
      if (tab.getAttribute('aria-selected') !== 'true') await click(tab, '\u8C03\u63A7\u6807\u7B7E');
    } else {
      const currentChart = () => {
        const row = assertIdentity().row;
        if (!row) return null;
        const labels = Array.from(row.querySelectorAll('[class*="taskLabel-"]'))
          .filter(x => text(x) === '\u4E00\u952E\u8C03\u901F');
        if (labels.length !== 1) return null;
        return labels[0].closest('[class*="assistTask-"]')
          ?.querySelector('iconpark-icon[name="oc-chart-histogram"]') || null;
      };
      await wait(() => { try { return currentChart(); } catch (_) { return null; } },
        '\u5F53\u524D\u8BA1\u5212\u7684\u4E00\u952E\u8C03\u901F\u4EFB\u52A1\u5165\u53E3\u52A0\u8F7D', 20000);
      await click(currentChart, '\u67E5\u770B\u5F53\u524D\u8BA1\u5212\u8C03\u63A7\u4EFB\u52A1');
    }
    const drawer = await wait(() => {
      try {
        const d = detailIdentity();
        const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
        if (d.planId !== lock.planId) return null;
        return d.drawer.querySelector('[id$="-panel-uni_task_center"]') ? d.drawer : null;
      } catch (_) { return null; }
    }, '\u5F53\u524D\u8BA1\u5212\u8C03\u63A7\u9875', 20000);
    const speed = await wait(() => {
      const option = Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .find(x => visible(x) && text(x) === '\u4E00\u952E\u8C03\u901F');
      return option || null;
    }, '\u4E00\u952E\u8C03\u901F\u6807\u7B7E');
    if (!speed.className.includes('--checked')) await click(speed, '\u4E00\u952E\u8C03\u901F\u5217\u8868');
    await wait(() => { try { taskTable(drawer); return true; } catch (_) { return false; } }, '\u4E00\u952E\u8C03\u901F\u4EFB\u52A1\u8868', 20000);
    return drawer;
  }
  async function closeTasks() {
    if (!urlContext().detail) return;
    const d = detailIdentity().drawer;
    const back = one(d.querySelectorAll('button[class*="liveRoomLink-"]'), '\u8FD4\u56DE\u63A8\u76F4\u64AD\u95F4\u6309\u94AE');
    await click(back, '\u8FD4\u56DE\u76F4\u64AD\u8BA1\u5212\u5217\u8868');
    await wait(() => {
      try {
        const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
        return !urlContext().detail && overviewRows().some(x => x.id === lock.planId);
      }
      catch (_) { return false; }
    }, '\u8FD4\u56DE\u9501\u5B9A\u8BA1\u5212\u5217\u8868', 18000);
  }
  async function scanToday() {
    const drawer = await openTasks();
    await applyTodayFilter(drawer);
    await wait(() => {
      try { return taskListReady(drawer); } catch (_) { return false; }
    }, '\u8C03\u63A7\u4EFB\u52A1\u6570\u636E\u52A0\u8F7D', 20000);
    let table = taskTable(drawer);
    let { footer } = table;
    if (emptyTaskList(drawer, table)) {
      if (state.run) { state.run.lastTodayCents = 0; state.run.lastScanAt = Date.now(); saveRun(); }
      await closeTasks();
      return { items: [], totalCents: 0 };
    }
    if (!footer) throw new Error('\u6709\u8C03\u63A7\u4EFB\u52A1\u4F46\u7F3A\u5C11\u4EFB\u52A1\u5206\u9875\u680F');
    const active = one(footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '\u4EFB\u52A1\u5F53\u524D\u9875');
    if (text(active) !== '1') {
      const priorFirst = taskRows(taskTable(drawer).data)[0]?.id;
      await click(() => one(Array.from(taskTable(drawer).footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
        .filter(x => text(x) === '1'), '\u4EFB\u52A1\u7B2C\u4E00\u9875'), '\u4EFB\u52A1\u7B2C\u4E00\u9875');
      await wait(() => {
        try {
          const table = taskTable(drawer);
          return text(one(table.footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '\u4EFB\u52A1\u9875')) === '1' &&
            taskRows(table.data)[0]?.id !== priorFirst;
        }
        catch (_) { return false; }
      }, '\u4EFB\u52A1\u7B2C\u4E00\u9875\u6570\u636E');
    }
    const today = localDay(), items = [], ids = new Set();
    let page = 0;
    while (++page <= MAX_SCAN_PAGES) {
      await wait(() => {
        try {
          const current = taskTable(drawer);
          return current.data && taskRows(current.data).length > 0;
        } catch (_) { return false; }
      }, '\u7B2C ' + page + ' \u9875\u8C03\u63A7\u4EFB\u52A1\u5B57\u6BB5\u5B8C\u6574\u52A0\u8F7D', 20000);
      table = taskTable(drawer);
      const rows = taskRows(table.data);
      const selected = taskDateRange(drawer);
      if (selected?.start !== today || selected.end !== today) {
        throw new Error('\u4EFB\u52A1\u65E5\u671F\u7B5B\u9009\u5DF2\u53D8\u5316\uFF0C\u505C\u6B62\u9884\u7B97\u6838\u5BF9');
      }
      for (const item of rows) {
        if (ids.has(item.id)) throw new Error('\u7FFB\u9875\u540E\u51FA\u73B0\u91CD\u590D\u4EFB\u52A1 ID\uFF0C\u5217\u8868\u5C1A\u672A\u7A33\u5B9A');
        ids.add(item.id);
        if (item.day !== today) {
          throw new Error('\u6309\u4ECA\u5929\u7B5B\u9009\u540E\u4ECD\u51FA\u73B0\u5176\u4ED6\u521B\u5EFA\u65E5\u671F\u7684\u4EFB\u52A1\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5F53\u65E5\u9884\u7B97');
        }
        items.push(item);
      }
      footer = table.footer;
      if (!footer) throw new Error('\u7FFB\u9875\u524D\u4EFB\u52A1\u5206\u9875\u680F\u6D88\u5931');
      const next = Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
        .find(x => x.querySelector('.main-vmok-plugin-page-turner__next-icon'));
      if (!next) throw new Error('\u4EFB\u52A1\u5217\u8868\u7F3A\u5C11\u4E0B\u4E00\u9875\u72B6\u6001');
      if (next.className.includes('--disabled') || next.getAttribute('aria-disabled') === 'true') break;
      const priorFirst = rows[0].id;
      await click(() => {
        const current = taskTable(drawer).footer;
        const currentPage = one(current.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '\u4EFB\u52A1\u5F53\u524D\u9875');
        if (text(currentPage) !== String(page)) throw new Error('\u4EFB\u52A1\u9875\u5728\u70B9\u51FB\u524D\u6539\u53D8');
        const freshNext = one(Array.from(current.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
          .filter(x => x.querySelector('.main-vmok-plugin-page-turner__next-icon')), '\u4E0B\u4E00\u9875\u6309\u94AE');
        return freshNext.className.includes('--disabled') ? null : freshNext;
      }, '\u6838\u5BF9\u8C03\u63A7\u4EFB\u52A1\u7B2C ' + (page + 1) + ' \u9875');
      await wait(() => {
        try { const t = taskTable(drawer); return taskRows(t.data)[0]?.id !== priorFirst &&
          text(one(t.footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '\u4EFB\u52A1\u9875')) === String(page + 1); }
        catch (_) { return false; }
      }, '\u8C03\u63A7\u4EFB\u52A1\u7FFB\u9875', 16000);
    }
    if (page > MAX_SCAN_PAGES) throw new Error('\u4ECA\u65E5\u4EFB\u52A1\u8D85\u8FC7\u5B89\u5168\u626B\u63CF\u9875\u6570\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5F53\u65E5\u4E0A\u9650');
    const totalCents = items.reduce((sum, x) => sum + x.budgetCents, 0);
    if (state.run) { state.run.lastTodayCents = totalCents; state.run.lastScanAt = Date.now(); saveRun(); }
    await closeTasks();
    return { items, totalCents };
  }
  function setInput(input, value) {
    if (!input || !visible(input)) throw new Error('\u5E73\u53F0\u8F93\u5165\u6846\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u89C1');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus(); setter.call(input, String(value));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }
  function createModal() {
    const found = Array.from(document.querySelectorAll('[role="dialog"],.main-vmok-plugin-modal__wrap,.tools-vmok-plugin-modal__wrap')).filter(x =>
      layoutVisible(x) && text(x).includes('\u65B0\u5EFA\u8C03\u63A7\u4EFB\u52A1') && text(x).includes('\u8C03\u63A7\u603B\u9884\u7B97') && text(x).includes('\u8C03\u63A7\u65F6\u957F'));
    return one(found.filter(el=>!found.some(other=>other!==el&&el.contains(other))), '\u65B0\u5EFA\u8C03\u63A7\u4EFB\u52A1\u5F39\u7A97');
  }
  function field(modal, label) {
    return one(Array.from(modal.querySelectorAll('.main-vmok-plugin-oc-row')).filter(x =>
      text(x.querySelector('.main-vmok-plugin-oc-title-text')) === label), label + '\u5B57\u6BB5');
  }
  function chosenOption(modal, label) {
    return one(Array.from(field(modal, label).querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(x => x.classList.contains('main-vmok-plugin-radio-item--checked') ||
        x.getAttribute('aria-checked') === 'true'), label + '\u5F53\u524D\u9009\u4E2D\u9879');
  }
  async function selectRadio(modal, label, choice) {
    const row = field(modal, label);
    const option = one(Array.from(row.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(x => text(x) === choice), label + '\u9009\u9879');
    if (!option.classList.contains('main-vmok-plugin-radio-item--checked')) {
      await click(option, label + '\uFF1A' + choice);
    }
    await wait(() => {
      try { return text(chosenOption(modal, label)) === choice; }
      catch (_) { return false; }
    }, label + '\u9009\u4E2D\u201C' + choice + '\u201D', 5000);
  }
  async function openCreateModal() {
    await closeTasks();
    phase('\u5DF2\u8FD4\u56DE\u8BA1\u5212\u5217\u8868\uFF0C\u7B49\u5F85\u5F53\u524D\u8BA1\u5212\u884C\u7684\u201C\u4E00\u952E\u8C03\u901F +\u201D\u521B\u5EFA\u5165\u53E3');
    await wait(() => {
      const row = assertIdentity().row;
      if (!row) return null;
      const labels = Array.from(row.querySelectorAll('[class*="taskLabel-"]'))
        .filter(x => text(x) === '\u4E00\u952E\u8C03\u901F');
      if (labels.length !== 1) return null;
      const action = labels[0].closest('[class*="assistTask-"]');
      const icons = action && Array.from(action.querySelectorAll('iconpark-icon[name="oc-icon-plus"]'));
      return icons && icons.length === 1 ? icons[0] : null;
    }, '\u5F53\u524D\u8BA1\u5212\u884C\u7684\u4E00\u952E\u8C03\u901F\u201C+\u201D\u5165\u53E3\u52A0\u8F7D', 20000);
    await click(() => {
      const row = assertIdentity().row;
      const labels = Array.from(row.querySelectorAll('[class*="taskLabel-"]'))
        .filter(x => text(x) === '\u4E00\u952E\u8C03\u901F');
      return labels.length === 1 ? labels[0].closest('[class*="assistTask-"]')
        ?.querySelector('iconpark-icon[name="oc-icon-plus"]') : null;
    }, '\u4ECE\u8BA1\u5212\u5217\u8868\u884C\u5185\u201C+\u201D\u65B0\u5EFA\u4E00\u952E\u8C03\u901F\u4EFB\u52A1');
    return await wait(() => {
      try { return createModal(); } catch (_) { return null; }
    }, '\u4E00\u952E\u8C03\u901F\u521B\u5EFA\u5F39\u7A97', 12000);
  }
  function taskName(run) {
    const seq = String((run.confirmed || []).length + 1).padStart(2, '0');
    const nonce = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'QCS_' + run.day.replace(/-/g, '') + '_\u4E00\u952E\u8D77\u91CF_' + run.planId + '_' + seq + '_' + nonce;
  }
  async function prepareModal(modal, run, name) {
    await selectRadio(modal, '\u8C03\u63A7\u65B9\u5F0F', '\u4E00\u952E\u8D77\u91CF');
    await selectRadio(modal, '\u8D77\u91CF\u63A2\u7D22\u76EE\u6807', '\u76F4\u64AD\u95F4\u8D2D\u4E70');
    const budget = one(field(modal, '\u8C03\u63A7\u603B\u9884\u7B97').querySelectorAll('input.main-vmok-plugin-input'), '\u8C03\u63A7\u603B\u9884\u7B97\u8F93\u5165\u6846');
    const hours = one(field(modal, '\u8C03\u63A7\u65F6\u957F').querySelectorAll('input.main-vmok-plugin-input'), '\u8C03\u63A7\u65F6\u957F\u8F93\u5165\u6846');
    const nameInput = one(field(modal, '\u4EFB\u52A1\u540D\u79F0').querySelectorAll('input.main-vmok-plugin-input'), '\u4EFB\u52A1\u540D\u79F0\u8F93\u5165\u6846');
    setInput(budget, yuan(run.budgetCents));
    setInput(hours, run.hours);
    setInput(nameInput, name);
    await new Promise(resolve => setTimeout(resolve, 450));
    if (Number(budget.value) !== run.budgetCents / 100) throw new Error('\u63D0\u4EA4\u524D\u8C03\u63A7\u603B\u9884\u7B97\u4E0E\u9501\u5B9A\u914D\u7F6E\u4E0D\u4E00\u81F4');
    if (Number(hours.value) !== run.hours) throw new Error('\u63D0\u4EA4\u524D\u8C03\u63A7\u65F6\u957F\u4E0E\u9501\u5B9A\u914D\u7F6E\u4E0D\u4E00\u81F4');
    if (nameInput.value !== name) throw new Error('\u63D0\u4EA4\u524D\u4EFB\u52A1\u540D\u79F0\u4E0E\u672C\u8F6E\u4EFB\u52A1\u540D\u4E0D\u4E00\u81F4');
    if (text(chosenOption(modal, '\u8C03\u63A7\u65B9\u5F0F')) !== '\u4E00\u952E\u8D77\u91CF') throw new Error('\u63D0\u4EA4\u524D\u8C03\u63A7\u65B9\u5F0F\u672A\u9009\u4E2D\u4E00\u952E\u8D77\u91CF');
    if (text(chosenOption(modal, '\u8D77\u91CF\u63A2\u7D22\u76EE\u6807')) !== '\u76F4\u64AD\u95F4\u8D2D\u4E70') throw new Error('\u63D0\u4EA4\u524D\u8D77\u91CF\u63A2\u7D22\u76EE\u6807\u672A\u9009\u4E2D\u76F4\u64AD\u95F4\u8D2D\u4E70');
  }
  // \u5148\u89C2\u5BDF\u5B9E\u9645 DOM\uFF0C\u518D\u5224\u5B9A\u8D85\u65F6\uFF1A\u540E\u53F0\u8BA1\u65F6\u5668\u6062\u590D\u65F6\uFF0C\u4E0D\u80FD\u56E0\u5899\u949F\u5DF2\u8FC7\u671F\u800C\u6F0F\u6389\u5DF2\u5173\u95ED\u7684\u5F39\u7A97\u3002
  function waitSubmittedModal(modal) {
    phase('\u5DF2\u70B9\u51FB\u63D0\u4EA4\uFF0C\u7B49\u5F85\u5E73\u53F0\u5173\u95ED\u5F39\u7A97\uFF1B\u540E\u53F0\u5EF6\u8FDF\u65F6\u7EE7\u7EED\u89C2\u5BDF\uFF0C\u4E0D\u91CD\u590D\u63D0\u4EA4');
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let observer, timer, finished = false, warned = false;
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer); observer?.disconnect();
        window.removeEventListener('focus', inspect);
        document.removeEventListener('visibilitychange', inspect);
        error ? reject(error) : resolve();
      }
      function inspect() {
        if (finished) return;
        try {
          assertLease(); blockCheck();
          if (!visible(modal)) { finish(); return; }
          const elapsed = Date.now() - started;
          if (elapsed >= SUBMIT_VERIFY_MS) {
            finish(new Error('\u63D0\u4EA4\u5F39\u7A97\u5728\u5EF6\u957F\u89C2\u5BDF\u540E\u4ECD\u672A\u5173\u95ED\uFF1B\u4FDD\u7559\u5F85\u6838\u5BF9\u4EFB\u52A1\uFF0C\u4E0D\u91CD\u590D\u63D0\u4EA4')); return;
          }
          if (!warned && elapsed >= 30000) {
            warned = true;
            log('\u63D0\u4EA4\u5F39\u7A97\u5C1A\u672A\u5173\u95ED\uFF0C\u7EE7\u7EED\u89C2\u5BDF\u6700\u591A3\u5206\u949F\uFF1B\u5207\u56DE\u9875\u9762\u65F6\u7ACB\u5373\u68C0\u67E5\uFF0C\u4E0D\u91CD\u590D\u70B9\u51FB\u63D0\u4EA4');
            phase('\u63D0\u4EA4\u540E\u9875\u9762\u54CD\u5E94\u8F83\u6162\uFF0C\u6B63\u5728\u5EF6\u957F\u89C2\u5BDF\uFF1B\u4E0D\u4F1A\u91CD\u590D\u63D0\u4EA4');
          }
          clearTimeout(timer); timer = setTimeout(inspect, 1000);
        } catch (error) { finish(error); }
      }
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
      window.addEventListener('focus', inspect);
      document.addEventListener('visibilitychange', inspect);
      inspect();
    });
  }
  function pendingHit(run, scan) {
    const hits = scan.items.filter(x => x.name === run.pending.name);
    if (hits.length > 1) throw new Error('\u4EFB\u52A1\u540D\u5728\u8C03\u63A7\u5217\u8868\u4E2D\u51FA\u73B0 ' + hits.length + ' \u6B21\uFF1B\u7ED3\u679C\u5F85\u4EBA\u5DE5\u6838\u5BF9');
    if (!hits.length) return null;
    const hit = hits[0];
    if (hit.budgetCents !== run.pending.budgetCents || hit.hours !== run.hours ||
        hit.mode !== '\u4E00\u952E\u8D77\u91CF' || hit.goal !== '\u76F4\u64AD\u95F4\u8D2D\u4E70' || hit.day !== run.day ||
        !Number.isFinite(hit.createdAt) || hit.createdAt <= 0 || hit.createdAt > Date.now() + 60000) {
      throw new Error('\u4EFB\u52A1\u5DF2\u51FA\u73B0\u4F46\u9884\u7B97\u3001\u65F6\u957F\u3001\u521B\u5EFA\u65F6\u95F4\u6216\u76EE\u6807\u4E0E\u672C\u8F6E\u53C2\u6570\u4E0D\u4E00\u81F4');
    }
    if ((run.confirmed || []).some(x => x.id === hit.id)) throw new Error('\u4EFB\u52A1\u5DF2\u5728\u672C\u8F6E\u786E\u8BA4\u8BB0\u5F55\u4E2D\uFF0C\u505C\u6B62\u4EE5\u907F\u514D\u91CD\u590D\u8BA1\u6570');
    return hit;
  }
  async function verifyPending() {
    const run = state.run;
    if (!run || !run.pending) throw new Error('\u6CA1\u6709\u5F85\u6838\u5BF9\u7684\u63D0\u4EA4');
    phase('\u63D0\u4EA4\u540E\u53EA\u5728\u201C\u8C03\u63A7\u201D\u9875\u6838\u5BF9\u7ED3\u679C\uFF0C\u4E0D\u5728\u6B64\u9875\u521B\u5EFA\u4EFB\u52A1');
    const deadline = Date.now() + SUBMIT_VERIFY_MS;
    let scan, hit;
    for (let attempt = 1; attempt <= MAX_VERIFY_SCANS; attempt++) {
      assertLease();
      if (localDay() !== run.day) throw new Error('\u6838\u5BF9\u671F\u95F4\u5DF2\u8DE8\u65E5\uFF0C\u505C\u6B62\u81EA\u52A8\u7EED\u6295');
      let transientError = '';
      try { scan = await scanToday(); }
      catch (error) {
        // \u4EC5\u91CD\u8BD5\u52A0\u8F7D\u7C7B\u9519\u8BEF\uFF1B\u8D26\u6237/\u8BA1\u5212\u3001\u6743\u9650\u3001\u7B5B\u9009\u548C\u9884\u7B97\u7B49\u4E0D\u4E00\u81F4\u4ECD\u7ACB\u5373\u505C\u6B62\u3002
        if (!/\u7B49\u5F85\u8D85\u65F6|\u5217\u8868\u5C1A\u672A\u7A33\u5B9A/.test(error.message)) throw error;
        transientError = error.message; scan = null;
      }
      assertLease();
      hit = scan ? pendingHit(run, scan) : null;
      if (hit) break;
      if (attempt === MAX_VERIFY_SCANS || Date.now() >= deadline) {
        throw new Error('\u63D0\u4EA4\u540E\u81EA\u52A8\u6838\u5BF9\u4ECD\u672A\u627E\u5230\u552F\u4E00\u4E14\u53C2\u6570\u543B\u5408\u7684\u4EFB\u52A1' +
          (transientError ? '\uFF1A' + transientError : '') + '\uFF1B\u4FDD\u7559\u5F85\u6838\u5BF9\u8BB0\u5F55');
      }
      log('\u63D0\u4EA4\u540E\u7B2C ' + attempt + ' \u6B21\u6838\u5BF9\u5C1A\u672A\u786E\u8BA4' + (transientError ? '\uFF1A' + transientError : '\uFF1A\u65B0\u4EFB\u52A1\u6682\u672A\u8FDB\u5165\u5217\u8868') +
        '\uFF1B5\u79D2\u540E\u518D\u6B21\u53EA\u8BFB\u6838\u5BF9\uFF0C\u4E0D\u91CD\u590D\u63D0\u4EA4');
      phase('\u6B63\u5728\u81EA\u52A8\u6838\u5BF9\u5DF2\u63D0\u4EA4\u4EFB\u52A1\uFF08\u7B2C ' + (attempt + 1) + ' \u6B21\uFF09\uFF0C\u786E\u8BA4\u540E\u81EA\u52A8\u6062\u590D\u5012\u8BA1\u65F6');
      await new Promise(resolve => setTimeout(resolve, VERIFY_RETRY_MS));
    }
    run.confirmed.push({ name: hit.name, id: hit.id, budgetCents: hit.budgetCents, createdAt: hit.createdAt });
    run.pending = null;
    run.lastTodayCents = scan.totalCents;
    run.nextAt = hit.createdAt + run.intervalMinutes * 60000;
    if (state.stopAfterSubmit) {
      stopRun('\u5F53\u524D\u63D0\u4EA4\u5DF2\u6838\u5BF9\u6210\u529F\uFF0C\u6309\u505C\u6B62\u8BF7\u6C42\u7ED3\u675F\u81EA\u52A8\u7EED\u6295');
    } else if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('\u5F53\u524D\u8BA1\u5212\u4ECA\u65E5\u5DF2\u5B89\u6392 ' + yuan(scan.totalCents) + ' \u5143\uFF0C\u4E0B\u4E00\u6B21\u5C06\u8D85\u8FC7\u4E0A\u9650 ' + yuan(run.capCents) + ' \u5143', 'complete');
    } else if (localDay(new Date(run.nextAt)) !== run.day) {
      stopRun('\u4E0B\u4E00\u6B21\u8C03\u63A7\u65F6\u95F4\u5DF2\u8DE8\u65E5\uFF0C\u672C\u8F6E\u7ED3\u675F', 'complete');
    } else if (Date.now() - run.nextAt > LATE_MS) {
      stopRun('\u4EFB\u52A1\u5DF2\u786E\u8BA4\uFF0C\u4F46\u4E0B\u4E00\u8F6E\u9884\u5B9A\u65F6\u95F4\u5DF2\u8D85\u8FC75\u5206\u949F\uFF0C\u4E0D\u81EA\u52A8\u8865\u6295');
    } else {
      run.status = 'scheduled';
      run.reason = '';
      saveRun();
      phase('\u5DF2\u6838\u5BF9\u4EFB\u52A1 ' + hit.id + '\uFF1B\u4E0B\u6B21\u6267\u884C ' + timeText(run.nextAt));
      log('\u5DF2\u786E\u8BA4\u4EFB\u52A1 ' + hit.name + '\uFF08' + hit.id + '\uFF09\uFF0C\u4ECA\u65E5\u7D2F\u8BA1 ' + yuan(scan.totalCents) + ' \u5143');
      report('\u7B49\u5F85\u4E0B\u6B21\u81EA\u52A8\u8C03\u63A7');
    }
  }
  function scheduleFromActiveTask(run, scan) {
    const active = scan.items.filter(x => /\u8C03\u63A7\u4E2D/.test(x.state) &&
      x.mode === '\u4E00\u952E\u8D77\u91CF' && x.goal === '\u76F4\u64AD\u95F4\u8D2D\u4E70');
    if (!active.length) return false;
    active.sort((a, b) => b.createdAt - a.createdAt ||
      (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
    const hit = active[0];
    if (hit.createdAt > Date.now() + 60000) throw new Error('\u8C03\u63A7\u4E2D\u4EFB\u52A1\u7684\u521B\u5EFA\u65F6\u95F4\u665A\u4E8E\u5F53\u524D\u65F6\u95F4\uFF0C\u65E0\u6CD5\u6062\u590D\u5012\u8BA1\u65F6');
    if ((run.confirmed || []).some(x => x.id === hit.id)) {
      throw new Error('\u4E0A\u4E00\u8F6E\u4EFB\u52A1 ' + hit.id + ' \u4ECD\u663E\u793A\u8C03\u63A7\u4E2D\uFF1B\u8BF7\u7B49\u5F85\u5E73\u53F0\u66F4\u65B0\u540E\u518D\u51B3\u5B9A\u662F\u5426\u7EED\u6295');
    }
    run.confirmed.push({ name: hit.name, id: hit.id, budgetCents: hit.budgetCents,
      createdAt: hit.createdAt, source: 'existing' });
    run.lastTodayCents = scan.totalCents;
    run.nextAt = hit.createdAt + run.intervalMinutes * 60000;
    if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('\u5DF2\u627E\u5230\u8C03\u63A7\u4E2D\u4EFB\u52A1 ' + hit.id + '\uFF1B\u4E0B\u4E00\u6B21\u5C06\u8D85\u8FC7\u5F53\u65E5\u4E0A\u9650', 'complete');
    } else if (localDay(new Date(run.nextAt)) !== run.day) {
      stopRun('\u5DF2\u627E\u5230\u8C03\u63A7\u4E2D\u4EFB\u52A1 ' + hit.id + '\uFF1B\u4E0B\u6B21\u8C03\u63A7\u65F6\u95F4\u5DF2\u8DE8\u65E5', 'complete');
    } else if (Date.now() - run.nextAt > LATE_MS) {
      stopRun('\u5DF2\u627E\u5230\u8C03\u63A7\u4E2D\u4EFB\u52A1 ' + hit.id + '\uFF1B\u9519\u8FC7\u9884\u5B9A\u65F6\u95F4\u8D85\u8FC7 5 \u5206\u949F\uFF0C\u4E0D\u81EA\u52A8\u8865\u6295');
    } else {
      run.status = 'scheduled';
      saveRun();
      phase('\u5DF2\u627E\u5230\u8C03\u63A7\u4E2D\u4EFB\u52A1 ' + hit.id + '\uFF1B\u4E0B\u6B21\u6267\u884C ' + timeText(run.nextAt));
      log('\u6309\u73B0\u6709\u4EFB\u52A1\u521B\u5EFA\u65F6\u95F4 ' + timeText(hit.createdAt) + ' \u6062\u590D\u5012\u8BA1\u65F6\uFF1B\u4ECA\u65E5\u7D2F\u8BA1 ' +
        yuan(scan.totalCents) + ' \u5143\uFF1B\u672C\u6B21\u4E0D\u91CD\u590D\u63D0\u4EA4');
      report('\u5DF2\u4ECE\u8C03\u63A7\u4E2D\u4EFB\u52A1\u6062\u590D\u5B9A\u65F6\uFF0C\u7B49\u5F85\u4E0B\u4E00\u8F6E');
    }
    return true;
  }
  async function submitOnce() {
    const run = state.run;
    if (!run || run.status !== 'scheduled') throw new Error('\u8F6E\u6B21\u72B6\u6001\u4E0D\u5141\u8BB8\u63D0\u4EA4');
    if (localDay() !== run.day) { stopRun('\u5DF2\u8DE8\u5230\u65B0\u7684\u4E00\u5929', 'complete'); return; }
    assertIdentity();
    phase('\u63D0\u4EA4\u524D\u53EA\u8BFB\u6838\u5BF9\u8BE5\u8BA1\u5212\u4ECA\u65E5\u9884\u7B97\uFF1B\u968F\u540E\u8FD4\u56DE\u8BA1\u5212\u5217\u8868\uFF0C\u4ECE\u201C\u4E00\u952E\u8C03\u901F +\u201D\u521B\u5EFA');
    let scan = await scanToday();
    while (scan.items.some(x => /\u8C03\u63A7\u4E2D/.test(x.state) &&
      (run.confirmed || []).some(confirmed => confirmed.id === x.id))) {
      if (Date.now() - run.nextAt > LATE_MS) {
        throw new Error('\u4E0A\u4E00\u8F6E\u4EFB\u52A1\u5728\u9884\u5B9A\u65F6\u95F4\u540E 5 \u5206\u949F\u4ECD\u663E\u793A\u8C03\u63A7\u4E2D\uFF0C\u672A\u91CD\u590D\u63D0\u4EA4');
      }
      phase('\u4E0A\u4E00\u8F6E\u4EFB\u52A1\u4ECD\u663E\u793A\u8C03\u63A7\u4E2D\uFF0C10 \u79D2\u540E\u91CD\u65B0\u6838\u5BF9\uFF1B\u6B64\u65F6\u4E0D\u4F1A\u91CD\u590D\u63D0\u4EA4');
      await new Promise(resolve => setTimeout(resolve, 10000));
      if (state.stopRequested) throw new Error('\u7528\u6237\u8BF7\u6C42\u505C\u6B62\uFF0C\u672A\u7EE7\u7EED\u63D0\u4EA4');
      scan = await scanToday();
    }
    if (scheduleFromActiveTask(run, scan)) return;
    if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('\u5F53\u524D\u8BA1\u5212\u4ECA\u65E5\u5DF2\u5B89\u6392 ' + yuan(scan.totalCents) + ' \u5143\uFF1B\u518D\u63D0\u4EA4 ' + yuan(run.budgetCents) + ' \u5143\u5C06\u8D85\u8FC7\u4E0A\u9650 ' + yuan(run.capCents) + ' \u5143', 'complete');
      return;
    }
    const name = taskName(run);
    const modal = await openCreateModal();
    let submit;
    try {
      await prepareModal(modal, run, name);
      submit = one(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
        .filter(x => text(x) === '\u63D0\u4EA4'), '\u4E00\u952E\u8C03\u901F\u63D0\u4EA4\u6309\u94AE');
      if (submit.disabled) throw new Error('\u5E73\u53F0\u63D0\u4EA4\u6309\u94AE\u4E0D\u53EF\u7528');
    } catch (error) {
      const cancel = Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
        .filter(x => visible(x) && text(x) === '\u53D6\u6D88');
      if (cancel.length === 1) {
        try { await click(cancel[0], '\u5173\u95ED\u672A\u63D0\u4EA4\u7684\u8C03\u63A7\u5F39\u7A97'); }
        catch (closeError) { log('\u672A\u80FD\u81EA\u52A8\u5173\u95ED\u672A\u63D0\u4EA4\u5F39\u7A97\uFF1A' + closeError.message); }
      }
      throw error;
    }
    run.pending = { name, budgetCents: run.budgetCents, clickedAt: Date.now(), hiddenAtSubmit: document.hidden };
    run.status = 'submitting';
    saveRun();
    log('\u63D0\u4EA4\u524D\u9501\u5B9A\u4EFB\u52A1 ' + name + '\uFF1B\u9884\u7B97 ' + yuan(run.budgetCents) + ' \u5143\uFF0C\u65F6\u957F ' + run.hours + ' \u5C0F\u65F6\uFF1B\u9875\u9762' + (document.hidden ? '\u4F4D\u4E8E\u540E\u53F0' : '\u4F4D\u4E8E\u524D\u53F0'));
    await click(submit, '\u63D0\u4EA4\u4E00\u952E\u8D77\u91CF\u4EFB\u52A1');
    await waitSubmittedModal(modal);
    await verifyPending();
  }
  async function refreshBeforeNextRound(run) {
    assertLease();
    assertIdentity();
    phase('\u4E0B\u4E00\u8F6E\u5DF2\u5230\u70B9\uFF0C\u8FD4\u56DE\u9501\u5B9A\u8BA1\u5212\u5217\u8868\u540E\u5237\u65B0\u7F51\u9875');
    await closeTasks();
    await wait(() => {
      try { return assertIdentity().row || null; }
      catch (_) { return null; }
    }, '\u5237\u65B0\u524D\u9501\u5B9A\u8BA1\u5212\u5217\u8868', 20000);
    if (state.stopRequested) throw new Error('\u7528\u6237\u8BF7\u6C42\u505C\u6B62\uFF0C\u672A\u5237\u65B0\u6216\u63D0\u4EA4\u4E0B\u4E00\u8F6E');
    assertLease();
    run.refreshRequestedFor = run.nextAt;
    run.refreshCompletedFor = 0;
    saveRun();
    log('\u4E0B\u4E00\u8F6E\u5230\u70B9\uFF1B\u5DF2\u8FD4\u56DE\u9501\u5B9A\u8BA1\u5212\u5217\u8868\uFF0C\u51C6\u5907\u5237\u65B0\u7F51\u9875');
    state.reloading = true;
    location.reload();
  }
  async function resumeAfterRefresh(run) {
    phase('\u7F51\u9875\u5DF2\u5237\u65B0\uFF0C\u7B49\u5F85\u9501\u5B9A\u8BA1\u5212\u548C\u4E00\u952E\u8C03\u901F\u5165\u53E3\u91CD\u65B0\u52A0\u8F7D');
    await wait(() => {
      try {
        const row = assertIdentity().row;
        if (!row) return null;
        const labels = Array.from(row.querySelectorAll('[class*="taskLabel-"]'))
          .filter(x => text(x) === '\u4E00\u952E\u8C03\u901F');
        return labels.length === 1 ? labels[0].closest('[class*="assistTask-"]')
          ?.querySelector('iconpark-icon[name="oc-icon-plus"]') : null;
      } catch (_) { return null; }
    }, '\u5237\u65B0\u540E\u9501\u5B9A\u8BA1\u5212\u548C\u4E00\u952E\u8C03\u901F\u201C+\u201D\u5165\u53E3', 30000);
    if (state.stopRequested) throw new Error('\u7528\u6237\u8BF7\u6C42\u505C\u6B62\uFF0C\u672A\u63D0\u4EA4\u4E0B\u4E00\u8F6E');
    if (Date.now() - run.nextAt > LATE_MS) throw new Error('\u5237\u65B0\u540E\u9519\u8FC7\u9884\u5B9A\u65F6\u95F4\u8D85\u8FC7 5 \u5206\u949F\uFF1B\u4E0D\u81EA\u52A8\u8865\u6295');
    assertLease();
    run.refreshCompletedFor = run.nextAt;
    saveRun();
    log('\u7F51\u9875\u5237\u65B0\u5B8C\u6210\uFF1B\u5DF2\u91CD\u65B0\u786E\u8BA4\u9501\u5B9A\u8BA1\u5212\u548C\u4E00\u952E\u8C03\u901F\u521B\u5EFA\u5165\u53E3');
  }
  async function cycle(first) {
    if (state.busy) return;
    state.busy = true;
    state.stopRequested = false;
    state.stopAfterSubmit = false;
    render();
    try {
      const run = state.run;
      if (!run || run.owner !== tabToken || run.status !== 'scheduled') throw new Error('\u5F53\u524D\u6807\u7B7E\u9875\u6CA1\u6709\u53EF\u6267\u884C\u7684\u8F6E\u6B21');
      if (!first && Date.now() - run.nextAt > LATE_MS) throw new Error('\u9519\u8FC7\u9884\u5B9A\u65F6\u95F4\u8D85\u8FC7 5 \u5206\u949F\uFF1B\u4E0D\u81EA\u52A8\u8865\u6295');
      if (!first && Date.now() < run.nextAt) return;
      if (!first) {
        if (run.refreshRequestedFor !== run.nextAt) {
          await refreshBeforeNextRound(run);
          return;
        }
        if (run.refreshCompletedFor !== run.nextAt) await resumeAfterRefresh(run);
      }
      if (state.stopRequested) throw new Error('\u7528\u6237\u8BF7\u6C42\u505C\u6B62\uFF0C\u672A\u63D0\u4EA4\u4E0B\u4E00\u8F6E');
      await submitOnce();
    } catch (error) {
      const message = error && error.message || String(error);
      if (state.run) {
        if (state.run.pending || state.run.status === 'submitting') stopRun(message + '\uFF1B\u7ED3\u679C\u4E0D\u660E\u786E\uFF0C\u8BF7\u5148\u5230\u8C03\u63A7\u9875\u6838\u5BF9\u4EFB\u52A1\uFF0C\u7981\u6B62\u76F4\u63A5\u91CD\u63D0', 'needs_review');
        else stopRun(message);
      } else phase('\u6267\u884C\u505C\u6B62\uFF1A' + message);
    } finally {
      state.busy = false;
      render();
    }
  }
  async function start() {
    if (state.busy) return;
    try {
      const saved = GM_getValue(RUN_KEY, null);
      if (saved && ['scheduled', 'submitting', 'needs_review'].includes(saved.status)) {
        throw new Error('\u5DF2\u6709\u672A\u7ED3\u675F\u7684\u4E00\u952E\u8C03\u901F\u8F6E\u6B21\uFF0C\u8BF7\u5148\u5904\u7406\u6216\u505C\u6B62');
      }
      if (state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status)) {
        throw new Error('\u5DF2\u6709\u8FD0\u884C\u6216\u5F85\u6838\u5BF9\u8F6E\u6B21\uFF0C\u8BF7\u5148\u5904\u7406');
      }
      if (!state.lock) throw new Error('\u8BF7\u5148\u9501\u5B9A\u5F53\u524D\u76F4\u64AD\u8BA1\u5212');
      const other = retireOldPlanLease(state.lock, saved);
      if (activeRun(other)) throw new Error('\u8BE5\u8BA1\u5212\u4ECA\u5929\u5DF2\u6709\u5176\u4ED6\u6807\u7B7E\u9875\u7684\u8FD0\u884C\u6216\u5F85\u6838\u5BF9\u8F6E\u6B21\uFF08\u5F00\u59CB\u4E8E ' +
        timeText(other.startedAt) + '\uFF09\uFF1B\u8BF7\u5728\u539F\u8BA1\u5212\u6807\u7B7E\u9875\u5904\u7406\uFF0C\u907F\u514D\u91CD\u590D\u63D0\u4EA4');
      const form = readCfg();
      assertIdentity();
      if (!tabToken) throw new Error('\u6D4F\u89C8\u5668\u672A\u63D0\u4F9B\u53EF\u8DE8\u5237\u65B0\u8BC6\u522B\u7684\u5F53\u524D\u6807\u7B7E\u9875');
      const run = {
        ...state.lock, ...form, owner: tabToken, day: localDay(), status: 'scheduled',
        startedAt: Date.now(), nextAt: Date.now(), confirmed: [], pending: null,
        lastTodayCents: 0, lastScanAt: 0, logs: [], reason: ''
      };
      state.run = run;
      saveRun();
      log('\u624B\u52A8\u542F\u52A8\u6838\u5BF9\uFF1B\u5982\u6709\u8C03\u63A7\u4E2D\u4EFB\u52A1\u5148\u6309\u5176\u521B\u5EFA\u65F6\u95F4\u6062\u590D\u5B9A\u65F6\uFF0C\u5426\u5219\u521B\u5EFA\u9996\u8F6E\uFF1B\u540E\u7EED\u6BCF\u9694 ' +
        run.intervalMinutes / 60 + ' \u5C0F\u65F6\u4EC5\u5728\u4ECA\u65E5\u81EA\u52A8\u7EED\u6295');
      await cycle(true);
    } catch (error) { phase('\u542F\u52A8\u5931\u8D25\uFF1A' + error.message); }
  }
  function localTakeoverSource(lock, lease) {
    if (state.run && state.run.accountId === lock.accountId && state.run.planId === lock.planId &&
        state.run.takeoverCheckPending) return state.run.takeoverSource;
    if (!activeRun(lease)) return null;
    if (lease.status === 'submitting') throw new Error('\u65E7\u8F6E\u6B21\u6B63\u5728\u63D0\u4EA4\uFF0C\u8BF7\u7B49\u5F85\u5176\u7ED3\u679C\u6838\u5BF9\u6216\u5728\u539F\u9875\u505C\u6B62\u540E\u518D\u63A5\u7BA1');
    const key = 'qc-live-speed-scheduler-run-v2-' + lease.owner;
    let source = GM_getValue(key, null);
    if (!source) {
      const legacy = GM_getValue(LEGACY_RUN_KEY, null);
      if (legacy && legacy.owner === lease.owner && legacy.startedAt === lease.startedAt) source = legacy;
    }
    if (source && (source.owner !== lease.owner || source.startedAt !== lease.startedAt ||
        source.accountId !== lock.accountId || source.planId !== lock.planId)) {
      throw new Error('\u65E7\u8F6E\u6B21\u8BB0\u5F55\u4E0E\u8BA1\u5212\u9501\u4E0D\u4E00\u81F4\uFF0C\u672A\u63A5\u7BA1');
    }
    if (source?.status === 'submitting') throw new Error('\u65E7\u8F6E\u6B21\u6B63\u5728\u63D0\u4EA4\uFF0C\u6682\u4E0D\u80FD\u63A5\u7BA1');
    if (source?.takeoverCheckPending) {
      const inherited = source.takeoverSource;
      if (inherited && (inherited.accountId !== lock.accountId || inherited.planId !== lock.planId)) {
        throw new Error('\u4E0A\u6B21\u63A5\u7BA1\u4FDD\u7559\u7684\u4EFB\u52A1\u4FE1\u606F\u4E0E\u5F53\u524D\u8BA1\u5212\u4E0D\u4E00\u81F4');
      }
      return inherited || { owner: source.owner, startedAt: source.startedAt, status: source.status,
        accountId: source.accountId, planId: source.planId, pending: null };
    }
    if (lease.status === 'needs_review' && !source?.pending) {
      throw new Error('\u65E7\u8BB0\u5F55\u9700\u8981\u6838\u5BF9\uFF0C\u4F46\u6CA1\u6709\u5B8C\u6574\u7684\u5F85\u786E\u8BA4\u4EFB\u52A1\u4FE1\u606F\uFF1B\u8BF7\u5148\u5728\u539F\u6807\u7B7E\u9875\u5904\u7406');
    }
    return source ? { owner: source.owner, startedAt: source.startedAt, status: source.status,
      accountId: source.accountId, planId: source.planId, day: source.day,
      hours: source.hours, pending: source.pending ? { ...source.pending } : null } :
      { owner: lease.owner, startedAt: lease.startedAt, status: lease.status,
        accountId: lock.accountId, planId: lock.planId, pending: null };
  }
  function verifyTakeoverPending(source, scan) {
    if (!source?.pending) return;
    const p = source.pending;
    const hits = scan.items.filter(item => item.name === p.name);
    if (source.day !== localDay() || hits.length !== 1 || hits[0].day !== source.day ||
        hits[0].budgetCents !== p.budgetCents || hits[0].hours !== source.hours ||
        hits[0].mode !== '\u4E00\u952E\u8D77\u91CF' || hits[0].goal !== '\u76F4\u64AD\u95F4\u8D2D\u4E70') {
      throw new Error('\u65E7\u8F6E\u6B21\u5F85\u786E\u8BA4\u4EFB\u52A1\u5C1A\u672A\u627E\u5230\u552F\u4E00\u4E14\u53C2\u6570\u543B\u5408\u7684\u7ED3\u679C\uFF1B\u672C\u673A\u5DF2\u6682\u505C\u63A5\u7BA1\u6838\u5BF9\uFF0C\u4E0D\u4F1A\u8865\u6295\u3002\u6838\u5BF9\u5E73\u53F0\u540E\u53EF\u518D\u6B21\u70B9\u51FB\u672C\u673A\u63A5\u7BA1');
    }
  }
  function scheduleTakeover(run, scan) {
    run.lastTodayCents = scan.totalCents;
    run.lastScanAt = Date.now();
    const items = scan.items.filter(item => item.day === run.day &&
      item.mode === '\u4E00\u952E\u8D77\u91CF' && item.goal === '\u76F4\u64AD\u95F4\u8D2D\u4E70');
    if (items.some(item => !Number.isFinite(item.createdAt) || item.createdAt > Date.now() + 60000)) {
      throw new Error('\u4ECA\u65E5\u4EFB\u52A1\u521B\u5EFA\u65F6\u95F4\u65E0\u6CD5\u786E\u8BA4\uFF0C\u672A\u6062\u590D\u81EA\u52A8\u7EED\u6295');
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    const latest = items[0];
    run.confirmed = latest ? [{ name: latest.name, id: latest.id, budgetCents: latest.budgetCents,
      createdAt: latest.createdAt, source: 'local-takeover' }] : [];
    run.nextAt = latest ? latest.createdAt + run.intervalMinutes * 60000 : Date.now();
    run.pending = null;
    run.takeoverCheckPending = false;
    if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('\u672C\u673A\u63A5\u7BA1\u6838\u5BF9\u5B8C\u6210\uFF1B\u4E0B\u4E00\u6B21\u9884\u7B97\u5C06\u8D85\u8FC7\u5F53\u65E5\u4E0A\u9650', 'complete');
    } else if (localDay(new Date(run.nextAt)) !== run.day) {
      stopRun('\u672C\u673A\u63A5\u7BA1\u6838\u5BF9\u5B8C\u6210\uFF1B\u4E0B\u4E00\u6B21\u8C03\u63A7\u65F6\u95F4\u5DF2\u8DE8\u65E5', 'complete');
    } else if (Date.now() - run.nextAt > LATE_MS) {
      stopRun('\u672C\u673A\u63A5\u7BA1\u6838\u5BF9\u5B8C\u6210\uFF1B\u6700\u8FD1\u4EFB\u52A1\u7684\u7EED\u6295\u65F6\u95F4\u5DF2\u8D85\u8FC75\u5206\u949F\uFF0C\u4E0D\u81EA\u52A8\u8865\u6295');
    } else {
      run.status = 'scheduled';
      run.reason = '';
      saveRun();
      phase(latest ? '\u672C\u673A\u5DF2\u63A5\u7BA1\uFF1B\u6309\u6700\u8FD1\u4EFB\u52A1\u6062\u590D\u5B9A\u65F6\uFF0C\u4E0B\u6B21 ' + timeText(run.nextAt) :
        '\u672C\u673A\u5DF2\u63A5\u7BA1\uFF1B\u4ECA\u65E5\u6CA1\u6709\u4E00\u952E\u8C03\u901F\u4EFB\u52A1\uFF0C\u4E0B\u4E00\u6B21\u68C0\u67E5\u540E\u521B\u5EFA\u9996\u8F6E');
      log(latest ? '\u63A5\u7BA1\u6838\u5BF9\u4EFB\u52A1 ' + latest.id + '\uFF1B\u6309\u521B\u5EFA\u65F6\u95F4 ' + timeText(latest.createdAt) + ' \u6062\u590D\u5012\u8BA1\u65F6' :
        '\u672C\u673A\u63A5\u7BA1\u6838\u5BF9\uFF1A\u4ECA\u65E5\u65E0\u5339\u914D\u4EFB\u52A1\uFF0C\u7B49\u5F85\u5B9A\u65F6\u68C0\u67E5\u540E\u521B\u5EFA\u9996\u8F6E');
      report('\u672C\u673A\u63A5\u7BA1\u6838\u5BF9\u5B8C\u6210\uFF1B\u4EC5\u63A5\u7BA1\u672C\u6D4F\u89C8\u5668\u540C\u4E00\u8BA1\u5212\u7684\u8BB0\u5F55\uFF0C\u4E0D\u5F71\u54CD\u5176\u4ED6\u7535\u8111');
    }
  }
  async function takeoverLocal() {
    if (state.busy || state.reloading) return;
    let claimed = false;
    state.busy = true; render();
    try {
      if (!state.lock || !tabToken) throw new Error('\u8BF7\u5148\u9501\u5B9A\u5F53\u524D\u8BA1\u5212');
      if (activeRun(state.run) && (state.run.accountId !== state.lock.accountId || state.run.planId !== state.lock.planId)) {
        throw new Error('\u672C\u6807\u7B7E\u9875\u8FD8\u6709\u5176\u4ED6\u8BA1\u5212\u7684\u8F6E\u6B21\uFF0C\u8BF7\u5148\u505C\u6B62\u540E\u518D\u63A5\u7BA1');
      }
      const form = readCfg();
      assertIdentity();
      const lock = { ...state.lock }, key = planRunKey(lock);
      const lease = GM_getValue(key, null);
      const saved = GM_getValue(RUN_KEY, null);
      const sourceLease = activeRun(lease) ? lease : activeRun(saved) ? saved : state.run;
      const source = localTakeoverSource(lock, sourceLease);
      if (saved?.status === 'submitting' || state.run?.status === 'submitting') throw new Error('\u5F53\u524D\u6807\u7B7E\u9875\u6B63\u5728\u63D0\u4EA4\uFF0C\u6682\u4E0D\u80FD\u63A5\u7BA1');
      if (activeRun(saved) && (saved.accountId !== lock.accountId || saved.planId !== lock.planId)) {
        throw new Error('\u672C\u6807\u7B7E\u9875\u4FDD\u5B58\u7740\u5176\u4ED6\u8BA1\u5212\u7684\u8F6E\u6B21\uFF0C\u672A\u63A5\u7BA1');
      }
      const latestLease = GM_getValue(key, null);
      if (JSON.stringify(latestLease) !== JSON.stringify(lease)) throw new Error('\u8BA1\u5212\u8FD0\u884C\u6743\u6B63\u5728\u53D8\u5316\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u63A5\u7BA1');
      const run = { ...lock, ...form, owner: tabToken, day: localDay(), status: 'needs_review',
        startedAt: Math.max(Date.now(), Number(lease?.startedAt || 0) + 1, Number(source?.startedAt || 0) + 1), nextAt: 0,
        confirmed: [], pending: null, lastTodayCents: 0, lastScanAt: 0, logs: [],
        reason: '\u672C\u673A\u63A5\u7BA1\u4E2D\uFF0C\u4EC5\u6838\u5BF9\u4ECA\u65E5\u4EFB\u52A1', takeoverCheckPending: true, takeoverSource: source };
      state.run = run;
      // Reserve ownership before any asynchronous page work. Old pages fail assertLease before clicking.
      GM_setValue(key, { owner: run.owner, startedAt: run.startedAt, day: run.day,
        status: run.status, updatedAt: Date.now(), takeoverFrom: source?.owner || '' });
      claimed = true;
      state.stopRequested = false; state.stopAfterSubmit = false;
      saveRun();
      log('\u5F00\u59CB\u672C\u673A\u63A5\u7BA1\uFF1B\u5DF2\u963B\u6B62\u672C\u6D4F\u89C8\u5668\u65E7\u6807\u7B7E\u9875\u540E\u7EED\u64CD\u4F5C\uFF0C\u6B63\u5728\u53EA\u8BFB\u6838\u5BF9\u4ECA\u65E5\u4EFB\u52A1');
      await new Promise(resolve => setTimeout(resolve, 250));
      assertLease();
      const scan = await scanToday();
      assertLease();
      if (state.stopRequested) throw new Error('\u7528\u6237\u5DF2\u505C\u6B62\u63A5\u7BA1\u6838\u5BF9');
      const sourceKey = source?.owner ? 'qc-live-speed-scheduler-run-v2-' + source.owner : '';
      const currentSource = sourceKey ? GM_getValue(sourceKey, null) : null;
      if (currentSource && currentSource.startedAt === source.startedAt && currentSource.pending &&
          JSON.stringify(currentSource.pending) !== JSON.stringify(source.pending)) {
        run.takeoverSource = { ...source, day: currentSource.day, hours: currentSource.hours,
          pending: { ...currentSource.pending } };
        throw new Error('\u65E7\u6807\u7B7E\u9875\u51FA\u73B0\u65B0\u7684\u5F85\u786E\u8BA4\u63D0\u4EA4\uFF0C\u63A5\u7BA1\u5DF2\u6682\u505C\uFF0C\u8BF7\u5148\u6838\u5BF9');
      }
      verifyTakeoverPending(source, scan);
      if (sourceKey && source.owner !== tabToken && currentSource &&
          currentSource.startedAt === source.startedAt && currentSource.accountId === lock.accountId && currentSource.planId === lock.planId) {
        GM_setValue(sourceKey, { ...currentSource, status: 'stopped', nextAt: 0,
          reason: '\u672C\u6D4F\u89C8\u5668\u5DF2\u7531\u5176\u4ED6\u6807\u7B7E\u9875\u63A5\u7BA1', takenOverBy: tabToken, takenOverAt: Date.now() });
      }
      scheduleTakeover(run, scan);
    } catch (error) {
      const message = error?.message || String(error);
      if (claimed) stopRun(message, 'needs_review');
      else phase('\u672C\u673A\u63A5\u7BA1\u672A\u5F00\u59CB\uFF1A' + message);
    } finally { state.busy = false; render(); }
  }
  function requestStop() {
    if (state.busy && state.run?.takeoverCheckPending) {
      state.stopRequested = true;
      phase('\u5DF2\u8BF7\u6C42\u505C\u6B62\uFF1B\u672C\u673A\u63A5\u7BA1\u6838\u5BF9\u7ED3\u675F\u540E\u4E0D\u4F1A\u81EA\u52A8\u63D0\u4EA4');
      return;
    }
    if (!state.run || !['scheduled', 'submitting'].includes(state.run.status)) return;
    if (state.reloading) {
      stopRun('\u7528\u6237\u505C\u6B62\u81EA\u52A8\u7EED\u6295\uFF1B\u4E0B\u4E00\u8F6E\u5237\u65B0\u540E\u4E0D\u4F1A\u63D0\u4EA4');
    } else if (state.busy && state.run.status === 'submitting') {
      state.stopAfterSubmit = true;
      phase('\u5DF2\u8BF7\u6C42\u505C\u6B62\uFF1B\u5F85\u5F53\u524D\u63D0\u4EA4\u7ED3\u679C\u6838\u5BF9\u540E\u7ED3\u675F');
    } else if (state.busy) {
      state.stopRequested = true;
      phase('\u5DF2\u8BF7\u6C42\u505C\u6B62\uFF1B\u5F53\u524D\u68C0\u67E5\u7ED3\u675F\u540E\u4E0D\u518D\u63D0\u4EA4');
    } else stopRun('\u7528\u6237\u505C\u6B62\u81EA\u52A8\u7EED\u6295');
  }
  async function reconcile() {
    if (state.busy || !state.run || state.run.status !== 'needs_review' || !state.run.pending) return;
    state.busy = true; render();
    try {
      if (!tabToken || state.run.owner !== tabToken) throw new Error('\u8BF7\u5728\u539F\u542F\u52A8\u6807\u7B7E\u9875\u6838\u5BF9\u5E76\u6062\u590D\u5B9A\u65F6');
      if (state.run.day !== localDay()) throw new Error('\u5DF2\u8DE8\u65E5\uFF0C\u4E0D\u80FD\u6062\u590D\u6628\u65E5\u81EA\u52A8\u7EED\u6295');
      assertIdentity();
      const run = state.run, p = run.pending;
      const scan = await scanToday();
      const hits = scan.items.filter(x => x.name === p.name);
      if (hits.length !== 1 || hits[0].budgetCents !== p.budgetCents ||
          hits[0].hours !== run.hours || hits[0].day !== run.day ||
          hits[0].mode !== '\u4E00\u952E\u8D77\u91CF' || hits[0].goal !== '\u76F4\u64AD\u95F4\u8D2D\u4E70') {
        throw new Error('\u672A\u627E\u5230\u552F\u4E00\u4E14\u53C2\u6570\u543B\u5408\u7684\u4EFB\u52A1\uFF1B\u4ECD\u9700\u4EBA\u5DE5\u6838\u5BF9');
      }
      const hit = hits[0];
      if ((run.confirmed || []).some(x => x.id === hit.id)) throw new Error('\u4EFB\u52A1\u5DF2\u5728\u672C\u8F6E\u786E\u8BA4\u8BB0\u5F55\u4E2D\uFF0C\u505C\u6B62\u4EE5\u907F\u514D\u91CD\u590D\u8BA1\u6570');
      run.confirmed.push({ name: hit.name, id: hit.id,
        budgetCents: hit.budgetCents, createdAt: hit.createdAt });
      run.pending = null;
      run.lastTodayCents = scan.totalCents;
      run.nextAt = hit.createdAt + run.intervalMinutes * 60000;
      if (scan.totalCents + run.budgetCents > run.capCents) {
        stopRun('\u5DF2\u6838\u5BF9\u4EFB\u52A1 ' + hit.id + '\uFF1B\u4E0B\u4E00\u6B21\u5C06\u8D85\u8FC7\u5F53\u65E5\u4E0A\u9650', 'complete');
      } else if (localDay(new Date(run.nextAt)) !== run.day) {
        stopRun('\u5DF2\u6838\u5BF9\u4EFB\u52A1 ' + hit.id + '\uFF1B\u4E0B\u6B21\u8C03\u63A7\u65F6\u95F4\u5DF2\u8DE8\u65E5', 'complete');
      } else if (Date.now() - run.nextAt > LATE_MS) {
        stopRun('\u5DF2\u6838\u5BF9\u4EFB\u52A1 ' + hit.id + '\uFF1B\u9519\u8FC7\u9884\u5B9A\u65F6\u95F4\u8D85\u8FC7 5 \u5206\u949F\uFF0C\u4E0D\u81EA\u52A8\u8865\u6295');
      } else {
        run.status = 'scheduled';
        run.reason = '';
        saveRun();
        phase('\u5DF2\u6838\u5BF9\u4EFB\u52A1 ' + hit.id + '\uFF1B\u4E0B\u6B21\u6267\u884C ' + timeText(run.nextAt));
        log('\u5DF2\u786E\u8BA4\u4EFB\u52A1 ' + hit.name + '\uFF08' + hit.id + '\uFF09\uFF0C\u6062\u590D\u672C\u8F6E\u5B9A\u65F6\uFF1B\u4ECA\u65E5\u7D2F\u8BA1 ' + yuan(scan.totalCents) + ' \u5143');
        report('\u5DF2\u6062\u590D\u672C\u8F6E\u81EA\u52A8\u7EED\u6295\uFF0C\u7B49\u5F85\u4E0B\u6B21\u8C03\u63A7');
      }
    } catch (error) { phase('\u6838\u5BF9\u672A\u5B8C\u6210\uFF1A' + error.message); report(error.message); }
    finally { state.busy = false; render(); }
  }
  function timerTick() {
    const run = state.run;
    if (!run || run.status !== 'scheduled' || run.owner !== tabToken || state.busy || state.reloading) return;
    const saved = GM_getValue(RUN_KEY, null);
    const plan = GM_getValue(planRunKey(run), null);
    if (!saved || saved.startedAt !== run.startedAt || saved.owner !== tabToken || saved.status !== 'scheduled' ||
        !plan || plan.startedAt !== run.startedAt || plan.owner !== tabToken || plan.status !== 'scheduled') {
      if (saved && saved.startedAt === run.startedAt) state.run = saved;
      phase('\u8BE5\u8BA1\u5212\u8FD0\u884C\u8BB0\u5F55\u5DF2\u6539\u53D8\uFF1B\u672C\u6807\u7B7E\u9875\u4E0D\u518D\u81EA\u52A8\u6267\u884C');
      return;
    }
    if (localDay() !== run.day) { stopRun('\u65E5\u671F\u5DF2\u53D8\u66F4\uFF0C\u672C\u8F6E\u7ED3\u675F', 'complete'); return; }
    if (Date.now() >= run.nextAt) cycle(false);
  }

  host.style.cssText = 'position:fixed;z-index:2147483646;inset:0;pointer-events:none';
  host.textContent = '';
  const shadow = host.attachShadow({ mode: 'open' });
// Independent portrait/landscape launcher profiles. Layout-only; no task state is changed.
function createAndroidLauncherPosition(shadow, storageKey, slot) {
  const key = storageKey + '-orientation-v2';
  const layoutEvent = 'qc-android-launcher-layout-v3';
  let launcher = null, drag = null, suppressUntil = 0, timers = [], stableMode = '', axisWidth = 0, resizedAt = 0;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function orientation() {
    const view = viewport();
    const active = shadow.activeElement || document.activeElement;
    const typing = active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable);
    // Desktop-site mode and some tablet firmware report a stale ScreenOrientation.
    // The visual viewport follows the actual displayed axes, except when a keyboard is open.
    if (typing && stableMode && Math.abs(view.width - axisWidth) < axisWidth * 0.1) return stableMode;
    if (view.width > 0 && Math.abs(view.width / view.height - 1) > 0.12) {
      stableMode = view.width < view.height ? 'portrait' : 'landscape';
      axisWidth = view.width;
      return stableMode;
    }
    if (stableMode) return stableMode;
    const type = window.screen?.orientation?.type || '';
    if (type.startsWith('portrait')) return 'portrait';
    if (type.startsWith('landscape')) return 'landscape';
    const screen = window.screen;
    if (screen?.width > 0 && screen?.height > 0 && screen.width !== screen.height)
      return screen.width < screen.height ? 'portrait' : 'landscape';
    return window.innerWidth < window.innerHeight ? 'portrait' : 'landscape';
  }
  function read() {
    const value = GM_getValue(key, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function viewport() {
    const view = window.visualViewport;
    const scale = Number(view?.scale) || 1;
    return {height: Math.max(100, view?.height || window.innerHeight),
      width: view?.width || window.innerWidth, top: view?.offsetTop || 0,
      left: view?.offsetLeft || 0, unit: 1 / Math.max(0.1, scale)};
  }
  function geometry(index = slot) {
    const view = viewport();
    // Use the same rendered size for all four scripts, including when desktop mode zooms out.
    const gap = 10 * view.unit, margin = Math.min(12 * view.unit, view.height / 12);
    const height = Math.min(122 * view.unit, Math.max(1, (view.height - 2 * margin - 3 * gap) / 4));
    const min = view.top + margin, range = Math.max(0, view.height - height - 2 * margin);
    const groupHeight = 4 * height + 3 * gap;
    const initialTop = view.top + Math.max(margin, (view.height - groupHeight) / 2) + index * (height + gap);
    return {height, min, range, gap, unit: view.unit,
      right: Math.max(0, window.innerWidth - view.left - view.width),
      defaultRatio: range ? clamp((initialTop - min) / range, 0, 1) : 0};
  }
  function place() {
    if (!launcher?.isConnected) return;
    const mode = orientation(), size = geometry(), saved = read()[mode];
    const ratio = typeof saved === 'number' && Number.isFinite(saved) ? clamp(saved, 0, 1) : size.defaultRatio;
    const host = shadow.host;
    if (host) {
      host.dataset.qcLauncherSlot = String(slot);
      host.dataset.qcLauncherMode = mode;
      host.dataset.qcLauncherRatio = String(ratio);
    }
    // Share desired locations through DOM attributes (also works across userscript sandboxes).
    // Move only the displayed positions; never overwrite the user's saved profiles here.
    const desired = [{slot, ratio}];
    for (const peer of document.querySelectorAll('[data-qc-launcher-slot]')) {
      const index = Number(peer.dataset.qcLauncherSlot);
      if (peer === host || index === slot || !Number.isInteger(index) || index < 0 || index > 3) continue;
      const value = Number(peer.dataset.qcLauncherRatio);
      desired.push({slot: index, ratio: peer.dataset.qcLauncherMode === mode && Number.isFinite(value)
        ? clamp(value, 0, 1) : geometry(index).defaultRatio});
    }
    desired.sort((a, b) => a.ratio - b.ratio || a.slot - b.slot);
    const distance = size.height + size.gap;
    desired.forEach((item, i) => { item.top = Math.max(size.min + item.ratio * size.range,
      i ? desired[i - 1].top + distance : size.min); });
    for (let i = desired.length - 1; i >= 0; i--)
      desired[i].top = Math.min(desired[i].top, i === desired.length - 1
        ? size.min + size.range : desired[i + 1].top - distance);
    const top = desired.find(item => item.slot === slot).top;
    launcher.style.transform = 'none';
    launcher.style.boxSizing = 'border-box';
    launcher.style.width = (34 * size.unit) + 'px';
    launcher.style.fontSize = (12 * size.unit) + 'px';
    launcher.style.padding = (8 * size.unit) + 'px ' + (5 * size.unit) + 'px';
    launcher.style.letterSpacing = (2 * size.unit) + 'px';
    launcher.style.right = size.right + 'px';
    launcher.style.height = size.height + 'px';
    launcher.style.minHeight = size.height + 'px';
    launcher.style.maxHeight = size.height + 'px';
    launcher.style.top = top + 'px';
    launcher.style.bottom = 'auto';
    launcher.style.touchAction = 'none';
    launcher.style.userSelect = 'none';
    launcher.dataset.qcOrientation = mode;
  }
  function notify() { document.dispatchEvent(new Event(layoutEvent)); }
  function cancel() {
    if (drag?.moved) suppressUntil = Date.now() + 400;
    drag = null; place();
  }
  function schedule() {
    // Rotations/keyboard/browser bars must never overwrite a stored profile.
    resizedAt = Date.now(); cancel();
    timers.forEach(clearTimeout);
    // Firmware/browser viewport updates may arrive later than the orientation event.
    timers = [100, 350, 800, 1500].map(delay => setTimeout(() => { place(); notify(); }, delay));
  }
  function bind(button, open) {
    if (drag) cancel();
    launcher = button; place(); notify();
    button.onpointerdown = event => {
      if (event.button != null && event.button !== 0) return;
      drag = {id: event.pointerId, mode: orientation(), y: event.clientY,
        top: parseFloat(button.style.top), moved: false, size: geometry()};
      try { button.setPointerCapture(event.pointerId); } catch (_) {}
    };
    button.onpointermove = event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.mode !== orientation()) { cancel(); return; }
      if (Math.abs(event.clientY - drag.y) > 5) drag.moved = true;
      if (!drag.moved) return;
      event.preventDefault();
      button.style.top = clamp(drag.top + event.clientY - drag.y, drag.size.min, drag.size.min + drag.size.range) + 'px';
    };
    button.onpointerup = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const current = drag; drag = null;
      if (current.moved) {
        suppressUntil = Date.now() + 400;
        if (current.mode === orientation() && Date.now() - resizedAt > 250) {
          const values = read();
          values[current.mode] = current.size.range ? clamp((parseFloat(button.style.top) - current.size.min) / current.size.range, 0, 1) : 0;
          GM_setValue(key, values);
        }
      }
      place(); notify();
    };
    button.onpointercancel = cancel;
    button.onlostpointercapture = () => { if (drag) cancel(); };
    button.onclick = () => { if (Date.now() >= suppressUntil) open(); };
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.screen?.orientation?.addEventListener('change', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener(layoutEvent, () => { if (!drag) place(); });
  return {bind};
}

  const launcherPlacement = createAndroidLauncherPosition(shadow, LAUNCHER_KEY, 2);
  const css = `<style>
    :host{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
    .launcher{pointer-events:auto;position:fixed;right:0;z-index:2147483645;width:34px;min-height:118px;writing-mode:vertical-rl;letter-spacing:2px;background:rgba(0,122,255,.95);color:#fff;border:1px solid rgba(255,255,255,.4);border-right:0;border-radius:13px 0 0 13px;padding:11px 7px;box-shadow:0 6px 20px rgba(0,72,158,.23);font-size:12px;font-weight:600;cursor:grab;touch-action:none;user-select:none;backdrop-filter:blur(12px)}
    .panel{pointer-events:auto;position:fixed;right:12px;top:12px;width:min(390px,calc(100vw - 24px));height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:hidden;display:flex;flex-direction:column;z-index:2147483646;background:rgba(250,251,253,.97);border:1px solid rgba(200,208,220,.7);border-radius:18px;box-shadow:0 18px 48px rgba(28,41,62,.2),0 2px 8px rgba(28,41,62,.08);backdrop-filter:blur(18px);font-size:13px;line-height:1.5}
    .head{flex:none;display:flex;align-items:center;justify-content:space-between;min-height:58px;padding:12px 14px 12px 18px;background:rgba(255,255,255,.92);border-bottom:1px solid #e5e9ef}.head strong{font-size:15px}.head strong:before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:50%;background:#007aff;box-shadow:0 0 0 4px #eaf3ff;vertical-align:1px}.head small{display:block;margin:3px 0 0 18px;color:#7c8595;font-size:11px}.head button{width:30px;height:30px;border:0;border-radius:50%;background:#f0f2f5;color:#596272;font-size:21px}
    .body{min-height:0;flex:1;overflow-y:auto;padding:14px 16px 18px;scrollbar-color:#c8d0db transparent;scrollbar-width:thin}.card{background:#fff;border:1px solid #e5e9ef;border-radius:13px;padding:11px 12px;margin-bottom:12px;box-shadow:0 1px 3px rgba(24,44,72,.035);overflow-wrap:anywhere}.eyebrow{font-size:12px;font-weight:700;color:#596273;margin-bottom:7px}.title{font-weight:700}.muted,.hint{font-size:11px;color:#697386;line-height:1.55}.hint{margin-top:8px}.warn{color:#a14b0c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field{min-width:0;display:block;margin:5px 0;color:#505b6d;font-size:12px}.field input,.field select{display:block;width:100%;min-height:37px;margin-top:5px;border:1px solid #d6dde7;border-radius:10px;padding:8px 10px;background:#fff;color:#1d1d1f;font-size:13px}.field input:focus,.field select:focus{outline:none;border-color:#007aff;box-shadow:0 0 0 3px rgba(0,122,255,.12)}
    .row{display:flex;gap:8px;margin-top:10px}.btn{border:1px solid #cbdcff;border-radius:10px;padding:9px 11px;background:#fff;color:#0066d6;font-weight:600;flex:1}.btn:hover:not(:disabled){background:#edf5ff}.btn.primary{background:#007aff;color:#fff;border-color:#007aff}.btn.stop{color:#d33b32;border-color:#ffd4d1;flex:0 0 56px}.status{padding:10px 11px;background:#eaf3ff;border:1px solid #d9eaff;border-radius:10px;color:#175aaf;font-weight:700}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.metric{min-width:0;padding:10px;background:#f7f9fc;border:1px solid #e6ebf2;border-radius:10px}.metric span{display:block;color:#6e7787;font-size:11px}.metric strong{display:block;margin-top:3px;color:#233044;font-size:15px;font-variant-numeric:tabular-nums}.metric strong.accent{color:#006ee6;font-size:18px;letter-spacing:.4px}.log{height:110px;overflow:auto;background:#17202f;color:#dbe8fa;border-radius:11px;padding:9px 10px;white-space:pre-wrap;font:11px/1.55 Consolas,monospace}.report{max-height:180px;overflow:auto;white-space:pre-wrap;border:1px solid #e5e9ef;border-radius:11px;padding:10px;font:11px/1.5 Consolas,monospace}
    @media (pointer:coarse){.btn{min-height:44px}.field input,.field select{min-height:42px;font-size:14px}.head button{width:36px;height:36px}}
    .body{overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.panel{max-height:calc(100dvh - 24px)}
  </style>`;
  function render() {
    const oldBody = shadow.querySelector('.body');
    if (oldBody) state.panelScroll = oldBody.scrollTop;
    let rows = [];
    try { rows = overviewRows().filter(x => x.active); } catch (_) { /* \u975E\u76F4\u64AD\u9875\u65F6\u4FDD\u6301\u6700\u5C0F\u5316\u5165\u53E3 */ }
    state.rows = rows;
    const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
    const run = state.run;
    const active = run && ['scheduled', 'submitting', 'needs_review'].includes(run.status);
    const lockedOptions = rows.map(x => `<option value="${esc(x.id)}" ${state.selectedId === x.id ? 'selected' : ''}>${esc(x.name)}\uFF08${esc(x.id)}\uFF09</option>`).join('');
    const next = run && run.status === 'scheduled' ? timeText(run.nextAt) : '\u2014';
    const countdown = run && run.status === 'scheduled' ? durationText(run.nextAt - Date.now()) : '\u2014';
    const remainingCents = run ? Math.max(0, run.capCents - (run.lastTodayCents || 0)) : null;
    shadow.innerHTML = css + `<button id="launch" class="launcher" title="\u70B9\u51FB\u5C55\u5F00\uFF0C\u62D6\u52A8\u8C03\u6574\u4F4D\u7F6E" style="display:${state.open ? 'none' : 'block'};top:${esc(state.launcherTop)}%">\u8C03\u901F\u52A9\u624B</button>
      <div class="panel" style="display:${state.open ? 'flex' : 'none'}"><div class="head"><div><strong>\u5343\u5DDD\u76F4\u64AD\u5B9A\u65F6\u8C03\u901F\u52A9\u624B</strong><small>v1.2.6 \u5B89\u5353\u7248 \u00B7 \u540E\u53F0\u5EF6\u8FDF\u81EA\u52A8\u6838\u5BF9 \u00B7 \u652F\u6301\u672C\u673A\u63A5\u7BA1 \u00B7 \u5F53\u524D\u76F4\u64AD\u8BA1\u5212 \u00B7 \u9ED8\u8BA4\u9759\u9ED8\u6700\u5C0F\u5316</small></div><button id="minimize" title="\u6700\u5C0F\u5316">\u2212</button></div><div class="body">
      <div class="card"><div class="eyebrow">\u9501\u5B9A\u5F53\u524D\u76F4\u64AD\u8BA1\u5212</div><div class="title">${esc(lock?.planName || '\u5C1A\u672A\u9501\u5B9A')}</div><div class="muted">\u8D26\u6237 ${esc(lock?.accountId || '\u2014')} \u00B7 \u8BA1\u5212 ${esc(lock?.planId || '\u2014')}</div>${!urlContextSafeDetail() ? `<label class="field">\u5F53\u524D\u9875\u5728\u6295\u8BA1\u5212<select id="plan-choice" ${state.busy || active ? 'disabled' : ''}><option value="">\u8BF7\u9009\u62E9\u8BA1\u5212</option>${lockedOptions}</select></label>` : '<div class="hint">\u5F53\u524D\u4F4D\u4E8E\u76F4\u64AD\u8BA1\u5212\u8BE6\u60C5\u9875\uFF0C\u53EF\u76F4\u63A5\u9501\u5B9A\u8BE5\u8BA1\u5212\u3002</div>'}<div class="row"><button class="btn" id="lock" ${state.busy || active ? 'disabled' : ''}>\u9501\u5B9A\u5F53\u524D\u8BA1\u5212</button></div></div>
      <div class="card"><div class="eyebrow">\u4E00\u952E\u8C03\u901F\u53C2\u6570</div><div class="hint">\u8C03\u63A7\u5DE5\u5177\uFF1A\u4E00\u952E\u8C03\u901F \u00B7 \u8C03\u63A7\u65B9\u5F0F\uFF1A\u4E00\u952E\u8D77\u91CF \u00B7 \u8D77\u91CF\u63A2\u7D22\u76EE\u6807\uFF1A\u76F4\u64AD\u95F4\u8D2D\u4E70</div><div class="grid"><label class="field">\u5355\u6B21\u8C03\u63A7\u603B\u9884\u7B97\uFF08\u5143\uFF09<input id="budget" type="number" min="0.01" step="0.01" value="${esc(cfg.budget)}" ${state.busy || active ? 'disabled' : ''}></label><label class="field">\u8C03\u63A7\u65F6\u957F\uFF08\u5C0F\u65F6\uFF09<input id="hours" type="number" min="0.5" max="24" step="0.5" value="${esc(cfg.hours)}" ${state.busy || active ? 'disabled' : ''}></label><label class="field">\u7EED\u6295\u95F4\u9694\uFF08\u5C0F\u65F6\uFF09<input id="interval" type="number" min="0.5" max="24" step="0.5" value="${esc(cfg.intervalHours)}" ${state.busy || active ? 'disabled' : ''}></label><label class="field">\u8BE5\u8BA1\u5212\u5F53\u65E5\u4E0A\u9650\uFF08\u5143\uFF09<input id="cap" type="number" min="0.01" step="0.01" value="${esc(cfg.dailyCap)}" ${state.busy || active ? 'disabled' : ''}></label></div><div class="hint">\u4E0A\u9650\u8BA1\u5165\u5F53\u524D\u8BA1\u5212\u4ECA\u5929\u8C03\u63A7\u5217\u8868\u4E2D\u7684\u5168\u90E8\u4E00\u952E\u8C03\u901F\u4EFB\u52A1\uFF0C\u5305\u62EC\u4EBA\u5DE5\u521B\u5EFA\u7684\u4EFB\u52A1\u3002\u4E0B\u4E00\u6B21\u63D0\u4EA4\u4F1A\u8D85\u51FA\u4E0A\u9650\u65F6\u7ED3\u675F\u672C\u8F6E\u3002</div></div>
      <div class="card"><div class="eyebrow">\u6267\u884C</div><div class="hint warn">\u6BCF\u4E2A\u76F4\u64AD\u8BA1\u5212\u8BF7\u4FDD\u6301\u5728\u5404\u81EA\u7684\u5343\u5DDD\u6807\u7B7E\u9875\uFF1B\u4E0D\u540C\u6807\u7B7E\u9875\u53EF\u5404\u81EA\u5B9A\u65F6\uFF0C\u540C\u4E00\u8BA1\u5212\u4E0D\u80FD\u91CD\u590D\u542F\u52A8\u3002\u542F\u52A8\u65F6\u5148\u5C06\u4EFB\u52A1\u65E5\u671F\u7B5B\u9009\u4E3A\u4ECA\u5929\u5E76\u6838\u5BF9\u9884\u7B97\uFF1A\u82E5\u5DF2\u6709\u8C03\u63A7\u4E2D\u4EFB\u52A1\uFF0C\u5219\u6309\u6700\u8FD1\u4EFB\u52A1\u7684\u521B\u5EFA\u65F6\u95F4\u5F00\u59CB\u5012\u8BA1\u65F6\uFF0C\u4E0D\u91CD\u590D\u63D0\u4EA4\uFF1B\u82E5\u4ECA\u5929\u6CA1\u6709\u4EFB\u52A1\uFF0C\u5219\u8FD4\u56DE\u8BA1\u5212\u5217\u8868\u521B\u5EFA\u9996\u8F6E\u3002\u4E0B\u4E00\u8F6E\u5230\u70B9\u540E\u5148\u56DE\u5230\u8BA1\u5212\u5217\u8868\u5E76\u5237\u65B0\uFF0C\u518D\u4ECE\u8BE5\u8BA1\u5212\u201C\u4E00\u952E\u8C03\u901F\u201D\u65C1\u7684\u201C+\u201D\u521B\u5EFA\u3002\u63D0\u4EA4\u540E\u5EF6\u957F\u89C2\u5BDF\u5F39\u7A97\u5E76\u81EA\u52A8\u591A\u6B21\u6838\u5BF9\u201C\u8C03\u63A7\u201D\u4EFB\u52A1\uFF1B\u786E\u8BA4\u6210\u529F\u540E\u6062\u590D\u5012\u8BA1\u65F6\uFF0C\u59CB\u7EC8\u4E0D\u81EA\u52A8\u91CD\u63D0\u3002\u4EC5\u5F53\u5929\u7EED\u6295\uFF0C\u9519\u8FC7\u9884\u5B9A\u65F6\u95F4\u8D85\u8FC7 5 \u5206\u949F\u4E0D\u8865\u6295\u3002</div><div class="row"><button class="btn primary" id="start" ${state.busy || active ? 'disabled' : ''}>\u6838\u5BF9\u4ECA\u65E5\u4EFB\u52A1\u5E76\u542F\u52A8</button><button class="btn stop" id="stop" ${run && (['scheduled', 'submitting'].includes(run.status) || (state.busy && run.takeoverCheckPending)) ? '' : 'disabled'}>\u505C\u6B62</button></div><div class="row"><button class="btn" id="takeover" ${state.busy || state.reloading || !state.lock ? 'disabled' : ''}>\u672C\u673A\u63A5\u7BA1\u5E76\u6838\u5BF9\u4ECA\u65E5\u4EFB\u52A1</button></div><div class="hint">\u4EC5\u63A5\u7BA1\u672C\u6D4F\u89C8\u5668\u5F53\u524D\u8BA1\u5212\u7684\u65E7\u8BB0\u5F55\uFF0C\u4E0D\u4F1A\u901A\u77E5\u5176\u4ED6\u7535\u8111\u3002\u5DF2\u6709\u4EFB\u52A1\u6309\u6700\u8FD1\u521B\u5EFA\u65F6\u95F4\u6062\u590D\u5012\u8BA1\u65F6\uFF1B\u5F85\u786E\u8BA4\u63D0\u4EA4\u672A\u6838\u6E05\u65F6\u4E0D\u8865\u6295\u3002</div>${run && run.status === 'needs_review' && !run.takeoverCheckPending ? '<div class="row"><button class="btn" id="reconcile">\u6838\u5BF9\u5DF2\u63D0\u4EA4\u4EFB\u52A1\u5E76\u6062\u590D\u5B9A\u65F6\uFF08\u4E0D\u91CD\u63D0\uFF09</button></div>' : ''}</div>
      <div class="card"><div class="eyebrow">\u6267\u884C\u72B6\u6001</div><div class="status">${esc(state.phase)}</div><div class="metrics"><div class="metric"><span>\u8DDD\u79BB\u4E0B\u4E00\u8F6E</span><strong id="countdown" class="accent">${esc(countdown)}</strong></div><div class="metric"><span>\u5355\u6B21\u8C03\u63A7\u9884\u7B97</span><strong>${run ? yuan(run.budgetCents) + ' \u5143' : cfg.budget ? esc(cfg.budget) + ' \u5143' : '\u2014'}</strong></div><div class="metric"><span>\u8C03\u63A7\u65F6\u957F</span><strong>${run ? run.hours + ' \u5C0F\u65F6' : cfg.hours ? esc(cfg.hours) + ' \u5C0F\u65F6' : '\u2014'}</strong></div><div class="metric"><span>\u4ECA\u65E5\u5269\u4F59\u989D\u5EA6</span><strong>${remainingCents === null ? '\u2014' : yuan(remainingCents) + ' \u5143'}</strong></div></div><div class="hint">${run ? '\u72B6\u6001\uFF1A' + esc(run.status) + ' \u00B7 \u672C\u8F6E\u786E\u8BA4 ' + (run.confirmed || []).length + ' \u6B21 \u00B7 \u4ECA\u65E5\u5DF2\u5B89\u6392 ' + yuan(run.lastTodayCents || 0) + ' \u5143' : '\u5C1A\u672A\u542F\u52A8'}<br>\u4E0B\u4E00\u8F6E\u9884\u8BA1\uFF1A${esc(next)}${run?.lastScanAt ? ' \u00B7 \u9884\u7B97\u6838\u5BF9\u4E8E ' + esc(timeText(run.lastScanAt)) : ''}</div></div>
      <div class="card"><div class="eyebrow">\u6267\u884C\u8BB0\u5F55</div><div class="log">${esc((run?.logs || state.logs).slice(-35).join('\n') || '\u5C1A\u65E0\u8BB0\u5F55')}</div></div><div class="card"><div class="eyebrow">\u7ED3\u679C\u62A5\u544A</div><div class="report">${esc(state.report || '\u6267\u884C\u540E\u751F\u6210\u62A5\u544A')}</div><div class="row"><button class="btn" id="copy">\u590D\u5236\u62A5\u544A</button></div></div></div></div>`;
        launcherPlacement.bind(shadow.getElementById('launch'), () => { state.open = true; render(); });
    shadow.getElementById('minimize').onclick = () => { state.open = false; render(); };
    shadow.getElementById('lock').onclick = chooseLock;
    shadow.getElementById('start').onclick = start;
    shadow.getElementById('takeover').onclick = takeoverLocal;
    shadow.getElementById('stop').onclick = requestStop;
    const choice = shadow.getElementById('plan-choice');
    if (choice) choice.onchange = e => { state.selectedId = e.target.value; };
    for (const [key, id] of [['budget', 'budget'], ['hours', 'hours'], ['intervalHours', 'interval'], ['dailyCap', 'cap']]) {
      const input = shadow.getElementById(id);
      if (input) input.onchange = e => { cfg[key] = e.target.value; saveCfg(); };
    }
    const rec = shadow.getElementById('reconcile');
    if (rec) rec.onclick = reconcile;
    shadow.getElementById('copy').onclick = () => { if (state.report) GM_setClipboard(state.report); };
    if (oldBody) shadow.querySelector('.body').scrollTop = state.panelScroll;
  }
  function urlContextSafeDetail() { try { return urlContext().detail; } catch (_) { return false; } }

  function refreshCountdown() {
    const value = shadow.getElementById('countdown');
    if (value) value.textContent = state.run?.status === 'scheduled' ?
      durationText(state.run.nextAt - Date.now()) : '\u2014';
  }

  if (state.run) {
    state.lock = { accountId: state.run.accountId, planId: state.run.planId, planName: state.run.planName };
    state.selectedId = state.run.planId;
    if (state.run.status === 'submitting') {
      state.run.status = 'needs_review';
      state.run.reason = '\u9875\u9762\u5728\u63D0\u4EA4\u7ED3\u679C\u786E\u8BA4\u524D\u5237\u65B0\uFF1B\u7981\u6B62\u81EA\u52A8\u91CD\u63D0';
      saveRun();
    }
    if (state.run.status === 'scheduled') {
      state.phase = state.run.owner !== tabToken ? '\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u6301\u6709\u672C\u8F6E\uFF1B\u672C\u6807\u7B7E\u9875\u4E0D\u81EA\u52A8\u7EED\u6295' :
        state.run.refreshRequestedFor === state.run.nextAt &&
        state.run.refreshCompletedFor !== state.run.nextAt ?
          '\u7F51\u9875\u5DF2\u5237\u65B0\uFF0C\u7B49\u5F85\u9501\u5B9A\u8BA1\u5212\u91CD\u65B0\u52A0\u8F7D' :
          '\u9759\u9ED8\u7B49\u5F85\u4E0B\u6B21\u8C03\u63A7\uFF1A' + timeText(state.run.nextAt);
    } else state.phase = state.run.reason || '\u8BF7\u67E5\u770B\u672C\u8F6E\u72B6\u6001';
  }
  render();
  setInterval(timerTick, TICK_MS);
  setInterval(refreshCountdown, 1000);
  window.addEventListener('focus', timerTick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) timerTick(); });
  window.addEventListener('pageshow', e => {
    if (e.persisted) { state.open = false; render(); timerTick(); }
  });
  } catch (error) {
    host.style.cssText = 'position:fixed;right:0;top:50%;z-index:2147483646;max-width:300px;padding:12px;background:#fff0ee;color:#a32920;border:1px solid #f2b9b2;border-radius:10px 0 0 10px;font:12px/1.5 sans-serif;pointer-events:auto';
    const message = '\u8C03\u901F\u52A9\u624B\u542F\u52A8\u5931\u8D25\uFF1A' + (error && error.message || String(error));
    if (host.shadowRoot) host.shadowRoot.textContent = message;
    else host.textContent = message;
    console.error('\u5343\u5DDD\u76F4\u64AD\u5B9A\u65F6\u8C03\u901F\u52A9\u624B\u542F\u52A8\u5931\u8D25', error);
  }
})();
