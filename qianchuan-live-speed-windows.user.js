// ==UserScript==
// @name         千川直播定时一键调速助手
// @namespace    local.qianchuan.live-speed-scheduler
// @version      1.2.4
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-windows.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-windows.user.js
// @description  当前直播计划定时调速；提交后容忍后台页面延迟，自动多次核对已建任务，禁止重复提交
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
  host.textContent = '调速助手正在启动';
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
  } catch (_) { /* 无法跨刷新确认原标签页时不自动续跑 */ }
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
      reason: oldDay && oldDay < localDay() ? '前一日轮次已结束' : '本标签页无对应的运行轮次' });
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
    initialRun.reason = '前一日轮次已结束；昨日未确认的提交请人工核对';
    GM_setValue(RUN_KEY, initialRun);
    retireOldPlanLease(initialRun, initialRun);
  }
  const initialReport = GM_getValue(LOG_KEY,
    initialRun ? GM_getValue(LEGACY_LOG_KEY, '') : '');
  const cfg = Object.assign({ budget: '', hours: '', intervalHours: '', dailyCap: '' },
    GM_getValue(CFG_KEY, GM_getValue('qc-live-speed-scheduler-config-v1', {})));
  if (cfg.intervalHours === '' && Number(cfg.intervalMinutes) > 0) cfg.intervalHours = Number(cfg.intervalMinutes) / 60;
  const state = {
    open: false, busy: false, reloading: false, stopAfterSubmit: false, stopRequested: false, phase: '请锁定当前直播计划',
    lock: null, run: initialRun, rows: [], selectedId: '',
    logs: [], report: initialReport, panelScroll: 0,
    launcherTop: Math.max(12, Math.min(88, Number(GM_getValue(LAUNCHER_KEY, 66)) || 66))
  };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function text(el) { return (el && el.innerText || '').trim().replace(/\s+/g, ' '); }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  function one(items, label) {
    const found = Array.from(items).filter(visible);
    if (found.length !== 1) throw new Error(label + '应恰好出现一次，实际 ' + found.length + ' 次');
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
    return ms ? new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
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
      '千川直播定时一键调速助手',
      r ? '账户 ID：' + r.accountId + '；计划：' + r.planName + '（' + r.planId + '）' : '未启动',
      r ? '日期：' + r.day + '；单次预算：' + yuan(r.budgetCents) + '元；时长：' + r.hours + '小时；间隔：' + r.intervalMinutes / 60 + '小时；当日上限：' + yuan(r.capCents) + '元' : '',
      r ? '本轮已确认任务：' + (r.confirmed || []).length + ' 次；最近核对的该计划今日调控预算：' + yuan(r.lastTodayCents || 0) + '元' : '',
      r ? '状态：' + r.status + '；下次执行：' + timeText(r.nextAt) : '',
      '结果：' + message,
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
    phase((status === 'complete' ? '当日完成：' : '已停止：') + message);
    log(message);
    report(message);
  }
  function blockCheck() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .main-vmok-plugin-modal__wrap, .tools-vmok-plugin-modal__wrap'))
      .filter(visible);
    const words = dialogs.map(text).join(' ');
    if (/验证码|滑块验证|登录失效|权限不足|访问受限|平台风控/.test(words)) {
      throw new Error('出现登录、验证、权限或风控提示');
    }
    if (dialogs.some(el => !text(el).includes('新建调控任务'))) {
      throw new Error('出现其他千川弹窗；请先人工处理');
    }
  }
  function assertLease() {
    if (!activeRun(state.run)) return;
    const saved = GM_getValue(RUN_KEY, null);
    const plan = GM_getValue(planRunKey(state.run), null);
    if (!saved || saved.owner !== tabToken || saved.startedAt !== state.run.startedAt ||
        saved.status !== state.run.status || !plan || plan.owner !== tabToken ||
        plan.startedAt !== state.run.startedAt || plan.status !== state.run.status) {
      throw new Error('本轮已在另一标签页改变或停止');
    }
  }
  function urlContext() {
    const u = new URL(location.href);
    if (u.origin !== 'https://qianchuan.jinritemai.com' ||
        !['/overall-prom', '/overall-prom/detail'].includes(u.pathname) ||
        !u.hash.includes('marGoal=2') || u.searchParams.get('campaignType') !== '1' ||
        u.searchParams.get('uniTab') !== 'ad' || !/^\d+$/.test(u.searchParams.get('aavid') || '')) {
      throw new Error('请进入千川乘方的直播计划页面');
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
      return { id, name: text(nameEl), active: cells.length > 2 && /投放中/.test(text(cells[2])), row };
    }).filter(item => /^\d+$/.test(item.id) && item.name);
  }
  function detailIdentity() {
    const u = urlContext();
    if (!u.detail) throw new Error('当前不是计划详情页');
    const drawer = one(document.querySelectorAll('.ad-detail-wrapper'), '直播计划详情');
    if (!drawer.innerText.includes('计划ID：' + u.planId) && !drawer.innerText.includes('计划ID: ' + u.planId)) {
      throw new Error('计划详情 ID 与网址不一致');
    }
    const name = text(drawer.querySelector('[class*="title-"]')) || '';
    return { accountId: u.accountId, planId: u.planId, name, active: /投放中/.test(drawer.innerText.slice(0, 650)), drawer };
  }
  function assertIdentity() {
    blockCheck();
    if (!state.run && !state.lock) throw new Error('尚未锁定直播计划');
    const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
    if (!lock) throw new Error('尚未锁定直播计划');
    const u = urlContext();
    if (u.accountId !== lock.accountId) throw new Error('账户已切换');
    if (u.detail) {
      const d = detailIdentity();
      if (d.planId !== lock.planId || !d.active) throw new Error('计划已切换或不在投放中');
      return d;
    }
    const row = overviewRows().find(x => x.id === lock.planId);
    if (!row || !row.active || row.name !== lock.planName) throw new Error('当前页找不到锁定的在投直播计划');
    return { accountId: u.accountId, planId: row.id, name: row.name, active: true, row: row.row };
  }
  async function wait(check, label, timeout = 16000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      blockCheck();
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    throw new Error(label + '等待超时');
  }
  async function click(el, label) {
    const resolve = typeof el === 'function' ? el : () => el;
    let target = resolve();
    if (!target || !target.isConnected) throw new Error(label + '不存在');
    if (state.stopRequested && state.run?.status !== 'submitting') throw new Error('用户请求停止，未继续提交');
    assertLease();
    assertIdentity();
    phase('即将操作：' + label);
    await new Promise(resolve => setTimeout(resolve, 180));
    target = typeof el === 'function' ? await wait(() => {
      try { const fresh = resolve(); return fresh?.isConnected ? fresh : null; }
      catch (_) { return null; }
    }, label + '刷新后入口', 10000) : resolve();
    if (!target || !target.isConnected) throw new Error(label + '在点击前消失');
    if (state.stopRequested && state.run?.status !== 'submitting') throw new Error('用户请求停止，未继续提交');
    assertLease();
    assertIdentity();
    target.click();
    await new Promise(resolve => setTimeout(resolve, 420));
  }
  function chooseLock() {
    try {
      if (state.busy) throw new Error('执行中不可更换计划');
      if (state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status)) {
        throw new Error('已有未结束的一键调速轮次');
      }
      const u = urlContext();
      let selected;
      if (u.detail) {
        const d = detailIdentity();
        if (!d.active || !d.name) throw new Error('当前详情未能确认在投计划名称');
        selected = { id: d.planId, name: d.name };
      } else {
        const rows = overviewRows().filter(x => x.active);
        selected = rows.find(x => x.id === state.selectedId) || (rows.length === 1 ? rows[0] : null);
        if (!selected) throw new Error('请先在助手中选择当前页的一条在投直播计划');
      }
      if (state.run && (state.run.planId !== selected.id || state.run.accountId !== u.accountId) &&
          !['scheduled', 'submitting', 'needs_review'].includes(state.run.status)) {
        state.run = null;
        GM_setValue(RUN_KEY, null);
      }
      state.lock = { accountId: u.accountId, planId: selected.id, planName: selected.name };
      state.selectedId = selected.id;
      phase('已锁定 ' + selected.name + '（' + selected.id + '）');
      log('锁定账户 ' + u.accountId + ' → ' + selected.name + '（' + selected.id + '）');
    } catch (error) { phase('锁定失败：' + error.message); }
  }
  function readCfg() {
    for (const [key, id] of [['budget', 'budget'], ['hours', 'hours'], ['intervalHours', 'interval'], ['dailyCap', 'cap']]) {
      const el = shadow.getElementById(id);
      if (!el) throw new Error('助手表单缺少 ' + id);
      cfg[key] = Number(el.value);
    }
    const budgetCents = moneyCents(cfg.budget), capCents = moneyCents(cfg.dailyCap);
    if (!Number.isInteger(budgetCents)) throw new Error('单次预算须为大于 0 且最多两位小数的金额');
    if (!Number.isInteger(capCents) || capCents < budgetCents) throw new Error('当日上限须不小于单次预算');
    if (!Number.isFinite(cfg.hours) || cfg.hours < 0.5 || cfg.hours > 24 || !Number.isInteger(cfg.hours * 2)) {
      throw new Error('调控时长须为 0.5–24 小时，且是 0.5 的整数倍');
    }
    const intervalMinutes = cfg.intervalHours * 60;
    if (!Number.isFinite(cfg.intervalHours) || cfg.intervalHours < 0.5 || cfg.intervalHours > 24 ||
        !Number.isInteger(cfg.intervalHours * 2) || !Number.isInteger(intervalMinutes)) {
      throw new Error('续投间隔须为 0.5–24 小时，且是 0.5 的整数倍');
    }
    saveCfg();
    return { budgetCents, capCents, hours: cfg.hours, intervalMinutes };
  }
  function taskTable(drawer) {
    const selectedTab = drawer.querySelector('[id$="-tab-uni_task_center"][aria-selected="true"]');
    if (!selectedTab) throw new Error('当前不是计划的调控页');
    if (Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-filter-echo-item')).some(visible)) {
      throw new Error('调控任务列表已有额外筛选，无法核对当日全部预算；请清除筛选');
    }
    if (drawer.querySelector('input[placeholder="输入任务名称或ID搜索"]')?.value.trim()) {
      throw new Error('调控任务列表正在按任务名称或 ID 搜索；请清空搜索');
    }
    if (Array.from(drawer.querySelectorAll('input[placeholder="请选择"]'))
      .some(input => visible(input) && input.value.trim())) {
      throw new Error('调控任务列表已有状态筛选，无法核对当日全部预算；请清除筛选');
    }
    const tab = one(Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(x => text(x) === '一键调速'), '一键调速任务标签');
    if (!tab.className.includes('--checked')) throw new Error('当前调控列表不是一键调速');
    const tables = Array.from(drawer.querySelectorAll('table.main-vmok-plugin-table')).filter(visible);
    const header = tables.find(t => text(t).includes('调控预算(元)') && text(t).includes('创建时间'));
    if (!header) throw new Error('调控列表预算或创建时间列未就绪');
    const data = tables.find(t => t.querySelector('tbody tr.main-vmok-plugin-tr'));
    const footers = Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper')).filter(visible);
    if (footers.length > 1) throw new Error('任务分页栏出现多个，无法核对任务');
    const footer = footers[0] || null;
    return { data, footer };
  }
  function emptyTaskList(drawer, table) {
    if (table.data && taskRows(table.data).length) return false;
    const panel = drawer.querySelector('[id$="-panel-uni_task_center"]') || drawer;
    const labels = [panel, table.footer, ...panel.querySelectorAll(
      '.main-vmok-plugin-page-total, .main-vmok-plugin-empty, .main-vmok-plugin-table-empty, ' +
      '[class*="empty"], tbody td[colspan]')].filter(visible);
    return labels.some(el => /共\s*0\s*条|暂无(?:数据|任务|记录)|没有(?:数据|任务|记录)/.test(text(el)));
  }
  function taskListReady(drawer) {
    const table = taskTable(drawer);
    return (table.data && taskRows(table.data).length > 0) || emptyTaskList(drawer, table);
  }
  function taskRows(data) {
    if (!data) return [];
    return Array.from(data.querySelectorAll('tbody tr.main-vmok-plugin-tr')).map(tr => {
      const cells = Array.from(tr.querySelectorAll(':scope > td'));
      if (cells.length < 8 && /共\s*0\s*条|暂无(?:数据|任务|记录)|没有(?:数据|任务|记录)/.test(text(tr))) return null;
      if (cells.length < 8) throw new Error('调控任务列数异常');
      const nameCell = text(cells[1]), id = (nameCell.match(/ID[：:]\s*(\d+)/) || [])[1];
      const name = nameCell.replace(/\s*ID[：:]\s*\d+[\s\S]*$/, '').trim();
      const day = (text(cells[7]).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      const budget = Number(text(cells[5]).replace(/,/g, ''));
      const hoursText = text(cells[6]);
      const hoursMatch = hoursText.match(/^(\d+(?:\.\d+)?)(?=\s|$)/);
      const hours = hoursMatch ? Number(hoursMatch[1]) : NaN;
      if (!id || !name || !day || !Number.isFinite(budget) || budget < 0 || !Number.isFinite(hours)) {
        throw new Error('调控任务名称、日期或金额未就绪');
      }
      const createdRaw = text(cells[7]);
      const time = (createdRaw.match(/\d{2}:\d{2}:\d{2}/) || [])[0];
      if (!time) throw new Error('调控任务创建时间未就绪');
      const [year, month, date] = day.split('-').map(Number);
      const [hour, minute, second] = time.split(':').map(Number);
      return { id, name, day, budgetCents: Math.round(budget * 100), hours,
        mode: text(cells[3]), goal: text(cells[4]), state: text(cells[2]),
        createdAt: Date.UTC(year, month - 1, date, hour - 8, minute, second) };
    }).filter(Boolean);
  }
  function taskDateRange(drawer) {
    const prefixes = Array.from(drawer.querySelectorAll('.main-vmok-plugin-custom-input__prefix'))
      .filter(x => visible(x) && text(x) === '任务开始时间：');
    if (!prefixes.length) return null;
    const prefix = one(prefixes, '任务开始时间筛选标签');
    const range = prefix.closest('.main-vmok-plugin-range-picker');
    if (!range) throw new Error('任务开始时间筛选标签结构未就绪');
    return {
      start: range.querySelector('input[placeholder="开始日期"]')?.value || '',
      end: range.querySelector('input[placeholder="结束日期"]')?.value || ''
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
        '今天的调控任务数据加载', 20000);
      return;
    }
    let range;
    if (selected) {
      const prefix = one(Array.from(drawer.querySelectorAll('.main-vmok-plugin-custom-input__prefix'))
        .filter(x => text(x) === '任务开始时间：'), '当前任务日期筛选标签');
      range = prefix.closest('.main-vmok-plugin-range-picker');
      if (!range) throw new Error('当前任务日期筛选控件不存在');
    } else {
      const more = one(Array.from(drawer.querySelectorAll('button'))
        .filter(x => text(x).startsWith('更多筛选')), '调控任务更多筛选');
      await click(more, '打开调控任务更多筛选');
      range = await wait(() => {
        const editors = Array.from(document.querySelectorAll(
          '.main-vmok-plugin-oc-filter-date-range-filter .main-vmok-plugin-range-picker'))
          .filter(visible);
        if (editors.length === 1) return editors[0];
        const inputs = Array.from(document.querySelectorAll('input[placeholder="开始日期"]'))
          .filter(visible);
        const ranges = inputs.map(x => x.closest('.main-vmok-plugin-range-picker'))
          .filter(x => x && x.querySelector('input[placeholder="结束日期"]'));
        return ranges.length === 1 ? ranges[0] : null;
      }, '任务开始时间筛选控件');
    }
    await click(range.querySelector('input[placeholder="开始日期"]'), '打开任务开始时间日期选择器');
    const shortcut = await wait(() => {
      try {
        return one(Array.from(document.querySelectorAll('.main-vmok-plugin-oc-range-picker-shortcut-item'))
          .filter(x => text(x) === '今天'), '日期选择器“今天”快捷项');
      } catch (_) { return null; }
    }, '今天快捷项');
    await click(shortcut, '选择今天的任务开始时间');
    await wait(() => range.querySelector('input[placeholder="开始日期"]')?.value === today &&
      range.querySelector('input[placeholder="结束日期"]')?.value === today,
    '任务开始时间设为今天', 5000);
    if (!selected) {
      const confirms = Array.from(document.querySelectorAll('button'))
        .filter(x => visible(x) && text(x) === '确定');
      if (confirms.length === 1) await click(confirms[0], '应用今天的任务日期筛选');
    }
    await wait(() => {
      try {
        const applied = taskDateRange(drawer), table = taskTable(drawer);
        if (applied?.start !== today || applied.end !== today) return false;
        const rows = taskRows(table.data);
        return rows.every(x => x.day === today) && taskListReady(drawer);
      } catch (_) { return false; }
    }, '今天的调控任务列表刷新', 20000);
    log('已将当前计划的一键调速任务开始时间筛选为 ' + today);
  }
  async function openTasks() {
    const where = await wait(() => {
      try { return assertIdentity(); } catch (_) { return null; }
    }, '锁定计划页面刷新', 20000);
    if (!where.row) {
      const tab = where.drawer.querySelector('[id$="-tab-uni_task_center"]');
      if (!tab) throw new Error('找不到调控标签');
      if (tab.getAttribute('aria-selected') !== 'true') await click(tab, '调控标签');
    } else {
      const currentChart = () => {
        const row = assertIdentity().row;
        if (!row) return null;
        const labels = Array.from(row.querySelectorAll('td:nth-child(6) [class*="taskLabel-"]'))
          .filter(x => text(x) === '一键调速');
        if (labels.length !== 1) return null;
        return labels[0].closest('[class*="assistTask-"]')
          ?.querySelector('iconpark-icon[name="oc-chart-histogram"]') || null;
      };
      await wait(() => { try { return currentChart(); } catch (_) { return null; } },
        '当前计划的一键调速任务入口加载', 20000);
      await click(currentChart, '查看当前计划调控任务');
    }
    const drawer = await wait(() => {
      try {
        const d = detailIdentity();
        const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
        if (d.planId !== lock.planId) return null;
        return d.drawer.querySelector('[id$="-panel-uni_task_center"]') ? d.drawer : null;
      } catch (_) { return null; }
    }, '当前计划调控页', 20000);
    const speed = await wait(() => {
      const option = Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .find(x => visible(x) && text(x) === '一键调速');
      return option || null;
    }, '一键调速标签');
    if (!speed.className.includes('--checked')) await click(speed, '一键调速列表');
    await wait(() => { try { taskTable(drawer); return true; } catch (_) { return false; } }, '一键调速任务表', 20000);
    return drawer;
  }
  async function closeTasks() {
    if (!urlContext().detail) return;
    const d = detailIdentity().drawer;
    const back = one(d.querySelectorAll('button[class*="liveRoomLink-"]'), '返回推直播间按钮');
    await click(back, '返回直播计划列表');
    await wait(() => {
      try {
        const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
        return !urlContext().detail && overviewRows().some(x => x.id === lock.planId);
      }
      catch (_) { return false; }
    }, '返回锁定计划列表', 18000);
  }
  async function scanToday() {
    const drawer = await openTasks();
    await applyTodayFilter(drawer);
    await wait(() => {
      try { return taskListReady(drawer); } catch (_) { return false; }
    }, '调控任务数据加载', 20000);
    let table = taskTable(drawer);
    let { footer } = table;
    if (emptyTaskList(drawer, table)) {
      if (state.run) { state.run.lastTodayCents = 0; state.run.lastScanAt = Date.now(); saveRun(); }
      await closeTasks();
      return { items: [], totalCents: 0 };
    }
    if (!footer) throw new Error('有调控任务但缺少任务分页栏');
    const active = one(footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '任务当前页');
    if (text(active) !== '1') {
      const priorFirst = taskRows(taskTable(drawer).data)[0]?.id;
      await click(() => one(Array.from(taskTable(drawer).footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
        .filter(x => text(x) === '1'), '任务第一页'), '任务第一页');
      await wait(() => {
        try {
          const table = taskTable(drawer);
          return text(one(table.footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '任务页')) === '1' &&
            taskRows(table.data)[0]?.id !== priorFirst;
        }
        catch (_) { return false; }
      }, '任务第一页数据');
    }
    const today = localDay(), items = [], ids = new Set();
    let page = 0;
    while (++page <= MAX_SCAN_PAGES) {
      await wait(() => {
        try {
          const current = taskTable(drawer);
          return current.data && taskRows(current.data).length > 0;
        } catch (_) { return false; }
      }, '第 ' + page + ' 页调控任务字段完整加载', 20000);
      table = taskTable(drawer);
      const rows = taskRows(table.data);
      const selected = taskDateRange(drawer);
      if (selected?.start !== today || selected.end !== today) {
        throw new Error('任务日期筛选已变化，停止预算核对');
      }
      for (const item of rows) {
        if (ids.has(item.id)) throw new Error('翻页后出现重复任务 ID，列表尚未稳定');
        ids.add(item.id);
        if (item.day !== today) {
          throw new Error('按今天筛选后仍出现其他创建日期的任务，无法确认当日预算');
        }
        items.push(item);
      }
      footer = table.footer;
      if (!footer) throw new Error('翻页前任务分页栏消失');
      const next = Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
        .find(x => x.querySelector('.main-vmok-plugin-page-turner__next-icon'));
      if (!next) throw new Error('任务列表缺少下一页状态');
      if (next.className.includes('--disabled') || next.getAttribute('aria-disabled') === 'true') break;
      const priorFirst = rows[0].id;
      await click(() => {
        const current = taskTable(drawer).footer;
        const currentPage = one(current.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '任务当前页');
        if (text(currentPage) !== String(page)) throw new Error('任务页在点击前改变');
        const freshNext = one(Array.from(current.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
          .filter(x => x.querySelector('.main-vmok-plugin-page-turner__next-icon')), '下一页按钮');
        return freshNext.className.includes('--disabled') ? null : freshNext;
      }, '核对调控任务第 ' + (page + 1) + ' 页');
      await wait(() => {
        try { const t = taskTable(drawer); return taskRows(t.data)[0]?.id !== priorFirst &&
          text(one(t.footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '任务页')) === String(page + 1); }
        catch (_) { return false; }
      }, '调控任务翻页', 16000);
    }
    if (page > MAX_SCAN_PAGES) throw new Error('今日任务超过安全扫描页数，无法确认当日上限');
    const totalCents = items.reduce((sum, x) => sum + x.budgetCents, 0);
    if (state.run) { state.run.lastTodayCents = totalCents; state.run.lastScanAt = Date.now(); saveRun(); }
    await closeTasks();
    return { items, totalCents };
  }
  function setInput(input, value) {
    if (!input || !visible(input)) throw new Error('平台输入框不存在或不可见');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus(); setter.call(input, String(value));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }
  function createModal() {
    const found = Array.from(document.querySelectorAll('[role="dialog"]')).filter(x =>
      visible(x) && text(x).includes('新建调控任务') && text(x).includes('调控总预算') && text(x).includes('调控时长'));
    return one(found, '新建调控任务弹窗');
  }
  function field(modal, label) {
    return one(Array.from(modal.querySelectorAll('.main-vmok-plugin-oc-row')).filter(x =>
      text(x.querySelector('.main-vmok-plugin-oc-title-text')) === label), label + '字段');
  }
  function chosenOption(modal, label) {
    return one(Array.from(field(modal, label).querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(x => x.classList.contains('main-vmok-plugin-radio-item--checked') ||
        x.getAttribute('aria-checked') === 'true'), label + '当前选中项');
  }
  async function selectRadio(modal, label, choice) {
    const row = field(modal, label);
    const option = one(Array.from(row.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(x => text(x) === choice), label + '选项');
    if (!option.classList.contains('main-vmok-plugin-radio-item--checked')) {
      await click(option, label + '：' + choice);
    }
    await wait(() => {
      try { return text(chosenOption(modal, label)) === choice; }
      catch (_) { return false; }
    }, label + '选中“' + choice + '”', 5000);
  }
  async function openCreateModal() {
    await closeTasks();
    phase('已返回计划列表，等待当前计划行的“一键调速 +”创建入口');
    await wait(() => {
      const row = assertIdentity().row;
      if (!row) return null;
      const labels = Array.from(row.querySelectorAll('td:nth-child(6) [class*="taskLabel-"]'))
        .filter(x => text(x) === '一键调速');
      if (labels.length !== 1) return null;
      const action = labels[0].closest('[class*="assistTask-"]');
      const icons = action && Array.from(action.querySelectorAll('iconpark-icon[name="oc-icon-plus"]'));
      return icons && icons.length === 1 ? icons[0] : null;
    }, '当前计划行的一键调速“+”入口加载', 20000);
    await click(() => {
      const row = assertIdentity().row;
      const labels = Array.from(row.querySelectorAll('td:nth-child(6) [class*="taskLabel-"]'))
        .filter(x => text(x) === '一键调速');
      return labels.length === 1 ? labels[0].closest('[class*="assistTask-"]')
        ?.querySelector('iconpark-icon[name="oc-icon-plus"]') : null;
    }, '从计划列表行内“+”新建一键调速任务');
    return await wait(() => {
      try { return createModal(); } catch (_) { return null; }
    }, '一键调速创建弹窗', 12000);
  }
  function taskName(run) {
    const seq = String((run.confirmed || []).length + 1).padStart(2, '0');
    const nonce = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'QCS_' + run.day.replace(/-/g, '') + '_一键起量_' + run.planId + '_' + seq + '_' + nonce;
  }
  async function prepareModal(modal, run, name) {
    await selectRadio(modal, '调控方式', '一键起量');
    await selectRadio(modal, '起量探索目标', '直播间购买');
    const budget = one(field(modal, '调控总预算').querySelectorAll('input.main-vmok-plugin-input'), '调控总预算输入框');
    const hours = one(field(modal, '调控时长').querySelectorAll('input.main-vmok-plugin-input'), '调控时长输入框');
    const nameInput = one(field(modal, '任务名称').querySelectorAll('input.main-vmok-plugin-input'), '任务名称输入框');
    setInput(budget, yuan(run.budgetCents));
    setInput(hours, run.hours);
    setInput(nameInput, name);
    await new Promise(resolve => setTimeout(resolve, 450));
    if (Number(budget.value) !== run.budgetCents / 100) throw new Error('提交前调控总预算与锁定配置不一致');
    if (Number(hours.value) !== run.hours) throw new Error('提交前调控时长与锁定配置不一致');
    if (nameInput.value !== name) throw new Error('提交前任务名称与本轮任务名不一致');
    if (text(chosenOption(modal, '调控方式')) !== '一键起量') throw new Error('提交前调控方式未选中一键起量');
    if (text(chosenOption(modal, '起量探索目标')) !== '直播间购买') throw new Error('提交前起量探索目标未选中直播间购买');
  }
  // 先观察实际 DOM，再判定超时：后台计时器恢复时，不能因墙钟已过期而漏掉已关闭的弹窗。
  function waitSubmittedModal(modal) {
    phase('已点击提交，等待平台关闭弹窗；后台延迟时继续观察，不重复提交');
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
            finish(new Error('提交弹窗在延长观察后仍未关闭；保留待核对任务，不重复提交')); return;
          }
          if (!warned && elapsed >= 30000) {
            warned = true;
            log('提交弹窗尚未关闭，继续观察最多3分钟；切回页面时立即检查，不重复点击提交');
            phase('提交后页面响应较慢，正在延长观察；不会重复提交');
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
    if (hits.length > 1) throw new Error('任务名在调控列表中出现 ' + hits.length + ' 次；结果待人工核对');
    if (!hits.length) return null;
    const hit = hits[0];
    if (hit.budgetCents !== run.pending.budgetCents || hit.hours !== run.hours ||
        hit.mode !== '一键起量' || hit.goal !== '直播间购买' || hit.day !== run.day ||
        !Number.isFinite(hit.createdAt) || hit.createdAt <= 0 || hit.createdAt > Date.now() + 60000) {
      throw new Error('任务已出现但预算、时长、创建时间或目标与本轮参数不一致');
    }
    if ((run.confirmed || []).some(x => x.id === hit.id)) throw new Error('任务已在本轮确认记录中，停止以避免重复计数');
    return hit;
  }
  async function verifyPending() {
    const run = state.run;
    if (!run || !run.pending) throw new Error('没有待核对的提交');
    phase('提交后只在“调控”页核对结果，不在此页创建任务');
    const deadline = Date.now() + SUBMIT_VERIFY_MS;
    let scan, hit;
    for (let attempt = 1; attempt <= MAX_VERIFY_SCANS; attempt++) {
      assertLease();
      if (localDay() !== run.day) throw new Error('核对期间已跨日，停止自动续投');
      let transientError = '';
      try { scan = await scanToday(); }
      catch (error) {
        // 仅重试加载类错误；账户/计划、权限、筛选和预算等不一致仍立即停止。
        if (!/等待超时|列表尚未稳定/.test(error.message)) throw error;
        transientError = error.message; scan = null;
      }
      assertLease();
      hit = scan ? pendingHit(run, scan) : null;
      if (hit) break;
      if (attempt === MAX_VERIFY_SCANS || Date.now() >= deadline) {
        throw new Error('提交后自动核对仍未找到唯一且参数吻合的任务' +
          (transientError ? '：' + transientError : '') + '；保留待核对记录');
      }
      log('提交后第 ' + attempt + ' 次核对尚未确认' + (transientError ? '：' + transientError : '：新任务暂未进入列表') +
        '；5秒后再次只读核对，不重复提交');
      phase('正在自动核对已提交任务（第 ' + (attempt + 1) + ' 次），确认后自动恢复倒计时');
      await new Promise(resolve => setTimeout(resolve, VERIFY_RETRY_MS));
    }
    run.confirmed.push({ name: hit.name, id: hit.id, budgetCents: hit.budgetCents, createdAt: hit.createdAt });
    run.pending = null;
    run.lastTodayCents = scan.totalCents;
    run.nextAt = hit.createdAt + run.intervalMinutes * 60000;
    if (state.stopAfterSubmit) {
      stopRun('当前提交已核对成功，按停止请求结束自动续投');
    } else if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('当前计划今日已安排 ' + yuan(scan.totalCents) + ' 元，下一次将超过上限 ' + yuan(run.capCents) + ' 元', 'complete');
    } else if (localDay(new Date(run.nextAt)) !== run.day) {
      stopRun('下一次调控时间已跨日，本轮结束', 'complete');
    } else if (Date.now() - run.nextAt > LATE_MS) {
      stopRun('任务已确认，但下一轮预定时间已超过5分钟，不自动补投');
    } else {
      run.status = 'scheduled';
      run.reason = '';
      saveRun();
      phase('已核对任务 ' + hit.id + '；下次执行 ' + timeText(run.nextAt));
      log('已确认任务 ' + hit.name + '（' + hit.id + '），今日累计 ' + yuan(scan.totalCents) + ' 元');
      report('等待下次自动调控');
    }
  }
  function scheduleFromActiveTask(run, scan) {
    const active = scan.items.filter(x => /调控中/.test(x.state) &&
      x.mode === '一键起量' && x.goal === '直播间购买');
    if (!active.length) return false;
    active.sort((a, b) => b.createdAt - a.createdAt ||
      (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
    const hit = active[0];
    if (hit.createdAt > Date.now() + 60000) throw new Error('调控中任务的创建时间晚于当前时间，无法恢复倒计时');
    if ((run.confirmed || []).some(x => x.id === hit.id)) {
      throw new Error('上一轮任务 ' + hit.id + ' 仍显示调控中；请等待平台更新后再决定是否续投');
    }
    run.confirmed.push({ name: hit.name, id: hit.id, budgetCents: hit.budgetCents,
      createdAt: hit.createdAt, source: 'existing' });
    run.lastTodayCents = scan.totalCents;
    run.nextAt = hit.createdAt + run.intervalMinutes * 60000;
    if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('已找到调控中任务 ' + hit.id + '；下一次将超过当日上限', 'complete');
    } else if (localDay(new Date(run.nextAt)) !== run.day) {
      stopRun('已找到调控中任务 ' + hit.id + '；下次调控时间已跨日', 'complete');
    } else if (Date.now() - run.nextAt > LATE_MS) {
      stopRun('已找到调控中任务 ' + hit.id + '；错过预定时间超过 5 分钟，不自动补投');
    } else {
      run.status = 'scheduled';
      saveRun();
      phase('已找到调控中任务 ' + hit.id + '；下次执行 ' + timeText(run.nextAt));
      log('按现有任务创建时间 ' + timeText(hit.createdAt) + ' 恢复倒计时；今日累计 ' +
        yuan(scan.totalCents) + ' 元；本次不重复提交');
      report('已从调控中任务恢复定时，等待下一轮');
    }
    return true;
  }
  async function submitOnce() {
    const run = state.run;
    if (!run || run.status !== 'scheduled') throw new Error('轮次状态不允许提交');
    if (localDay() !== run.day) { stopRun('已跨到新的一天', 'complete'); return; }
    assertIdentity();
    phase('提交前只读核对该计划今日预算；随后返回计划列表，从“一键调速 +”创建');
    let scan = await scanToday();
    while (scan.items.some(x => /调控中/.test(x.state) &&
      (run.confirmed || []).some(confirmed => confirmed.id === x.id))) {
      if (Date.now() - run.nextAt > LATE_MS) {
        throw new Error('上一轮任务在预定时间后 5 分钟仍显示调控中，未重复提交');
      }
      phase('上一轮任务仍显示调控中，10 秒后重新核对；此时不会重复提交');
      await new Promise(resolve => setTimeout(resolve, 10000));
      if (state.stopRequested) throw new Error('用户请求停止，未继续提交');
      scan = await scanToday();
    }
    if (scheduleFromActiveTask(run, scan)) return;
    if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('当前计划今日已安排 ' + yuan(scan.totalCents) + ' 元；再提交 ' + yuan(run.budgetCents) + ' 元将超过上限 ' + yuan(run.capCents) + ' 元', 'complete');
      return;
    }
    const name = taskName(run);
    const modal = await openCreateModal();
    let submit;
    try {
      await prepareModal(modal, run, name);
      submit = one(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
        .filter(x => text(x) === '提交'), '一键调速提交按钮');
      if (submit.disabled) throw new Error('平台提交按钮不可用');
    } catch (error) {
      const cancel = Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
        .filter(x => visible(x) && text(x) === '取消');
      if (cancel.length === 1) {
        try { await click(cancel[0], '关闭未提交的调控弹窗'); }
        catch (closeError) { log('未能自动关闭未提交弹窗：' + closeError.message); }
      }
      throw error;
    }
    run.pending = { name, budgetCents: run.budgetCents, clickedAt: Date.now(), hiddenAtSubmit: document.hidden };
    run.status = 'submitting';
    saveRun();
    log('提交前锁定任务 ' + name + '；预算 ' + yuan(run.budgetCents) + ' 元，时长 ' + run.hours + ' 小时；页面' + (document.hidden ? '位于后台' : '位于前台'));
    await click(submit, '提交一键起量任务');
    await waitSubmittedModal(modal);
    await verifyPending();
  }
  async function refreshBeforeNextRound(run) {
    assertLease();
    assertIdentity();
    phase('下一轮已到点，返回锁定计划列表后刷新网页');
    await closeTasks();
    await wait(() => {
      try { return assertIdentity().row || null; }
      catch (_) { return null; }
    }, '刷新前锁定计划列表', 20000);
    if (state.stopRequested) throw new Error('用户请求停止，未刷新或提交下一轮');
    assertLease();
    run.refreshRequestedFor = run.nextAt;
    run.refreshCompletedFor = 0;
    saveRun();
    log('下一轮到点；已返回锁定计划列表，准备刷新网页');
    state.reloading = true;
    location.reload();
  }
  async function resumeAfterRefresh(run) {
    phase('网页已刷新，等待锁定计划和一键调速入口重新加载');
    await wait(() => {
      try {
        const row = assertIdentity().row;
        if (!row) return null;
        const labels = Array.from(row.querySelectorAll('td:nth-child(6) [class*="taskLabel-"]'))
          .filter(x => text(x) === '一键调速');
        return labels.length === 1 ? labels[0].closest('[class*="assistTask-"]')
          ?.querySelector('iconpark-icon[name="oc-icon-plus"]') : null;
      } catch (_) { return null; }
    }, '刷新后锁定计划和一键调速“+”入口', 30000);
    if (state.stopRequested) throw new Error('用户请求停止，未提交下一轮');
    if (Date.now() - run.nextAt > LATE_MS) throw new Error('刷新后错过预定时间超过 5 分钟；不自动补投');
    assertLease();
    run.refreshCompletedFor = run.nextAt;
    saveRun();
    log('网页刷新完成；已重新确认锁定计划和一键调速创建入口');
  }
  async function cycle(first) {
    if (state.busy) return;
    state.busy = true;
    state.stopRequested = false;
    state.stopAfterSubmit = false;
    render();
    try {
      const run = state.run;
      if (!run || run.owner !== tabToken || run.status !== 'scheduled') throw new Error('当前标签页没有可执行的轮次');
      if (!first && Date.now() - run.nextAt > LATE_MS) throw new Error('错过预定时间超过 5 分钟；不自动补投');
      if (!first && Date.now() < run.nextAt) return;
      if (!first) {
        if (run.refreshRequestedFor !== run.nextAt) {
          await refreshBeforeNextRound(run);
          return;
        }
        if (run.refreshCompletedFor !== run.nextAt) await resumeAfterRefresh(run);
      }
      if (state.stopRequested) throw new Error('用户请求停止，未提交下一轮');
      await submitOnce();
    } catch (error) {
      const message = error && error.message || String(error);
      if (state.run) {
        if (state.run.pending || state.run.status === 'submitting') stopRun(message + '；结果不明确，请先到调控页核对任务，禁止直接重提', 'needs_review');
        else stopRun(message);
      } else phase('执行停止：' + message);
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
        throw new Error('已有未结束的一键调速轮次，请先处理或停止');
      }
      if (state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status)) {
        throw new Error('已有运行或待核对轮次，请先处理');
      }
      if (!state.lock) throw new Error('请先锁定当前直播计划');
      const other = retireOldPlanLease(state.lock, saved);
      if (activeRun(other)) throw new Error('该计划今天已有其他标签页的运行或待核对轮次（开始于 ' +
        timeText(other.startedAt) + '）；请在原计划标签页处理，避免重复提交');
      const form = readCfg();
      assertIdentity();
      if (!tabToken) throw new Error('浏览器未提供可跨刷新识别的当前标签页');
      const run = {
        ...state.lock, ...form, owner: tabToken, day: localDay(), status: 'scheduled',
        startedAt: Date.now(), nextAt: Date.now(), confirmed: [], pending: null,
        lastTodayCents: 0, lastScanAt: 0, logs: [], reason: ''
      };
      state.run = run;
      saveRun();
      log('手动启动核对；如有调控中任务先按其创建时间恢复定时，否则创建首轮；后续每隔 ' +
        run.intervalMinutes / 60 + ' 小时仅在今日自动续投');
      await cycle(true);
    } catch (error) { phase('启动失败：' + error.message); }
  }
  function localTakeoverSource(lock, lease) {
    if (state.run && state.run.accountId === lock.accountId && state.run.planId === lock.planId &&
        state.run.takeoverCheckPending) return state.run.takeoverSource;
    if (!activeRun(lease)) return null;
    if (lease.status === 'submitting') throw new Error('旧轮次正在提交，请等待其结果核对或在原页停止后再接管');
    const key = 'qc-live-speed-scheduler-run-v2-' + lease.owner;
    let source = GM_getValue(key, null);
    if (!source) {
      const legacy = GM_getValue(LEGACY_RUN_KEY, null);
      if (legacy && legacy.owner === lease.owner && legacy.startedAt === lease.startedAt) source = legacy;
    }
    if (source && (source.owner !== lease.owner || source.startedAt !== lease.startedAt ||
        source.accountId !== lock.accountId || source.planId !== lock.planId)) {
      throw new Error('旧轮次记录与计划锁不一致，未接管');
    }
    if (source?.status === 'submitting') throw new Error('旧轮次正在提交，暂不能接管');
    if (source?.takeoverCheckPending) {
      const inherited = source.takeoverSource;
      if (inherited && (inherited.accountId !== lock.accountId || inherited.planId !== lock.planId)) {
        throw new Error('上次接管保留的任务信息与当前计划不一致');
      }
      return inherited || { owner: source.owner, startedAt: source.startedAt, status: source.status,
        accountId: source.accountId, planId: source.planId, pending: null };
    }
    if (lease.status === 'needs_review' && !source?.pending) {
      throw new Error('旧记录需要核对，但没有完整的待确认任务信息；请先在原标签页处理');
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
        hits[0].mode !== '一键起量' || hits[0].goal !== '直播间购买') {
      throw new Error('旧轮次待确认任务尚未找到唯一且参数吻合的结果；本机已暂停接管核对，不会补投。核对平台后可再次点击本机接管');
    }
  }
  function scheduleTakeover(run, scan) {
    run.lastTodayCents = scan.totalCents;
    run.lastScanAt = Date.now();
    const items = scan.items.filter(item => item.day === run.day &&
      item.mode === '一键起量' && item.goal === '直播间购买');
    if (items.some(item => !Number.isFinite(item.createdAt) || item.createdAt > Date.now() + 60000)) {
      throw new Error('今日任务创建时间无法确认，未恢复自动续投');
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    const latest = items[0];
    run.confirmed = latest ? [{ name: latest.name, id: latest.id, budgetCents: latest.budgetCents,
      createdAt: latest.createdAt, source: 'local-takeover' }] : [];
    run.nextAt = latest ? latest.createdAt + run.intervalMinutes * 60000 : Date.now();
    run.pending = null;
    run.takeoverCheckPending = false;
    if (scan.totalCents + run.budgetCents > run.capCents) {
      stopRun('本机接管核对完成；下一次预算将超过当日上限', 'complete');
    } else if (localDay(new Date(run.nextAt)) !== run.day) {
      stopRun('本机接管核对完成；下一次调控时间已跨日', 'complete');
    } else if (Date.now() - run.nextAt > LATE_MS) {
      stopRun('本机接管核对完成；最近任务的续投时间已超过5分钟，不自动补投');
    } else {
      run.status = 'scheduled';
      run.reason = '';
      saveRun();
      phase(latest ? '本机已接管；按最近任务恢复定时，下次 ' + timeText(run.nextAt) :
        '本机已接管；今日没有一键调速任务，下一次检查后创建首轮');
      log(latest ? '接管核对任务 ' + latest.id + '；按创建时间 ' + timeText(latest.createdAt) + ' 恢复倒计时' :
        '本机接管核对：今日无匹配任务，等待定时检查后创建首轮');
      report('本机接管核对完成；仅接管本浏览器同一计划的记录，不影响其他电脑');
    }
  }
  async function takeoverLocal() {
    if (state.busy || state.reloading) return;
    let claimed = false;
    state.busy = true; render();
    try {
      if (!state.lock || !tabToken) throw new Error('请先锁定当前计划');
      if (activeRun(state.run) && (state.run.accountId !== state.lock.accountId || state.run.planId !== state.lock.planId)) {
        throw new Error('本标签页还有其他计划的轮次，请先停止后再接管');
      }
      const form = readCfg();
      assertIdentity();
      const lock = { ...state.lock }, key = planRunKey(lock);
      const lease = GM_getValue(key, null);
      const saved = GM_getValue(RUN_KEY, null);
      const sourceLease = activeRun(lease) ? lease : activeRun(saved) ? saved : state.run;
      const source = localTakeoverSource(lock, sourceLease);
      if (saved?.status === 'submitting' || state.run?.status === 'submitting') throw new Error('当前标签页正在提交，暂不能接管');
      if (activeRun(saved) && (saved.accountId !== lock.accountId || saved.planId !== lock.planId)) {
        throw new Error('本标签页保存着其他计划的轮次，未接管');
      }
      const latestLease = GM_getValue(key, null);
      if (JSON.stringify(latestLease) !== JSON.stringify(lease)) throw new Error('计划运行权正在变化，请稍后重试接管');
      const run = { ...lock, ...form, owner: tabToken, day: localDay(), status: 'needs_review',
        startedAt: Math.max(Date.now(), Number(lease?.startedAt || 0) + 1, Number(source?.startedAt || 0) + 1), nextAt: 0,
        confirmed: [], pending: null, lastTodayCents: 0, lastScanAt: 0, logs: [],
        reason: '本机接管中，仅核对今日任务', takeoverCheckPending: true, takeoverSource: source };
      state.run = run;
      // Reserve ownership before any asynchronous page work. Old pages fail assertLease before clicking.
      GM_setValue(key, { owner: run.owner, startedAt: run.startedAt, day: run.day,
        status: run.status, updatedAt: Date.now(), takeoverFrom: source?.owner || '' });
      claimed = true;
      state.stopRequested = false; state.stopAfterSubmit = false;
      saveRun();
      log('开始本机接管；已阻止本浏览器旧标签页后续操作，正在只读核对今日任务');
      await new Promise(resolve => setTimeout(resolve, 250));
      assertLease();
      const scan = await scanToday();
      assertLease();
      if (state.stopRequested) throw new Error('用户已停止接管核对');
      const sourceKey = source?.owner ? 'qc-live-speed-scheduler-run-v2-' + source.owner : '';
      const currentSource = sourceKey ? GM_getValue(sourceKey, null) : null;
      if (currentSource && currentSource.startedAt === source.startedAt && currentSource.pending &&
          JSON.stringify(currentSource.pending) !== JSON.stringify(source.pending)) {
        run.takeoverSource = { ...source, day: currentSource.day, hours: currentSource.hours,
          pending: { ...currentSource.pending } };
        throw new Error('旧标签页出现新的待确认提交，接管已暂停，请先核对');
      }
      verifyTakeoverPending(source, scan);
      if (sourceKey && source.owner !== tabToken && currentSource &&
          currentSource.startedAt === source.startedAt && currentSource.accountId === lock.accountId && currentSource.planId === lock.planId) {
        GM_setValue(sourceKey, { ...currentSource, status: 'stopped', nextAt: 0,
          reason: '本浏览器已由其他标签页接管', takenOverBy: tabToken, takenOverAt: Date.now() });
      }
      scheduleTakeover(run, scan);
    } catch (error) {
      const message = error?.message || String(error);
      if (claimed) stopRun(message, 'needs_review');
      else phase('本机接管未开始：' + message);
    } finally { state.busy = false; render(); }
  }
  function requestStop() {
    if (state.busy && state.run?.takeoverCheckPending) {
      state.stopRequested = true;
      phase('已请求停止；本机接管核对结束后不会自动提交');
      return;
    }
    if (!state.run || !['scheduled', 'submitting'].includes(state.run.status)) return;
    if (state.reloading) {
      stopRun('用户停止自动续投；下一轮刷新后不会提交');
    } else if (state.busy && state.run.status === 'submitting') {
      state.stopAfterSubmit = true;
      phase('已请求停止；待当前提交结果核对后结束');
    } else if (state.busy) {
      state.stopRequested = true;
      phase('已请求停止；当前检查结束后不再提交');
    } else stopRun('用户停止自动续投');
  }
  async function reconcile() {
    if (state.busy || !state.run || state.run.status !== 'needs_review' || !state.run.pending) return;
    state.busy = true; render();
    try {
      if (!tabToken || state.run.owner !== tabToken) throw new Error('请在原启动标签页核对并恢复定时');
      if (state.run.day !== localDay()) throw new Error('已跨日，不能恢复昨日自动续投');
      assertIdentity();
      const run = state.run, p = run.pending;
      const scan = await scanToday();
      const hits = scan.items.filter(x => x.name === p.name);
      if (hits.length !== 1 || hits[0].budgetCents !== p.budgetCents ||
          hits[0].hours !== run.hours || hits[0].day !== run.day ||
          hits[0].mode !== '一键起量' || hits[0].goal !== '直播间购买') {
        throw new Error('未找到唯一且参数吻合的任务；仍需人工核对');
      }
      const hit = hits[0];
      if ((run.confirmed || []).some(x => x.id === hit.id)) throw new Error('任务已在本轮确认记录中，停止以避免重复计数');
      run.confirmed.push({ name: hit.name, id: hit.id,
        budgetCents: hit.budgetCents, createdAt: hit.createdAt });
      run.pending = null;
      run.lastTodayCents = scan.totalCents;
      run.nextAt = hit.createdAt + run.intervalMinutes * 60000;
      if (scan.totalCents + run.budgetCents > run.capCents) {
        stopRun('已核对任务 ' + hit.id + '；下一次将超过当日上限', 'complete');
      } else if (localDay(new Date(run.nextAt)) !== run.day) {
        stopRun('已核对任务 ' + hit.id + '；下次调控时间已跨日', 'complete');
      } else if (Date.now() - run.nextAt > LATE_MS) {
        stopRun('已核对任务 ' + hit.id + '；错过预定时间超过 5 分钟，不自动补投');
      } else {
        run.status = 'scheduled';
        run.reason = '';
        saveRun();
        phase('已核对任务 ' + hit.id + '；下次执行 ' + timeText(run.nextAt));
        log('已确认任务 ' + hit.name + '（' + hit.id + '），恢复本轮定时；今日累计 ' + yuan(scan.totalCents) + ' 元');
        report('已恢复本轮自动续投，等待下次调控');
      }
    } catch (error) { phase('核对未完成：' + error.message); report(error.message); }
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
      phase('该计划运行记录已改变；本标签页不再自动执行');
      return;
    }
    if (localDay() !== run.day) { stopRun('日期已变更，本轮结束', 'complete'); return; }
    if (Date.now() >= run.nextAt) cycle(false);
  }

  host.style.cssText = 'position:fixed;z-index:2147483646;inset:0;pointer-events:none';
  host.textContent = '';
  const shadow = host.attachShadow({ mode: 'open' });
  const css = `<style>
    :host{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
    .launcher{pointer-events:auto;position:fixed;right:0;z-index:2147483645;width:34px;min-height:118px;writing-mode:vertical-rl;letter-spacing:2px;background:rgba(0,122,255,.95);color:#fff;border:1px solid rgba(255,255,255,.4);border-right:0;border-radius:13px 0 0 13px;padding:11px 7px;box-shadow:0 6px 20px rgba(0,72,158,.23);font-size:12px;font-weight:600;cursor:grab;touch-action:none;user-select:none;backdrop-filter:blur(12px)}
    .panel{pointer-events:auto;position:fixed;right:12px;top:12px;width:min(390px,calc(100vw - 24px));height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:hidden;display:flex;flex-direction:column;z-index:2147483646;background:rgba(250,251,253,.97);border:1px solid rgba(200,208,220,.7);border-radius:18px;box-shadow:0 18px 48px rgba(28,41,62,.2),0 2px 8px rgba(28,41,62,.08);backdrop-filter:blur(18px);font-size:13px;line-height:1.5}
    .head{flex:none;display:flex;align-items:center;justify-content:space-between;min-height:58px;padding:12px 14px 12px 18px;background:rgba(255,255,255,.92);border-bottom:1px solid #e5e9ef}.head strong{font-size:15px}.head strong:before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:50%;background:#007aff;box-shadow:0 0 0 4px #eaf3ff;vertical-align:1px}.head small{display:block;margin:3px 0 0 18px;color:#7c8595;font-size:11px}.head button{width:30px;height:30px;border:0;border-radius:50%;background:#f0f2f5;color:#596272;font-size:21px}
    .body{min-height:0;flex:1;overflow-y:auto;padding:14px 16px 18px;scrollbar-color:#c8d0db transparent;scrollbar-width:thin}.card{background:#fff;border:1px solid #e5e9ef;border-radius:13px;padding:11px 12px;margin-bottom:12px;box-shadow:0 1px 3px rgba(24,44,72,.035);overflow-wrap:anywhere}.eyebrow{font-size:12px;font-weight:700;color:#596273;margin-bottom:7px}.title{font-weight:700}.muted,.hint{font-size:11px;color:#697386;line-height:1.55}.hint{margin-top:8px}.warn{color:#a14b0c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field{min-width:0;display:block;margin:5px 0;color:#505b6d;font-size:12px}.field input,.field select{display:block;width:100%;min-height:37px;margin-top:5px;border:1px solid #d6dde7;border-radius:10px;padding:8px 10px;background:#fff;color:#1d1d1f;font-size:13px}.field input:focus,.field select:focus{outline:none;border-color:#007aff;box-shadow:0 0 0 3px rgba(0,122,255,.12)}
    .row{display:flex;gap:8px;margin-top:10px}.btn{border:1px solid #cbdcff;border-radius:10px;padding:9px 11px;background:#fff;color:#0066d6;font-weight:600;flex:1}.btn:hover:not(:disabled){background:#edf5ff}.btn.primary{background:#007aff;color:#fff;border-color:#007aff}.btn.stop{color:#d33b32;border-color:#ffd4d1;flex:0 0 56px}.status{padding:10px 11px;background:#eaf3ff;border:1px solid #d9eaff;border-radius:10px;color:#175aaf;font-weight:700}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.metric{min-width:0;padding:10px;background:#f7f9fc;border:1px solid #e6ebf2;border-radius:10px}.metric span{display:block;color:#6e7787;font-size:11px}.metric strong{display:block;margin-top:3px;color:#233044;font-size:15px;font-variant-numeric:tabular-nums}.metric strong.accent{color:#006ee6;font-size:18px;letter-spacing:.4px}.log{height:110px;overflow:auto;background:#17202f;color:#dbe8fa;border-radius:11px;padding:9px 10px;white-space:pre-wrap;font:11px/1.55 Consolas,monospace}.report{max-height:180px;overflow:auto;white-space:pre-wrap;border:1px solid #e5e9ef;border-radius:11px;padding:10px;font:11px/1.5 Consolas,monospace}
  </style>`;
  function render() {
    const oldBody = shadow.querySelector('.body');
    if (oldBody) state.panelScroll = oldBody.scrollTop;
    let rows = [];
    try { rows = overviewRows().filter(x => x.active); } catch (_) { /* 非直播页时保持最小化入口 */ }
    state.rows = rows;
    const lock = state.run && ['scheduled', 'submitting', 'needs_review'].includes(state.run.status) ? state.run : state.lock;
    const run = state.run;
    const active = run && ['scheduled', 'submitting', 'needs_review'].includes(run.status);
    const lockedOptions = rows.map(x => `<option value="${esc(x.id)}" ${state.selectedId === x.id ? 'selected' : ''}>${esc(x.name)}（${esc(x.id)}）</option>`).join('');
    const next = run && run.status === 'scheduled' ? timeText(run.nextAt) : '—';
    const countdown = run && run.status === 'scheduled' ? durationText(run.nextAt - Date.now()) : '—';
    const remainingCents = run ? Math.max(0, run.capCents - (run.lastTodayCents || 0)) : null;
    shadow.innerHTML = css + `<button id="launch" class="launcher" title="点击展开，拖动调整位置" style="display:${state.open ? 'none' : 'block'};top:${esc(state.launcherTop)}%">调速助手</button>
      <div class="panel" style="display:${state.open ? 'flex' : 'none'}"><div class="head"><div><strong>千川直播定时调速助手</strong><small>v1.2.3 · 后台延迟自动核对 · 支持本机接管 · 当前直播计划 · 默认静默最小化</small></div><button id="minimize" title="最小化">−</button></div><div class="body">
      <div class="card"><div class="eyebrow">锁定当前直播计划</div><div class="title">${esc(lock?.planName || '尚未锁定')}</div><div class="muted">账户 ${esc(lock?.accountId || '—')} · 计划 ${esc(lock?.planId || '—')}</div>${!urlContextSafeDetail() ? `<label class="field">当前页在投计划<select id="plan-choice" ${state.busy || active ? 'disabled' : ''}><option value="">请选择计划</option>${lockedOptions}</select></label>` : '<div class="hint">当前位于直播计划详情页，可直接锁定该计划。</div>'}<div class="row"><button class="btn" id="lock" ${state.busy || active ? 'disabled' : ''}>锁定当前计划</button></div></div>
      <div class="card"><div class="eyebrow">一键调速参数</div><div class="hint">调控工具：一键调速 · 调控方式：一键起量 · 起量探索目标：直播间购买</div><div class="grid"><label class="field">单次调控总预算（元）<input id="budget" type="number" min="0.01" step="0.01" value="${esc(cfg.budget)}" ${state.busy || active ? 'disabled' : ''}></label><label class="field">调控时长（小时）<input id="hours" type="number" min="0.5" max="24" step="0.5" value="${esc(cfg.hours)}" ${state.busy || active ? 'disabled' : ''}></label><label class="field">续投间隔（小时）<input id="interval" type="number" min="0.5" max="24" step="0.5" value="${esc(cfg.intervalHours)}" ${state.busy || active ? 'disabled' : ''}></label><label class="field">该计划当日上限（元）<input id="cap" type="number" min="0.01" step="0.01" value="${esc(cfg.dailyCap)}" ${state.busy || active ? 'disabled' : ''}></label></div><div class="hint">上限计入当前计划今天调控列表中的全部一键调速任务，包括人工创建的任务。下一次提交会超出上限时结束本轮。</div></div>
      <div class="card"><div class="eyebrow">执行</div><div class="hint warn">每个直播计划请保持在各自的千川标签页；不同标签页可各自定时，同一计划不能重复启动。启动时先将任务日期筛选为今天并核对预算：若已有调控中任务，则按最近任务的创建时间开始倒计时，不重复提交；若今天没有任务，则返回计划列表创建首轮。下一轮到点后先回到计划列表并刷新，再从该计划“一键调速”旁的“+”创建。提交后延长观察弹窗并自动多次核对“调控”任务；确认成功后恢复倒计时，始终不自动重提。仅当天续投，错过预定时间超过 5 分钟不补投。</div><div class="row"><button class="btn primary" id="start" ${state.busy || active ? 'disabled' : ''}>核对今日任务并启动</button><button class="btn stop" id="stop" ${run && (['scheduled', 'submitting'].includes(run.status) || (state.busy && run.takeoverCheckPending)) ? '' : 'disabled'}>停止</button></div><div class="row"><button class="btn" id="takeover" ${state.busy || state.reloading || !state.lock ? 'disabled' : ''}>本机接管并核对今日任务</button></div><div class="hint">仅接管本浏览器当前计划的旧记录，不会通知其他电脑。已有任务按最近创建时间恢复倒计时；待确认提交未核清时不补投。</div>${run && run.status === 'needs_review' && !run.takeoverCheckPending ? '<div class="row"><button class="btn" id="reconcile">核对已提交任务并恢复定时（不重提）</button></div>' : ''}</div>
      <div class="card"><div class="eyebrow">执行状态</div><div class="status">${esc(state.phase)}</div><div class="metrics"><div class="metric"><span>距离下一轮</span><strong id="countdown" class="accent">${esc(countdown)}</strong></div><div class="metric"><span>单次调控预算</span><strong>${run ? yuan(run.budgetCents) + ' 元' : cfg.budget ? esc(cfg.budget) + ' 元' : '—'}</strong></div><div class="metric"><span>调控时长</span><strong>${run ? run.hours + ' 小时' : cfg.hours ? esc(cfg.hours) + ' 小时' : '—'}</strong></div><div class="metric"><span>今日剩余额度</span><strong>${remainingCents === null ? '—' : yuan(remainingCents) + ' 元'}</strong></div></div><div class="hint">${run ? '状态：' + esc(run.status) + ' · 本轮确认 ' + (run.confirmed || []).length + ' 次 · 今日已安排 ' + yuan(run.lastTodayCents || 0) + ' 元' : '尚未启动'}<br>下一轮预计：${esc(next)}${run?.lastScanAt ? ' · 预算核对于 ' + esc(timeText(run.lastScanAt)) : ''}</div></div>
      <div class="card"><div class="eyebrow">执行记录</div><div class="log">${esc((run?.logs || state.logs).slice(-35).join('\n') || '尚无记录')}</div></div><div class="card"><div class="eyebrow">结果报告</div><div class="report">${esc(state.report || '执行后生成报告')}</div><div class="row"><button class="btn" id="copy">复制报告</button></div></div></div></div>`;
    const launcher = shadow.getElementById('launch');
    let drag = null, moved = false;
    launcher.onpointerdown = e => { drag = { y: e.clientY, top: launcher.getBoundingClientRect().top }; launcher.setPointerCapture(e.pointerId); };
    launcher.onpointermove = e => {
      if (!drag) return;
      if (Math.abs(e.clientY - drag.y) > 5) moved = true;
      if (!moved) return;
      const top = Math.max(12, Math.min(innerHeight - launcher.offsetHeight - 12, drag.top + e.clientY - drag.y));
      launcher.style.top = top + 'px'; state.launcherTop = top / innerHeight * 100;
    };
    launcher.onpointerup = () => { if (moved) GM_setValue(LAUNCHER_KEY, state.launcherTop); drag = null; setTimeout(() => { moved = false; }, 0); };
    launcher.onclick = () => { if (!moved) { state.open = true; render(); } };
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
      durationText(state.run.nextAt - Date.now()) : '—';
  }

  if (state.run) {
    state.lock = { accountId: state.run.accountId, planId: state.run.planId, planName: state.run.planName };
    state.selectedId = state.run.planId;
    if (state.run.status === 'submitting') {
      state.run.status = 'needs_review';
      state.run.reason = '页面在提交结果确认前刷新；禁止自动重提';
      saveRun();
    }
    if (state.run.status === 'scheduled') {
      state.phase = state.run.owner !== tabToken ? '另一个标签页持有本轮；本标签页不自动续投' :
        state.run.refreshRequestedFor === state.run.nextAt &&
        state.run.refreshCompletedFor !== state.run.nextAt ?
          '网页已刷新，等待锁定计划重新加载' :
          '静默等待下次调控：' + timeText(state.run.nextAt);
    } else state.phase = state.run.reason || '请查看本轮状态';
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
    const message = '调速助手启动失败：' + (error && error.message || String(error));
    if (host.shadowRoot) host.shadowRoot.textContent = message;
    else host.textContent = message;
    console.error('千川直播定时调速助手启动失败', error);
  }
})();
