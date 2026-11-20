// ==UserScript==
// @name         视频号标准订单逐单加热助手
// @namespace    local.channels.standard-order-reorder
// @version      0.2.13
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/%E8%A7%86%E9%A2%91%E5%8F%B7%E6%A0%87%E5%87%86%E8%AE%A2%E5%8D%95%E9%80%90%E5%8D%95%E5%8A%A0%E7%83%AD%E5%8A%A9%E6%89%8B.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/%E8%A7%86%E9%A2%91%E5%8F%B7%E6%A0%87%E5%87%86%E8%AE%A2%E5%8D%95%E9%80%90%E5%8D%95%E5%8A%A0%E7%83%AD%E5%8A%A9%E6%89%8B.user.js
// @description  标准订单逐单追投，支持可编辑名称库、一键恢复、扫码与免验证提交
// @match        https://channels.weixin.qq.com/promote/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const ROOT = 'channels-standard-reorder-assistant';
  if (window.top !== window.self || document.getElementById(ROOT)) return;

  const TAB_KEY = ROOT + ':tab';
  const NAME_LIBRARY_KEY = ROOT + ':name-library:v1';
  // 仅用于首次迁移旧版默认清单，后续由独立名称库保存。
  const DEFAULT_NAMES_KEY = ROOT + ':default-names:v1';
  const BUILTIN_NAMES = [
    '增香液-12', '增香液-13', '增香液-14', '增香液-15', '增香液-16',
    '增香液-17', '增香液-18', '增香液-19', '增香液-20', '增香液-21',
    '增香液-22', '增香液-23', '增香液-24', '增香液-25', '增香液-26',
    '增香液-27', '增香液-28', '增香液-29',
    '增香液-新增测试1-2026-11-18', '增香液-新增测试2-2026-11-18'
  ].join('\n');
  if (GM_getValue(NAME_LIBRARY_KEY, null) === null) {
    const legacyNames = GM_getValue(DEFAULT_NAMES_KEY, '');
    GM_setValue(NAME_LIBRARY_KEY, parseNames(BUILTIN_NAMES + '\n' + legacyNames).join('\n'));
  }
  const defaultNames = GM_getValue(NAME_LIBRARY_KEY, BUILTIN_NAMES);
  let tabId = '';
  try {
    tabId = sessionStorage.getItem(TAB_KEY) || '';
    if (!tabId) {
      tabId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      sessionStorage.setItem(TAB_KEY, tabId);
    }
  } catch (_) { /* 无法确认原标签页时禁用自动流程 */ }
  const STORE_KEY = ROOT + ':state:' + tabId;
  const stored = tabId ? GM_getValue(STORE_KEY, null) : null;
  const state = Object.assign({
    names: '', roiMinimum: '', matches: [], choices: {}, edits: {}, settingsExpanded: true, queue: [], index: 0,
    stage: 'idle', account: '', scanComplete: false, pageCount: 0, lastSourcePage: 0,
    detailUrl: '', reviewUrl: '', returningAt: 0, openingAt: 0, reviewAmount: null,
    approvedQueueKey: '', pausedFrom: '', currentError: '', logs: []
  }, stored && typeof stored === 'object' ? stored : {});
  if (!state.names) state.names = defaultNames;
  // 兼容旧版已超时/刷新中断的提交，禁止把原表单重新当作未提交订单。
  if (currentItem() && (state.stage === 'submitting' ||
      /提交结果需要核对|提交后页面曾刷新/.test(state.currentError))) {
    currentItem().submittedAt = currentItem().submittedAt || Date.now();
  }
  let open = false;
  let busy = false;
  let scanCancel = false;
  let appliedOrderDate = null;
  let namesDraft = typeof state.namesDraft === 'string' ? state.namesDraft : state.names;
  let nameLibraryOpen = false;
  let nameLibraryDraft = null;
  if (!state.edits || typeof state.edits !== 'object' || Array.isArray(state.edits)) state.edits = {};

  const host = document.createElement('div');
  host.id = ROOT;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const css = `<style>
    :host{font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1e293b}*{box-sizing:border-box}
    button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.48;cursor:not-allowed}
    .launcher{pointer-events:auto;position:fixed;right:0;top:57%;z-index:2147483646;width:34px;min-height:122px;border:1px solid #d6e7ff;border-right:0;border-radius:12px 0 0 12px;background:#087bff;color:white;padding:10px 7px;writing-mode:vertical-rl;letter-spacing:2px;box-shadow:0 5px 18px #0b64bb44;font-weight:700}
    .panel{pointer-events:auto;position:fixed;right:12px;top:12px;width:min(410px,calc(100vw - 24px));height:calc(100dvh - 24px);display:flex;flex-direction:column;border:1px solid #dce5f1;border-radius:17px;background:#f8fbff;box-shadow:0 18px 45px #22334d35;overflow:hidden}
    .head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:13px 15px;background:white;border-bottom:1px solid #e4eaf2}.head strong{font-size:15px}.head small{display:block;color:#738196;font-size:11px}.head button{width:30px;height:30px;border:0;border-radius:50%;background:#eef2f7;color:#5a6473;font-size:19px}
    .body{min-height:0;overflow:auto;padding:13px}.card{padding:12px;margin-bottom:11px;border:1px solid #e1e8f1;border-radius:12px;background:white}.title{font-weight:700;margin-bottom:7px}.muted{color:#697789;font-size:11px}.hint{color:#9a5515;font-size:11px;margin-top:7px}.status{padding:9px 10px;background:#eaf3ff;color:#135fae;border-radius:9px;font-weight:700;overflow-wrap:anywhere}
    textarea,input{width:100%;padding:8px 9px;border:1px solid #ccd8e8;border-radius:8px;outline:0;background:white;color:#1e293b}textarea{min-height:67px;resize:vertical}input:focus,textarea:focus{border-color:#087bff;box-shadow:0 0 0 3px #087bff18}
    .row{display:flex;gap:7px;margin-top:9px}.btn{flex:1;min-width:0;border:1px solid #c9dcf7;border-radius:9px;background:white;color:#0765d5;padding:8px 9px;font-weight:700}.btn.primary{background:#087bff;border-color:#087bff;color:white}.btn.danger{color:#c7423d;border-color:#ffd2ce;flex:0 0 auto}.btn.small{flex:0 0 auto}.list{max-height:240px;overflow:auto;border:1px solid #e9edf3;border-radius:9px}.group{padding:7px 9px;border-bottom:1px solid #edf1f5}.group:last-child{border-bottom:0}.candidate{display:flex;gap:7px;padding:6px 0;align-items:flex-start;font-size:11px;overflow-wrap:anywhere}.candidate input{width:auto;margin:2px 0 0;flex:none}.candidate b{font-size:12px}.queueItem{padding:6px 0;border-bottom:1px solid #edf1f5;font-size:12px}.queueItem:last-child{border:0}.current{background:#eaf3ff;border-radius:7px;padding:6px}
    .log{max-height:135px;overflow:auto;padding:9px;background:#162235;color:#dceaff;border-radius:9px;white-space:pre-wrap;font:11px/1.5 Consolas,monospace}
    .panel.editing .list{max-height:none;overflow:visible}.panel.editing .group{padding:15px 14px}.panel.editing input[data-edit-id]{padding:11px 12px;font-size:14px;margin:5px 0 10px;min-height:42px}.panel.editing .candidate{font-size:12px}.settingsToggle{float:right;margin:0 0 6px 8px;padding:5px 9px;border:1px solid #c9dcf7;border-radius:7px;color:#0765d5;background:#fff;font-size:12px}.settingsSummary{clear:both;color:#697789;font-size:12px}.panel.editing .body{scrollbar-gutter:stable}
  </style>`;

  function clean(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' '); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])); }
  function visible(el) { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; }
  function text(el) { return clean(el && el.innerText); }
  function one(list, label) { const a = Array.from(list).filter(visible); if (a.length !== 1) throw new Error(label + '应恰好有 1 个，实际 ' + a.length + ' 个'); return a[0]; }
  function save() { if (tabId) GM_setValue(STORE_KEY, state); render(); }
  function log(message) { state.logs.push(new Date().toLocaleTimeString('zh-CN', { hour12:false }) + '  ' + message); state.logs = state.logs.slice(-120); save(); }
  function fail(message) {
    state.approvedQueueKey = '';
    state.currentError = message; state.stage = 'needs_review'; log('暂停：' + message);
  }
  function hasStandardOrderTable() {
    const header = Array.from(document.querySelectorAll('th,[role="columnheader"]'))
      .filter(visible).map(text).join(' ');
    return ['订单信息','投放进度','订单状态','操作'].every(label => header.includes(label)) &&
      /出价\s*[（(]ROI[）)]|直接成交\s*ROI/.test(header);
  }
  function standardOrderRowCount() {
    return Array.from(document.querySelectorAll('tr')).filter(row => {
      if (!visible(row)) return false;
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      return cells.length >= 4 && /\b\d{10,}_\d+\b/.test(text(cells[0]));
    }).length;
  }
  function hasStandardOrderRows() { return standardOrderRowCount() > 0; }
  function onList() {
    const u = new URL(location.href);
    if (u.origin !== 'https://channels.weixin.qq.com') return false;
    const tab = u.searchParams.get('tab');
    if (tab && tab !== 'standard') return false;
    if (/\/order-list\/?$/.test(u.pathname)) return true;
    return hasStandardOrderTable() && hasStandardOrderRows();
  }
  function accountName() { return text(document.querySelector('.account-info .name')); }
  function ensureAccount() {
    const name = accountName();
    if (!name) {
      if (!onList() && state.account) return state.account;
      throw new Error('尚未读到账户名称');
    }
    if (state.account && name !== state.account) throw new Error('视频号账户已切换');
    return name;
  }
  function parseNames(value) { return [...new Set(String(value).split(/[\n,，、;；]+/).map(clean).filter(Boolean))]; }
  function canEditNames() { return !busy && ['idle','ready','complete'].includes(state.stage); }
  function libraryNames() { return parseNames(GM_getValue(NAME_LIBRARY_KEY, BUILTIN_NAMES)); }
  function restoreLibraryNames() {
    if (!canEditNames()) return;
    const names = libraryNames();
    if (!names.length) { log('名称库为空，请先在“管理名称库”中添加并保存名称'); return; }
    nameLibraryOpen = false;
    namesDraft = names.join('\n');
    state.names = namesDraft; state.namesDraft = namesDraft;
    state.matches = []; state.choices = {}; state.edits = {};
    state.scanComplete = false; state.pageCount = 0; state.lastSourcePage = 0;
    state.approvedQueueKey = ''; state.stage = 'idle';
    log('已从名称库恢复 ' + names.length + ' 个名称，请扫描订单');
  }
  function addCurrentNamesToLibrary() {
    if (!canEditNames()) return;
    const current = parseNames(namesDraft);
    if (!current.length) { log('当前名称清单为空，请先输入名称'); return; }
    const previous = libraryNames();
    if (nameLibraryDraft !== null && parseNames(nameLibraryDraft).join('\n') !== previous.join('\n')) {
      log('名称库有未保存的修改，请先点击“保存名称库”，再加入当前清单'); return;
    }
    const names = [...new Set([...previous, ...current])];
    GM_setValue(NAME_LIBRARY_KEY, names.join('\n'));
    nameLibraryDraft = names.join('\n');
    nameLibraryOpen = false;
    log('当前清单已加入名称库：新增 ' + (names.length - previous.length) + ' 个，共 ' + names.length + ' 个名称');
  }
  function saveNameLibrary() {
    if (!canEditNames()) return;
    const names = parseNames(nameLibraryDraft ?? '');
    GM_setValue(NAME_LIBRARY_KEY, names.join('\n'));
    nameLibraryDraft = names.join('\n');
    nameLibraryOpen = false;
    log('已保存名称库，共 ' + names.length + ' 个名称；点击“从名称库恢复”可填入当前清单');
  }
  function parseRoi(value) {
    const textValue = clean(value).normalize('NFKC');
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(textValue)) return null;
    const roi = Number(textValue.replace(/,/g, ''));
    return Number.isFinite(roi) ? roi : null;
  }
  function matchesRoiFilter(row, minimum) {
    return isFullySpent(row) &&
      Number.isFinite(row.roi) && row.roi >= minimum;
  }
  function isFullySpent(row) {
    return Number.isFinite(row.spent) && Number.isFinite(row.budget) &&
      row.budget > 0 && row.spent >= row.budget;
  }
  function selectedNames() {
    const names = parseNames(state.names);
    return state.roiMinimum === '' ? names : names.filter(name => state.matches.some(row => row.name === name));
  }
  function todayInShanghai() {
    return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'}).format();
  }
  function dateInputs(card) {
    const field = card.querySelector('.filter-field--order-create-time');
    return ['开始日期', '结束日期'].map(label => field?.querySelector('input[placeholder="' + label + '"]'));
  }
  function orderTable() {
    return Array.from(document.querySelectorAll('table')).find(table => {
      if (!visible(table)) return false;
      const header = text(table.tHead) || Array.from(table.querySelectorAll('th,[role="columnheader"]')).map(text).join(' ');
      return ['订单信息','投放进度','订单状态'].every(label => header.includes(label));
    });
  }
  function orderTotal() {
    const results = orderTable()?.closest('.finder-card');
    for (const span of results?.querySelectorAll('span') || []) {
      const count = text(span).match(/^订单总数[（(]([\d,]+)[）)]$/);
      if (count) return Number(count[1].replace(/,/g, ''));
    }
    return null;
  }
  function listDiagnostics() {
    const u = new URL(location.href);
    const table = orderTable();
    const region = table?.closest('.table_out');
    return '页码=' + (pageNumber() || '未识别') +
      '，订单总数=' + (orderTotal() ?? '未识别') +
      '，可见订单行=' + standardOrderRowCount() +
      '，标准订单表=' + (table ? '已识别' : '未识别') +
      '，加载中=' + (region?.classList.contains('mp-table-fixed--loading') ? '是' : '否') +
      '，路径=' + u.pathname + (u.search || '');
  }
  async function applyTodayOrderFilter(day) {
    if (day !== todayInShanghai()) throw new Error('本轮订单日期已跨天，请重新扫描当天订单');
    ensureAccount();
    const card = one(Array.from(document.querySelectorAll('.finder-card')).filter(el =>
      el.querySelector('input[placeholder="开始日期"]') &&
      Array.from(el.querySelectorAll('button')).some(btn => text(btn) === '筛选')), '订单筛选区');
    if (!dateInputs(card).every(visible)) {
      const expand = one(Array.from(card.querySelectorAll('span')).filter(el => text(el) === '展开'), '展开订单筛选');
      expand.click();
      await waitUntil(() => dateInputs(card).every(visible), '订单创建时间筛选');
    }
    const table = await waitUntil(orderTable, '标准订单表加载').catch(error => {
      throw new Error(error.message + '（' + listDiagnostics() + '）');
    });
    const region = table.closest('.table_out');
    if (!region) throw new Error('未识别到标准订单表的加载状态');
    const hasToday = () => dateInputs(card).every(input => input?.value === day);
    const resultCount = orderTotal;
    if (appliedOrderDate?.region === region && appliedOrderDate.day === day && hasToday() &&
        !region.classList.contains('mp-table-fixed--loading')) return resultCount();
    if (!hasToday()) {
      const field = card.querySelector('.filter-field--order-create-time');
      const todayOption = () => Array.from(field.querySelectorAll(
        '.finder-ui-desktop-picker__panel__quick-select__buttons'
      )).find(el => visible(el) && text(el) === '今天');
      if (!todayOption()) {
        const calendar = one(field.querySelectorAll('.finder-ui-desktop-picker__icon-wrap'), '订单创建时间日历图标');
        calendar.click();
      }
      const today = await waitUntil(todayOption, '订单创建时间的“今天”选项');
      today.click();
      await waitUntil(hasToday, '订单创建时间回读');
    }
    const filter = one(Array.from(card.querySelectorAll('button')).filter(el => text(el) === '筛选'), '筛选按钮');
    let started = false;
    const loadingClass = 'mp-table-fixed--loading';
    const observer = new MutationObserver(records => {
      started ||= region.classList.contains(loadingClass) ||
        records.some(record => record.oldValue?.split(/\s+/).includes(loadingClass));
    });
    observer.observe(region, {attributes:true, attributeFilter:['class'], attributeOldValue:true});
    let count;
    try {
      filter.click();
      count = await waitUntil(() => {
        const activeRegion = orderTable()?.closest('.table_out');
        if ((!started && !region.classList.contains(loadingClass)) || !hasToday() ||
            !activeRegion || activeRegion.classList.contains(loadingClass)) return null;
        const total = resultCount();
        return total === null ? null : {total};
      }, '当天订单筛选结果加载');
    } finally { observer.disconnect(); }
    ensureAccount();
    appliedOrderDate = {region:orderTable()?.closest('.table_out'), day};
    return count.total;
  }
  function currentItem() { return state.queue[state.index] || null; }
  function targetName(item) { return item?.targetName == null ? item?.name || '' : item.targetName; }
  function targetBudget(item) { return item?.targetBudget == null ? item?.budget : item.targetBudget; }
  function orderDraft(item) {
    const edit = state.edits[item.id] || {};
    return {name:edit.name == null ? item.name : edit.name, budget:edit.budget == null ? String(item.budget) : edit.budget};
  }
  function selectedDraftTotal() {
    try {
      const names=selectedNames();
      if(!names.length)return null;
      return names.reduce((sum,name)=>{
        const item=state.matches.find(x=>x.name===name&&x.id===state.choices[name]);
        if(!item)throw new Error('未选来源');
        const draft=orderDraft(item);
        return sum+validateTarget(draft.name,draft.budget).targetBudget;
      },0);
    }catch(_){return null;}
  }
  function validateTarget(name, budget) {
    name = String(name).trim();
    if (!name || name.length > 25) throw new Error('新订单名称须为 1～25 个字符');
    const value = String(budget).trim();
    if (!/^\d+(?:\.0{1,2})?$/.test(value)) throw new Error('追投预算须为 100 的整数倍');
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 300000 || amount % 100 !== 0)
      throw new Error('追投预算须在 100～300000 元之间，且为 100 的整数倍');
    return {targetName:name,targetBudget:amount};
  }
  function queueApprovalKey() {
    // 新版授权包含免验证直接支付；旧版存量授权须在新提示下重新确认。
    return JSON.stringify(['submit-and-pay-v1', state.account, state.queue.map(x => [x.id, x.name, x.budget, targetName(x), targetBudget(x)])]);
  }
  function batchApprovalActive() {
    return !!state.approvedQueueKey && state.approvedQueueKey === queueApprovalKey();
  }
  function approvedFor(item) {
    return !!item && batchApprovalActive() && currentItem()?.id === item.id;
  }
  function pageNumber() {
    const direct = Number(text(document.querySelector('.finder-ui-desktop-pagination__num_current')));
    if (Number.isInteger(direct) && direct > 0) return direct;
    const pager = document.querySelector('.finder-ui-desktop-pagination');
    if (pager) {
      const active = Array.from(pager.querySelectorAll(
        '[aria-current="page"], [class*="current"], [class*="active"]'
      ));
      for (const el of active) {
        const match = text(el).match(/^(\d+)(?:\s*\/\s*\d+)?$/);
        if (match && Number(match[1]) > 0) return Number(match[1]);
      }
      const input = pager.querySelector('input.finder-ui-desktop-pagination__input');
      const inputPage = Number(input?.value);
      if (Number.isInteger(inputPage) && inputPage > 0) return inputPage;
    }
    // 当天结果只有一页时，平台可能不渲染页码组件；有订单行即视为第 1 页。
    return standardOrderRowCount() > 0 ? 1 : 0;
  }
  function maxPage() { const nums = Array.from(document.querySelectorAll('.finder-ui-desktop-pagination__num')).map(x => Number(text(x))).filter(Number.isInteger); return Math.max(1, ...nums); }

  function readRows() {
    if (!onList()) throw new Error('请打开标准订单列表');
    const page = pageNumber();
    const headersByTable = new Map();
    return Array.from(document.querySelectorAll('tr')).filter(visible).map(row => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      if (cells.length < 4) return null;
      const first = text(cells[0]);
      const id = (first.match(/\b\d{10,}_\d+\b/) || [])[0];
      if (!id) return null;
      const name = text(cells[0].querySelector('.text-sm.font-medium.text-fg-0')) || first.split('短视频加热')[0].trim();
      const progress = text(cells[1]).normalize('NFKC').match(/^¥\s*([\d,.]+)\s*\/\s*¥\s*([\d,.]+)$/);
      const table = row.closest('table');
      if (!headersByTable.has(table)) {
        const headerRows = Array.from(table?.tHead?.rows || []);
        headersByTable.set(table, headerRows.filter(visible).map(header => Array.from(header.cells)));
      }
      const header = headersByTable.get(table).find(columns => columns.length === cells.length &&
        columns.every(cell => cell.colSpan === 1) &&
        ['订单信息', '投放进度', '订单状态'].every((label, index) => text(columns[index]) === label));
      const roiIndexes = (header || []).flatMap((cell, index) =>
        text(cell).replace(/\s/g, '') === '直接成交ROI' ? [index] : []);
      const hasRoiColumn = roiIndexes.length === 1;
      return { id, name, spent:parseRoi(progress?.[1]), budget:parseRoi(progress?.[2]) ?? NaN,
        status: text(cells[2]), roi: hasRoiColumn ? parseRoi(text(cells[roiIndexes[0]])) : null,
        hasRoiColumn, page, row };
    }).filter(Boolean);
  }
  async function waitUntil(check, label, ms = 18000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(label + '等待超时');
  }
  function setNativeInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles:true }));
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }
  async function gotoPage(target) {
    if (!onList()) throw new Error('不在标准订单列表');
    if (pageNumber() === target) return;
    const pager = one(document.querySelectorAll('.finder-ui-desktop-pagination'), '订单分页栏');
    const input = one(pager.querySelectorAll('input.finder-ui-desktop-pagination__input'), '页码输入框');
    const jump = one(Array.from(pager.querySelectorAll('a')).filter(a => text(a) === '跳转'), '跳转按钮');
    const previousId = readRows()[0]?.id || '';
    setNativeInput(input, target);
    jump.click();
    await waitUntil(() => onList() && pageNumber() === target && readRows().length > 0 &&
      readRows()[0].id !== previousId, '订单第 ' + target + ' 页', 20000);
  }
  async function stableOrderPage(page) {
    let signature = '', stableSince = 0;
    return waitUntil(() => {
      if (!onList() || pageNumber() !== page) return null;
      const rows = readRows();
      if (!rows.length || rows.some(x => !x.name || !Number.isFinite(x.budget) || x.budget <= 0)) {
        signature = ''; stableSince = 0; return null;
      }
      const next = JSON.stringify(rows.map(x => [x.id, x.name, x.budget, isFullySpent(x), x.status, x.roi, x.hasRoiColumn]));
      if (next !== signature) { signature = next; stableSince = Date.now(); return null; }
      return Date.now() - stableSince >= 300 ? rows : null;
    }, '第 ' + page + ' 页订单预算完整加载', 15000);
  }
  function rememberSourcePages(rows, page) {
    const ids = new Set(rows.map(row => row.id));
    let changed = false;
    // Page numbers are location hints, not approved names, budgets or source identities.
    for (const item of [...state.queue, ...state.matches]) {
      if (ids.has(item.id) && item.page !== page) { item.page = page; changed = true; }
    }
    if (changed) save();
  }
  async function sourceOnPage(item, page) {
    if (scanCancel) throw new Error('已停止定位来源订单');
    ensureAccount();
    await gotoPage(page);
    const rows = await stableOrderPage(page);
    ensureAccount();
    rememberSourcePages(rows, page);
    const hit = rows.find(row => row.id === item.id);
    if (!hit) return null;
    if (hit.name === item.name && hit.budget === item.budget) return hit;
    // Keep the existing grace period for payment-return rows whose text updates late.
    let matchingSince = 0;
    const row = await waitUntil(() => {
      ensureAccount();
      if (!onList() || pageNumber() !== page) return null;
      const fresh = readRows().find(x => x.id === item.id);
      if (!fresh || fresh.name !== item.name || fresh.budget !== item.budget) {
        matchingSince = 0; return null;
      }
      if (!matchingSince) matchingSince = Date.now();
      return Date.now() - matchingSince >= 300 ? fresh : null;
    }, '来源订单数据稳定', 15000).catch(error => {
      if (!/来源订单数据稳定等待超时/.test(error.message)) throw error;
      return null;
    });
    if (row) return row;
    throw new Error('来源订单信息与锁定记录不符或尚未稳定：' + item.id + '；未按同名订单替代');
  }
  async function locateSourceOrder(item) {
    const visited = new Set();
    const visit = async page => {
      if (visited.has(page) || page < 1 || page > Math.min(200, maxPage())) return null;
      visited.add(page);
      return sourceOnPage(item, page);
    };
    // If the platform already returned to the right page, avoid even a page jump.
    let row = null;
    if (readRows().some(x => x.id === item.id)) row = await visit(pageNumber());
    const hint = Number.isInteger(item.page) && item.page > 0 ? item.page : state.lastSourcePage || 1;
    const start = Math.max(1, Math.min(hint, 200, maxPage()));
    if (!row) {
      log('优先从第 ' + start + ' 页定位来源 ' + item.id + '；未找到时继续向后查找');
      for (let page = start; page <= Math.min(200, maxPage()); page++) {
        row = await visit(page);
        if (row) break;
      }
    }
    if (!row && start > 1) {
      log('记录页及后续页未找到来源 ID，回查第 1～' + (start - 1) + ' 页');
      for (let page = 1; page < start; page++) {
        row = await visit(page);
        if (row) break;
      }
    }
    if (row) {
      item.page = row.page;
      state.lastSourcePage = row.page;
      save();
      log('已在第 ' + row.page + ' 页定位来源 ' + item.id + '，已更新同页其他订单的页码');
    }
    return row;
  }
  async function scanPages(names, collect, roiMinimum = null, orderDay = '') {
    await waitUntil(() => onList() && readRows().length > 0, '标准订单表加载', 20000).catch(error => {
      throw new Error(error.message + '（' + listDiagnostics() + '）');
    });
    const firstOrderSeen = new Set(collect.keys());
    for (let page = 1; page <= maxPage(); page++) {
      if (page > 200) throw new Error('前 200 页仍未找齐订单，请先用平台筛选缩小范围');
      if (scanCancel) throw new Error('已停止扫描');
      ensureAccount();
      await gotoPage(page);
      const rows = await stableOrderPage(page);
      if (scanCancel) throw new Error('已停止扫描');
      if (orderDay && orderDay !== todayInShanghai()) throw new Error('扫描已跨天，请重新扫描当天订单');
      ensureAccount();
      if (roiMinimum !== null && !rows.some(row => row.hasRoiColumn))
        throw new Error('未识别到“直接成交ROI”列，请在平台展示项中开启后重新扫描');
      for (const row of rows) {
        if (!names.includes(row.name) || firstOrderSeen.has(row.name)) continue;
        firstOrderSeen.add(row.name);
        if (roiMinimum === null || matchesRoiFilter(row, roiMinimum)) {
          collect.set(row.name, {
            id: row.id, name: row.name, spent: row.spent, budget: row.budget, status: row.status, roi: row.roi, roiMinimum, orderDay, page
          });
        }
      }
      state.pageCount = page;
      if (collect.size === names.length) { save(); return null; }
      if (page === 1 || page % 5 === 0) { save(); }
      if (page >= maxPage()) break;
    }
    return null;
  }
  async function scan() {
    if (busy) return;
    busy = true; scanCancel = false;
    try {
      if (!tabId) throw new Error('无法保存当前标签页身份');
      try { await waitUntil(onList, '标准订单页面加载', 8000); }
      catch (_) {
        const u = new URL(location.href);
        throw new Error('未识别到标准订单表；当前路径 ' + u.pathname + '，tab=' + (u.searchParams.get('tab') || '无'));
      }
      if (!['idle','ready','complete'].includes(state.stage)) throw new Error('当前有未完成的逐单流程');
      nameLibraryOpen = false;
      const input = shadow.getElementById('names');
      const names = parseNames(input.value);
      if (!names.length) throw new Error('请先输入要查找的完整订单名称');
      const minimumText = clean(shadow.getElementById('roiMinimum').value);
      const minimum = parseRoi(minimumText);
      if (minimumText && minimum === null) throw new Error('最低 ROI 请输入 0 或正数');
      state.names = names.join('\n');
      namesDraft = state.names; state.namesDraft = namesDraft;
      state.roiMinimum = minimumText;
      state.account = accountName();
      if (!state.account) throw new Error('无法确认当前视频号账户');
      state.matches = []; state.choices = {}; state.edits = {}; state.scanComplete = false; state.pageCount = 0; state.lastSourcePage = 0;
      state.stage = 'scanning'; save();
      const found = new Map();
      const day = minimum === null ? '' : todayInShanghai();
      appliedOrderDate = null;
      if (!day || await applyTodayOrderFilter(day) !== 0) await scanPages(names, found, minimum, day);
      if (scanCancel) throw new Error('已停止扫描');
      state.matches = Array.from(found.values());
      state.choices = Object.fromEntries(state.matches.map(x => [x.name, x.id]));
      state.scanComplete = true;
      state.stage = 'ready'; state.settingsExpanded = true;
      log('扫描完成：' + state.pageCount + ' 页；找到 ' + state.matches.length + '/' + names.length +
        ' 个名称' + (day ? '符合当天创建、消耗完成且直接成交 ROI ≥ ' + minimum + '（' + day + '）' : ''));
    } catch (error) {
      state.stage = 'idle'; state.scanComplete = false;
      log('扫描中止：' + error.message);
    } finally { busy = false; render(); }
  }

  async function startQueue() {
    if (busy) return;
    busy = true;
    try {
      if (state.stage !== 'ready' || !state.scanComplete) throw new Error('请先完成列表扫描');
      nameLibraryOpen = false;
      ensureAccount();
      if (parseNames(shadow.getElementById('names').value).join('\n') !== state.names ||
          clean(shadow.getElementById('roiMinimum').value) !== state.roiMinimum)
        throw new Error('名称或最低 ROI 已修改，请重新扫描');
      const names = selectedNames(), queue = [];
      if (!names.length) throw new Error('没有符合条件的订单');
      let repairedBudget = false;
      for (const name of names) {
        const id = state.choices[name];
        const item = state.matches.find(x => x.name === name && x.id === id);
        if (!item) throw new Error('请为“' + name + '”明确选择一条来源订单');
        if (!Number.isFinite(item.budget) || item.budget <= 0) {
          await gotoPage(item.page);
          const fresh = await waitUntil(() => {
            const row = readRows().find(x => x.id === item.id && x.name === item.name);
            return row && Number.isFinite(row.budget) && row.budget > 0 ? row : null;
          }, '“' + name + '”的预算重新核对', 15000);
          item.budget = fresh.budget;
          repairedBudget = true;
          log('已重新读到“' + name + '”原预算 ¥' + item.budget);
        }
        const draft = orderDraft(item);
        let target;
        try { target = validateTarget(draft.name, draft.budget); }
        catch (error) { throw new Error('“' + name + '”：' + error.message); }
        queue.push({ ...item, ...target, result:'pending' });
      }
      if (new Set(queue.map(x => x.id)).size !== queue.length) throw new Error('来源订单重复');
      if (repairedBudget) {
        log('候选预算已补全；请核对更新后的整批金额，再点击开始');
        return;
      }
      state.queue = queue; state.index = 0; state.stage = 'locating'; state.settingsExpanded = false;
      state.detailUrl = ''; state.reviewUrl = ''; state.reviewAmount = null;
      state.approvedQueueKey = queueApprovalKey(); state.currentError = '';
      log('已核对并授权本轮 ' + queue.length + ' 单自动提交及免验证支付；追投预算合计 ¥' + queue.reduce((sum,x)=>sum+targetBudget(x),0).toFixed(2));
      for (const item of queue) log('锁定来源 ' + item.id + '：“' + item.name + '”/¥' + item.budget +
        ' → 新单“' + targetName(item) + '”/¥' + targetBudget(item));
    } catch (error) { log('无法开始：' + error.message); }
    finally { busy = false; render(); }
    if (state.stage === 'locating') tick();
  }

  async function locateAndOpen() {
    const item = currentItem();
    if (!item) { state.stage = 'complete'; log('全部来源订单已处理'); return; }
    if (!onList()) throw new Error('请返回订单管理 → 标准订单');
    ensureAccount();
    scanCancel = false;
    if (item.orderDay && await applyTodayOrderFilter(item.orderDay) === 0)
      throw new Error('当天筛选结果已没有订单，请重新核对本轮来源');
    await waitUntil(() => onList() && pageNumber() > 0 && readRows().length > 0,
      '标准订单列表重新加载', 20000);
    const row = await locateSourceOrder(item);
    if (!row) throw new Error('找不到来源订单 ' + item.id + '，未按同名订单替代');
    if (row.name !== item.name || row.budget !== item.budget)
      throw new Error('来源订单信息与锁定记录不符：页面“' + row.name + '”/¥' +
        row.budget + '，锁定“' + item.name + '”/¥' + item.budget);
    if (Number.isFinite(item.roiMinimum) && !matchesRoiFilter(row, item.roiMinimum))
      throw new Error('来源订单 ' + item.id + ' 当前投放进度 ¥' + (row.spent ?? '未读到') + '/¥' + row.budget + '、直接成交 ROI ' +
        (row.roi ?? '未读到') + '，未通过消耗完成且 ROI ≥ ' + item.roiMinimum + ' 的复核');
    if (!approvedFor(item)) {
      state.stage = 'awaiting_consent'; save();
      return;
    }
    const more = one(Array.from(row.row.querySelectorAll('a')).filter(a => text(a) === '更多'), '来源订单“更多”');
    const wrapper = more.closest('.finder-ui-desktop-popover__wrp');
    if (!wrapper) throw new Error('来源订单“更多”菜单结构已改变');
    if (typeof PointerEvent === 'function') {
      wrapper.dispatchEvent(new PointerEvent('pointerenter', { bubbles:true }));
      wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles:true }));
    }
    wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles:true }));
    wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles:true }));
    more.dispatchEvent(new MouseEvent('mouseenter', { bubbles:true }));
    more.dispatchEvent(new MouseEvent('mouseover', { bubbles:true }));
    const findAction = () => {
      const fresh = readRows().find(x => x.id === item.id);
      if (!fresh || fresh.name !== item.name || fresh.budget !== item.budget) return null;
      const freshMore = Array.from(fresh.row.querySelectorAll('a')).find(a => text(a) === '更多');
      if (!freshMore) return null;
      const anchor = freshMore.getBoundingClientRect();
      const cx = (anchor.left + anchor.right) / 2;
      const cy = (anchor.top + anchor.bottom) / 2;
      // 平台将弹层挂在 body 下，不在订单行或“更多”的 wrapper 内。
      const options = Array.from(document.querySelectorAll('.finder-ui-desktop-popover__desc *'))
        .filter(x => visible(x) && x.children.length === 0 && text(x) === '再来一单')
        .filter(x => {
          const r = x.getBoundingClientRect();
          return Math.abs((r.left + r.right) / 2 - cx) < 150 &&
            Math.abs((r.top + r.bottom) / 2 - cy) < 220;
        });
      return options.length === 1 ? options[0] : null;
    };
    let action = await waitUntil(findAction, '“再来一单”悬浮菜单', 1500).catch(() => null);
    if (!action) {
      more.click();
      action = await waitUntil(findAction, '“再来一单”菜单', 8000);
    }
    state.stage = 'opening'; state.openingAt = Date.now(); save();
    action.click();
    await waitUntil(() => !onList(), '再来一单页面', 16000);
    log('已从来源订单 ' + item.id + ' 打开“再来一单”');
  }

  function approveCurrent() {
    if (busy || state.stage !== 'awaiting_consent' || !onList()) return;
    try {
      ensureAccount();
      const item = currentItem();
      const row = readRows().find(x => x.id === item?.id);
      if (!row || row.name !== item.name || row.budget !== item.budget)
        throw new Error('当前列表无法核对本单来源、名称和预算，请重新定位');
      state.approvedQueueKey = queueApprovalKey();
      state.stage = 'locating';
      log('已核对并授权本轮剩余订单自动提交及免验证支付；当前新单 ' + targetName(item) + '，预算 ¥' + targetBudget(item));
      tick();
    } catch (error) { fail(error.message); }
  }

  function reviewInfo() {
    const u = new URL(location.href);
    if (u.pathname !== '/promote/pages/platform/create-order' ||
        u.searchParams.get('orderType') !== 'standard') return null;
    const names = Array.from(document.querySelectorAll('input[placeholder="输入订单名称"]')).filter(visible);
    const card = reviewPaymentCard();
    if (names.length !== 1 || !card) return null;
    const rowFor = label => {
      const el = Array.from(card.querySelectorAll('span')).find(x => text(x) === label);
      return el ? text(el.parentElement?.parentElement) : '';
    };
    const moneyFor = label => {
      const rowText = rowFor(label);
      const match = rowText.match(/[￥¥]\s*([\d,.]+)/);
      return match ? Number(match[1].replace(/,/g, '')) : NaN;
    };
    const couponRow = rowFor('优惠券') || rowFor('优惠券抵扣') || rowFor('优惠抵扣');
    // 读取实际抵扣金额，而非优惠券面额；例如“65.49元优惠券，抵扣 -¥65.49”。
    const couponMatch = couponRow.match(/[-−－]\s*[￥¥]\s*([\d,.]+)/) ||
      couponRow.match(/抵扣\s*[:：]?\s*[￥¥]\s*([\d,.]+)/);
    return { name: names[0].value.trim(), budget: moneyFor('订单预算'),
      amount: moneyFor('需支付'), couponPresent: !!couponRow,
      couponAmount: couponMatch ? Number(couponMatch[1].replace(/,/g, '')) : NaN,
      sourceId: u.searchParams.get('sourcePromotionId') || '' };
  }
  function reviewPaymentCard() {
    const cards = Array.from(document.querySelectorAll('.finder-card')).filter(card =>
      visible(card) && text(card).includes('需支付') &&
      text(card).includes('微信视频号企业账号加热功能服务协议'));
    return cards.length === 1 ? cards[0] : null;
  }
  function orderSubmitControl() {
    const card = reviewPaymentCard();
    if (!card) return null;
    const buttons = Array.from(card.querySelectorAll('button')).filter(button =>
      visible(button) && ['提交', '免验证提交'].includes(text(button)));
    if (buttons.length > 1) throw new Error('结算卡片出现多个提交按钮，请人工核对');
    return buttons.length === 1 ? {button:buttons[0], label:text(buttons[0])} : null;
  }
  function submitControlReady(control) {
    const button = control?.button;
    return !!button && button.isConnected && visible(button) && !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' &&
      !button.classList.contains('finder-ui-desktop-btn_disabled');
  }
  function reviewMoneyCents(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) return NaN;
    return Math.round(value * 100);
  }
  function verifyReviewAmounts(info, item) {
    const target = reviewMoneyCents(targetBudget(item)), budget = reviewMoneyCents(info.budget), amount = reviewMoneyCents(info.amount);
    if (!Number.isFinite(target) || target <= 0 || budget !== target) throw new Error('新单预算与本轮锁定的追投预算不一致');
    if (!Number.isFinite(amount) || amount > budget) throw new Error('需支付金额无效或超过订单预算');
    const discount = budget - amount;
    if (discount > 0 && (!info.couponPresent || reviewMoneyCents(info.couponAmount) !== discount)) {
      throw new Error('需支付金额低于订单预算，但优惠券实际抵扣金额尚未核对一致，请等待页面加载或人工核对');
    }
    if (discount === 0 && info.couponPresent && Number.isFinite(info.couponAmount) && reviewMoneyCents(info.couponAmount) !== 0) {
      throw new Error('优惠券抵扣与需支付金额尚未同步，请等待页面加载后核对');
    }
    return discount / 100;
  }
  function fillPlatformInput(input, value) {
    if (!visible(input)) throw new Error('新单编辑输入框尚未显示');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    input.blur();
  }
  function guardNewForm(item, info) {
    ensureAccount();
    if (!info || info.sourceId !== item.id) throw new Error('新单来源订单 ID 与锁定订单不一致');
    if (![item.name,targetName(item)].includes(info.name)) throw new Error('新单名称既不是来源名称也不是本轮目标名称，请人工核对');
    if (![item.budget,targetBudget(item)].includes(info.budget)) throw new Error('新单预算既不是来源预算也不是本轮目标预算，请人工核对');
    if (item.submittedAt) throw new Error('本单已经发起过提交，禁止再次填写或提交');
  }
  async function prepareNewForm() {
    const item=currentItem();
    if(!item)throw new Error('没有当前订单');
    const target=validateTarget(targetName(item),targetBudget(item));
    const info=await waitUntil(()=>{const result=reviewInfo();return result&&Number.isFinite(result.budget)?result:null;},'新单来源及预算加载',15000);
    guardNewForm(item,info);
    const name=one(document.querySelectorAll('input[placeholder="输入订单名称"]'),'新订单名称输入框');
    if(name.value.trim()!==target.targetName)fillPlatformInput(name,target.targetName);
    if(info.budget!==target.targetBudget){
      const custom=one(document.querySelectorAll('form .promote-price-custom'),'自定义订单预算控件');
      const label=one(custom.querySelectorAll('label'),'自定义订单预算选项');
      label.click();
      const input=await waitUntil(()=>Array.from(custom.querySelectorAll('input[type="text"]')).find(visible),'自定义订单预算输入框',6000);
      fillPlatformInput(input,target.targetBudget);
      const done=one(Array.from(custom.querySelectorAll('button')).filter(x=>text(x)==='完成'),'应用自定义订单预算');
      await waitUntil(()=>visible(done)&&!done.disabled&&!done.classList.contains('finder-ui-desktop-btn_disabled'),'预算完成按钮启用',5000);
      done.click();
    }
    await waitUntil(()=>{
      const current=reviewInfo();
      if(!current||current.name!==target.targetName||current.budget!==target.targetBudget)return false;
      try{verifyReviewAmounts(current,item);return current;}catch(_){return false;}
    },'新名称、追投预算及优惠券金额同步',15000);
    log('已填写新单“'+target.targetName+'”，追投预算 ¥'+target.targetBudget+'（来源原预算 ¥'+item.budget+'）');
  }
  function verifyReview() {
    const item = currentItem(), info = reviewInfo();
    if (!item || !info) throw new Error('尚未读到待提交的新订单页面');
    ensureAccount();
    if (info.sourceId !== item.id) throw new Error('新单来源订单 ID 与锁定订单不一致');
    if (info.name !== targetName(item)) throw new Error('新单名称与本轮锁定的新名称不一致：' + (info.name || '未读到'));
    const discount = verifyReviewAmounts(info, item);
    state.reviewAmount = info.amount;
    state.reviewUrl = location.href;
    state.stage = 'review';
    log('已核对新单：' + targetName(item) + '；来源 ' + item.id + '；订单预算 ¥' + info.budget.toFixed(2) +
      '；优惠券抵扣 ¥' + discount.toFixed(2) + '；需支付 ¥' + info.amount.toFixed(2));
  }
  function agreementBox() {
    const label = Array.from(document.querySelectorAll('label,div,span,p')).filter(el =>
      visible(el) && text(el).includes('我已阅读并同意') && text(el).includes('微信视频号企业账号加热功能服务协议'))
      .sort((a,b) => a.textContent.length - b.textContent.length)[0];
    if (!label) throw new Error('未找到加热功能服务协议');
    let node = label;
    for (let i=0; i<5 && node; i++, node=node.parentElement) {
      const boxes = Array.from(node.querySelectorAll('input[type="checkbox"]')).filter(x => x.isConnected);
      if (boxes.length === 1) return { checkbox:boxes[0], label };
    }
    throw new Error('未找到协议勾选框，请手动勾选后再试');
  }
  async function submitReviewedOrder(singleOrderConsent = false) {
    if (currentItem()?.submittedAt) throw new Error('本单已点击过提交，请核对支付结果，禁止重复提交');
    if (!singleOrderConsent && !approvedFor(currentItem())) throw new Error('本轮提交及免验证支付尚未授权，请重新核对后确认');
    await prepareNewForm();
    verifyReview();
    const { checkbox, label } = agreementBox();
    if (!checkbox.checked) {
      const clicker = label.closest('label') || checkbox;
      clicker.click();
    }
    await waitUntil(() => checkbox.isConnected && checkbox.checked,
      '协议勾选生效', 5000);
    await waitUntil(() => submitControlReady(orderSubmitControl()), '平台提交或免验证提交按钮启用', 5000);
    // 勾选协议期间优惠券可能刷新，点击提交前再次核对预算与实际抵扣。
    verifyReview();
    if (!agreementBox().checkbox.checked) throw new Error('提交前协议勾选状态已变化，未提交');
    const submit = orderSubmitControl();
    if (!submitControlReady(submit)) throw new Error('平台提交按钮状态已变化，未提交');
    if (!singleOrderConsent && !approvedFor(currentItem())) throw new Error('本轮授权已变化，未提交');
    const item = currentItem();
    if (item.submittedAt) throw new Error('本单已经发起过提交，禁止重复提交');
    item.submittedAt = Date.now();
    item.submitLabel = submit.label;
    state.stage = 'await_result'; save();
    submit.button.click();
    log('已点击“' + submit.label + '”：' + targetName(item) + '；追投预算 ¥' + targetBudget(item) +
      (submit.label === '免验证提交' ? '；等待平台直接支付结果，核对成功后继续下一单' : '；等待平台支付结果，出现二维码时请扫码完成'));
    // 两种入口都核对实际结果；若出现扫码页则等待人工支付，不因免验证按钮存在而提前记为成功。
  }
  async function confirmAndSubmit() {
    if (busy || state.stage !== 'review') return;
    busy = true;
    try { await submitReviewedOrder(true); }
    catch (error) { fail('提交结果需要核对：' + error.message + '；不会自动再次提交'); }
    finally { busy = false; render(); }
  }
  function paymentPrompt() {
    return Array.from(document.querySelectorAll('div,[role="dialog"]')).some(x =>
      visible(x) && x.children.length < 15 && /使用手机微信扫码确认兑换|(?:微信|手机).*扫码.*(?:支付|付款)|(?:使用|请用|请使用)微信.*(?:支付|付款)/.test(text(x)));
  }
  function paidDetail() {
    if (onList() || paymentPrompt()) return false;
    if (!state.reviewUrl || location.href === state.reviewUrl) return false;
    const body = document.body.innerText || '';
    const item = currentItem();
    if (!item || !body.includes('加热详情') || !/(订单审核中|加热中|审核通过|投放中)/.test(body)) return false;
    const spends = Array.from(body.matchAll(/订单消耗\s*[￥¥]?\s*([\d,.]+)\s*\/\s*[￥¥]?\s*([\d,.]+)/g));
    return spends.some(match => Number(match[2].replace(/,/g, '')) === targetBudget(item));
  }
  async function returnToList() {
    if (!paidDetail()) throw new Error('未能确认支付后新订单的加热详情与预算');
    ensureAccount();
    state.detailUrl = location.href;
    const links = Array.from(document.querySelectorAll('a')).filter(x => visible(x) && text(x) === '订单管理');
    const breadcrumb = links.find(x => x.parentElement && text(x.parentElement).includes('加热详情')) || links[links.length - 1];
    state.stage = 'returning'; state.returningAt = Date.now(); save();
    if (breadcrumb) breadcrumb.click();
    else location.assign('/promote/pages/platform/order-list?tab=standard');
    await waitUntil(() => onList(), '返回标准订单列表', 20000);
    finishCurrent('paid', state.detailUrl);
  }
  function finishCurrent(result, detailUrl = '', newOrderId = '') {
    const item = currentItem();
    if (!item || item.result !== 'pending') throw new Error('当前队列项不是待处理订单');
    item.result = result; item.detailUrl = detailUrl;
    if (newOrderId) item.newOrderId = newOrderId;
    state.index++;
    state.detailUrl = ''; state.reviewUrl = ''; state.reviewAmount = null;
    state.stage = state.index >= state.queue.length ? 'complete' : 'locating';
    if (state.stage === 'complete') state.approvedQueueKey = '';
    log((result === 'paid_manual' ? '已人工确认付款：' : '已核对并完成：') + targetName(item) + '（来源 ' + item.id + '）');
    if (state.stage !== 'complete' && batchApprovalActive()) log('整批授权继续有效，下一单无需再次确认');
    save();
  }
  async function tick() {
    if (busy || !tabId) return;
    if (!['locating','opening','review','await_result','await_payment','verifying_payment','returning'].includes(state.stage)) return;
    busy = true;
    try {
      if (state.stage === 'locating') await locateAndOpen();
      if (state.stage === 'opening') {
        const info = reviewInfo();
        if (info) { await prepareNewForm(); verifyReview(); }
        else if (onList()) throw new Error('仍在标准订单列表，“再来一单”页面未打开');
        else if (state.openingAt && Date.now() - state.openingAt > 30000) {
          throw new Error('新订单表单等待超时，请核对订单名称、预算和页面状态');
        }
      }
      if (state.stage === 'review' && approvedFor(currentItem())) {
        try { await submitReviewedOrder(); }
        catch (error) { fail('提交结果需要核对：' + error.message + '；不会自动再次提交'); }
      }
      if (['await_result','await_payment'].includes(state.stage)) {
        if (paidDetail()) { state.stage = 'verifying_payment'; save(); }
        else if (paymentPrompt() && state.stage !== 'await_payment') {
          state.stage = 'await_payment'; save();
        } else if (!currentItem().waitNotified && Date.now() - currentItem().submittedAt > 120000) {
          currentItem().waitNotified = true;
          log('支付结果尚未识别，继续等待；若已付款，请返回标准订单列表后使用“已人工核实付款，完成本单”，不要重复提交');
        }
      }
      if (state.stage === 'verifying_payment') await returnToList();
      if (state.stage === 'returning' && onList()) {
        // 仅在点击返回后中断的情况下恢复；不能把未核对的提交算作完成。
        const item = currentItem();
        if (item && state.detailUrl) {
          finishCurrent('paid', state.detailUrl);
        }
      } else if (state.stage === 'returning' && Date.now() - state.returningAt > 25000) {
        throw new Error('返回标准订单列表未完成，请检查当前页面');
      }
    } catch (error) { fail(error.message); }
    finally { busy = false; render(); }
  }

  function pause() {
    if (state.stage === 'scanning') { scanCancel = true; return; }
    if (busy) { log('当前操作尚未结束，请稍后暂停'); return; }
    if (['locating','awaiting_consent','opening','review','await_result','await_payment'].includes(state.stage)) {
      state.pausedFrom = state.stage;
      state.stage = 'paused';
      log('用户暂停；不会继续打开新订单');
    }
  }
  function resume() {
    if (busy || state.stage !== 'paused') return;
    restoreCurrentOrder();
  }
  function recover() {
    if (busy || state.stage !== 'needs_review') return;
    restoreCurrentOrder();
  }
  function restoreCurrentOrder() {
    try {
      const item = currentItem();
      if (!item || item.result !== 'pending') throw new Error('没有可继续的待处理订单，请核对队列');
      const submitted = item.submittedAt ||
        ['submitting','await_result','await_payment','verifying_payment','returning'].includes(state.pausedFrom) ||
        /提交结果需要核对|提交后页面曾刷新/.test(state.currentError);
      if (submitted && !item.submittedAt) item.submittedAt = Date.now();
      ensureAccount();
      let nextStage;
      if (submitted) {
        // 已提交或结果不明时仅核对支付，不允许回到定位来源或再次提交。
        if (paymentPrompt()) nextStage = 'await_payment';
        else if (paidDetail()) nextStage = 'verifying_payment';
        else nextStage = 'await_result';
      } else if (paymentPrompt()) {
        throw new Error('当前显示扫码支付，但本单没有提交记录，请先人工核对付款订单');
      } else {
        const info = reviewInfo();
        if (info) {
          guardNewForm(item, info);
          nextStage = 'review';
        } else if (onList()) {
          // 翻页、加载和来源定位超时均可恢复；定位流程仍会重新核对 ID、名称和预算。
          nextStage = 'locating';
        } else {
          throw new Error('本单尚未提交，请返回订单管理 → 标准订单，再点击继续');
        }
      }
      state.stage = nextStage;
      state.currentError = ''; state.pausedFrom = '';
      log(nextStage === 'locating' ? '继续本轮：重新定位当前来源订单 ' + item.id + '，保留已完成进度' :
        nextStage === 'review' ? '继续本轮：重新核对当前新订单' : '继续本轮：仅核对已发起订单的支付结果，不重复提交');
      tick();
    } catch (error) { fail('无法继续：' + error.message); }
  }
  function manualPaid() {
    if (busy || !currentItem()?.submittedAt ||
        !['await_result','await_payment','needs_review','paused'].includes(state.stage)) return;
    try {
      if (!onList()) throw new Error('请先在平台核实新订单已付款，再返回标准订单列表使用此按钮');
      ensureAccount();
      const item = currentItem();
      const entered = window.prompt('请从平台已付款的新订单复制订单编号。注意：不是来源订单 ' + item.id + '。');
      if (entered === null) return;
      const id = clean(entered);
      if (!/^\d{10,}_\d+$/.test(id) || state.queue.some(x => x.id === id || x.newOrderId === id))
        throw new Error('请输入有效且未处理过的新订单编号，不能填写来源订单编号');
      if (!window.confirm('请确认已在平台核对：\n新订单：' + id + '\n名称：' + targetName(item) +
          '\n订单预算：¥' + targetBudget(item) + '\n本单已支付成功。\n确认后将记录为人工核实完成，并继续剩余队列。')) return;
      state.currentError = ''; state.pausedFrom = '';
      finishCurrent('paid_manual', '', id);
      tick();
    } catch (error) { log('无法人工确认：' + error.message); }
  }
  function reset() {
    if (busy || ['submitting','await_result','await_payment','verifying_payment','returning'].includes(state.stage)) {
      log('存在待核实的提交或支付，不能清空队列'); return;
    }
    if (state.stage === 'needs_review' && !window.confirm('当前订单结果不明。请先在平台人工核对，确认不会重复下单后再清空队列。是否继续？')) return;
    state.queue = []; state.index = 0; state.stage = 'idle'; state.matches = [];
    state.choices = {}; state.edits = {}; state.scanComplete = false; state.currentError = '';
    state.approvedQueueKey = '';
    log('已清空队列；可重新扫描');
  }

  function render() {
    const oldScroll = shadow.querySelector('.body')?.scrollTop || 0;
    const wasEditing = shadow.querySelector('.panel')?.classList.contains('editing');
    const names = parseNames(state.names), item = currentItem();
    const expanded = state.settingsExpanded !== false;
    const editing = state.stage === 'ready' && expanded;
    const filtering = state.roiMinimum !== '';
    const canScan = ['idle', 'ready', 'complete'].includes(state.stage);
    const namesEditable = canEditNames();
    const libraryCount = libraryNames().length;
    const nameLibraryEditor = nameLibraryOpen ? `<div class="group" style="margin-top:10px;border:1px solid #e1e8f1;border-radius:9px"><div class="title">管理名称库 · 已保存 ${libraryCount} 个</div><div class="muted">每行一个名称，可直接新增、删除或改名；点击保存后生效。保存后可从名称库恢复到当前清单。</div><textarea id="nameLibraryDraft" aria-label="名称库" style="min-height:180px" ${namesEditable?'':'disabled'}>${esc(nameLibraryDraft ?? '')}</textarea><div class="row"><button class="btn primary" id="saveNameLibrary" ${namesEditable?'':'disabled'}>保存名称库</button><button class="btn" id="addBuiltinNames" ${namesEditable?'':'disabled'}>补回内置名称</button></div><div class="muted">“补回内置名称”会把最初内置的名称补入编辑框，点击保存后生效。名称库保存在当前浏览器中。</div></div>` : '';
    const selectedCount = selectedNames().length;
    const selected = names.map(name => {
      const candidates = state.matches.filter(x => x.name === name);
      const chosen=candidates.find(x=>x.id===state.choices[name]);
      const draft=chosen?orderDraft(chosen):null,editable=state.stage==='ready'&&!busy;
      const editor=draft?`<div style="padding:7px 0"><label>新订单名称<input data-edit-id="${esc(chosen.id)}" data-edit-field="name" maxlength="25" value="${esc(draft.name)}" ${editable?'':'disabled'}></label><label>追投预算（元）<input type="number" inputmode="numeric" min="100" max="300000" step="100" data-edit-id="${esc(chosen.id)}" data-edit-field="budget" value="${esc(draft.budget)}" ${editable?'':'disabled'}></label><div class="muted">100～300000 元，且为 100 的整数倍；优惠券抵扣另行计算。</div><button class="btn small" data-default-id="${esc(chosen.id)}" ${editable?'':'disabled'}>恢复原名称与预算</button></div>`:'';
      return `<div class="group"><b>${esc(name)}</b> <span class="muted">${candidates.length} 条</span>${candidates.length ? candidates.map(x =>
        `<label class="candidate"><input type="radio" name="choice-${esc(name)}" data-name="${esc(name)}" value="${esc(x.id)}" ${state.choices[name] === x.id ? 'checked' : ''} ${editable?'':'disabled'}><span><b>${esc(x.id)}</b><br>${esc(x.status)}${x.spent != null ? ` · 投放进度 ¥${esc(x.spent)}/¥${esc(x.budget)}` : ''}${x.roi != null ? ` · 直接成交 ROI ${esc(x.roi)}` : ''} · 原预算 ¥${esc(x.budget)} · 第 ${x.page} 页</span></label>`).join('') : `<div class="muted">${filtering ? '今天没有投放进度达到预算且直接成交 ROI 达标的同名订单。' : '未找到，请核对名称或平台筛选条件。'}</div>`}${editor}</div>`;
    }).join('');
    const totalBudget = selectedDraftTotal();
    const queue = state.queue.map((x,i) => `<div class="queueItem ${i === state.index ? 'current' : ''}">${i+1}. ${esc(targetName(x))} · 追投 ¥${esc(targetBudget(x))}<br><span class="muted">来源：${esc(x.name)} · 原预算 ¥${esc(x.budget)}<br>${esc(x.id)} · ${esc(x.result)}</span></div>`).join('');
    let action = '';
    if (state.stage === 'awaiting_consent') action = `<div class="hint">请核对剩余订单及《微信视频号企业账号加热功能服务协议》。确认后授权助手逐单提交及支付：平台要求扫码时等待你扫码；显示“免验证提交”时会直接提交付款。每单核对成功后继续下一单。</div><div class="row"><button class="btn primary" id="approve">同意协议并授权剩余订单提交及支付</button></div>`;
    if (state.stage === 'review') action = approvedFor(item)
      ? '<div class="hint">正在核对新单来源、名称、预算及优惠券抵扣后的需支付金额。核对通过后自动提交；平台免验证时会直接付款，需要扫码时等待你扫码。</div>'
      : `<div class="hint">本轮确认未生效，请核对新单名称与需支付金额，并阅读《微信视频号企业账号加热功能服务协议》。点击后会勾选协议并提交本单；平台免验证时会直接付款，需要扫码时等待你扫码。</div><div class="row"><button class="btn primary" id="submit">同意协议并授权本单提交及支付</button></div>`;
    if (state.stage === 'await_result') action = item?.submitLabel === '免验证提交'
      ? '<div class="hint">已发起免验证提交，正在等待并核对平台支付结果；核对成功后继续下一单，不会重复提交。</div>'
      : '<div class="hint">已提交，正在等待平台支付结果。若出现二维码，请扫码完成支付；核对成功后继续下一单。</div>';
    if (state.stage === 'await_payment') action = '<div class="hint">请在平台扫码页面人工完成支付。助手只等待并核对支付后页面。</div>';
    if (state.stage === 'needs_review') action = `<div class="hint">${esc(state.currentError)}</div><div class="row"><button class="btn" id="recover">重新核对并继续</button></div>`;
    if (state.stage === 'paused') action = '<div class="row"><button class="btn primary" id="resume">继续</button></div>';
    if (item?.submittedAt && ['await_result','await_payment','needs_review','paused'].includes(state.stage)) {
      action += '<div class="hint">如已付款但未识别，请先在平台核对新订单名称、预算及付款状态，返回标准订单列表后人工确认。此操作会跳过本单的自动核验。</div><div class="row"><button class="btn" id="manualPaid">已人工核实付款，完成本单</button></div>';
    }
    shadow.innerHTML = css + `<button class="launcher" id="launch" style="display:${open ? 'none' : 'block'}">加热助手</button><div class="panel ${editing ? 'editing' : ''}" style="display:${open ? 'flex' : 'none'}"><div class="head"><div><strong>视频号标准订单逐单加热助手</strong><small>v0.2.13 · 首笔同名订单决定 ROI 入选 · 来源 ID 定位 · 扫码 / 免验证支付</small></div><button id="min" title="最小化">−</button></div><div class="body">
      <div class="card"><div class="title">账户与进度</div><div class="muted">${esc(state.account || accountName() || '尚未锁定账户')}</div><div class="status">${esc({idle:'等待查找来源订单',scanning:'正在扫描第 '+state.pageCount+' 页',ready:filtering ? (selectedCount ? '已预选当天符合条件的订单，请核对' : '当天没有订单符合筛选条件') : '已预选各名称最靠前的订单，请核对',locating:'正在定位来源订单',awaiting_consent:'等待核对本轮剩余订单',opening:'正在打开“再来一单”',review:approvedFor(item) ? '正在核对新单并自动提交' : '等待核对本单并提交',submitting:'已点击提交，正在核实平台结果',await_result:'已提交，持续等待支付结果',await_payment:'等待你扫码支付',verifying_payment:'支付后核对并返回列表',returning:'正在返回标准订单列表',needs_review:'已暂停，需核对当前结果',paused:'已暂停',complete:'队列全部完成'}[state.stage] || state.stage)}</div>${item ? `<div class="hint">新单：${esc(targetName(item))} · 追投预算 ¥${esc(targetBudget(item))}<br>来源：${esc(item.name)} · ${esc(item.id)} · 原预算 ¥${esc(item.budget)}${state.reviewAmount != null ? ' · 本单需支付 ¥'+esc(state.reviewAmount) : ''}</div>` : ''}${action}</div>
      <div class="card"><button id="toggleSettings" class="settingsToggle">${expanded ? '收起设置' : '展开设置'}</button><div class="title">来源订单与新单设置</div>${!expanded ? `<div class="settingsSummary">${state.queue.length ? '本轮已锁定 '+state.queue.length+' 单，新名称和追投预算可在下方队列查看。' : '展开后扫描订单、编辑新名称和追投预算。'}</div>` : ''}<div style="display:${expanded ? 'block' : 'none'};clear:both"><div class="muted">每行一个完整名称。本次清单可临时删改，需要完整清单时点击“从名称库恢复”；长期增删请进入“管理名称库”并保存。首次扫描从第一页找齐，执行时优先按记录页码和来源 ID 定位。</div><textarea id="names" placeholder="增香液-12&#10;增香液-13&#10;增香液-14" ${namesEditable?'':'disabled'}>${esc(namesDraft)}</textarea><div class="row"><button class="btn" id="restoreLibraryNames" ${namesEditable?'':'disabled'}>从名称库恢复</button><button class="btn" id="toggleNameLibrary" ${namesEditable?'':'disabled'}>${nameLibraryOpen?'收起名称库':'管理名称库'}（${libraryCount}）</button></div><div class="row"><button class="btn" id="saveDefaultNames" ${namesEditable?'':'disabled'}>当前清单加入名称库</button><button class="btn" id="scan" ${namesEditable?'':'disabled'}>扫描订单</button>${state.stage === 'scanning' ? '<button class="btn danger" id="cancelScan">停止扫描</button>' : ''}</div>${nameLibraryEditor}<label>最低直接成交 ROI<input id="roiMinimum" type="text" inputmode="decimal" value="${esc(state.roiMinimum)}" placeholder="例如 2.0，留空按名称扫描" ${busy || !canScan ? 'disabled' : '' }></label><div class="muted">填写后，仅查今天创建的订单。按列表顺序，每个名称只检查第一笔；第一笔必须消耗完成且直接成交 ROI 达标，后续同名订单不能替代。</div>${state.matches.length || state.scanComplete ? `<div class="muted" style="margin:8px 0">已扫描 ${state.pageCount} 页，找到 ${state.matches.length}/${names.length} 个名称</div><div class="list">${selected}</div>${state.stage === 'ready' && selectedCount ? `<div class="hint">请核对本轮 ${selectedCount} 单的来源编号、新订单名称和追投预算。<span id="targetTotal">${totalBudget == null ? '请检查新名称及追投预算' : '追投预算合计 ¥' + totalBudget.toFixed(2)}</span>。点击开始表示你已阅读并同意《微信视频号企业账号加热功能服务协议》；授权助手逐单核实新单金额、勾选协议并提交及支付。平台要求扫码时等待你扫码；显示“免验证提交”时直接提交付款，核对成功后继续下一单。</div>` : ''}<div class="row"><button class="btn primary" id="start" ${busy || state.stage !== 'ready' || !selectedCount ? 'disabled' : ''}>已核对并同意协议，授权本轮提交及支付</button></div>` : ''}</div>
      </div><div class="card"><div class="title">逐单队列</div>${queue || '<div class="muted">尚未选择来源订单</div>'}<div class="row"><button class="btn danger" id="pause" ${!['locating','awaiting_consent','opening','review','await_result','await_payment'].includes(state.stage) ? 'disabled' : ''}>暂停</button><button class="btn" id="reset">清空队列</button></div></div>
      <div class="card"><div class="title">执行记录</div><div class="log">${esc(state.logs.slice(-35).join('\n') || '尚无记录')}</div><div class="row"><button class="btn" id="copy">复制记录</button></div></div>
      </div></div>`;
    shadow.getElementById('launch').onclick = () => { open = true; render(); };
    shadow.getElementById('min').onclick = () => { open = false; nameLibraryOpen = false; render(); };
    shadow.getElementById('scan').onclick = scan;
    shadow.getElementById('names')?.addEventListener('input',event=>{
      if (!canEditNames()) return;
      namesDraft = event.target.value; state.namesDraft = namesDraft;
      if (tabId) GM_setValue(STORE_KEY,state);
    });
    shadow.getElementById('saveDefaultNames')?.addEventListener('click',addCurrentNamesToLibrary);
    shadow.getElementById('restoreLibraryNames')?.addEventListener('click',restoreLibraryNames);
    shadow.getElementById('toggleNameLibrary')?.addEventListener('click',()=>{
      if (!canEditNames()) return;
      if (nameLibraryDraft === null) nameLibraryDraft = libraryNames().join('\n');
      nameLibraryOpen = !nameLibraryOpen;
      render();
    });
    shadow.getElementById('nameLibraryDraft')?.addEventListener('input',event=>{
      if (canEditNames()) nameLibraryDraft = event.target.value;
    });
    shadow.getElementById('saveNameLibrary')?.addEventListener('click',saveNameLibrary);
    shadow.getElementById('addBuiltinNames')?.addEventListener('click',()=>{
      if (!canEditNames()) return;
      nameLibraryDraft = parseNames((nameLibraryDraft ?? '') + '\n' + BUILTIN_NAMES).join('\n');
      render();
    });
    shadow.getElementById('start')?.addEventListener('click', startQueue);
    shadow.getElementById('toggleSettings')?.addEventListener('click',()=>{state.settingsExpanded=!expanded;if(expanded)nameLibraryOpen=false;save();});
    shadow.getElementById('approve')?.addEventListener('click', approveCurrent);
    shadow.getElementById('submit')?.addEventListener('click', confirmAndSubmit);
    shadow.getElementById('recover')?.addEventListener('click', recover);
    shadow.getElementById('manualPaid')?.addEventListener('click', manualPaid);
    shadow.getElementById('resume')?.addEventListener('click', resume);
    shadow.getElementById('cancelScan')?.addEventListener('click', () => { scanCancel = true; });
    shadow.getElementById('pause').onclick = pause;
    shadow.getElementById('reset').onclick = reset;
    shadow.getElementById('copy').onclick = () => GM_setClipboard(state.logs.join('\n'));
    shadow.querySelectorAll('input[data-name]').forEach(input => input.onchange = () => { if(busy||state.stage!=='ready')return;state.choices[input.dataset.name] = input.value; save(); });
    shadow.querySelectorAll('input[data-edit-id]').forEach(input=>input.oninput=()=>{
      if(busy||state.stage!=='ready')return;
      const id=input.dataset.editId,field=input.dataset.editField;
      state.edits[id]={...(state.edits[id]||{}),[field]:input.value};state.approvedQueueKey='';
      // 输入时仅更新汇总和存储，避免重建面板打断中文输入及光标。
      if(tabId)GM_setValue(STORE_KEY,state);
      const total=selectedDraftTotal(),summary=shadow.getElementById('targetTotal');
      if(summary)summary.textContent=total==null?'请检查新名称及追投预算':'追投预算合计 ¥'+total.toFixed(2);
    });
    shadow.querySelectorAll('button[data-default-id]').forEach(button=>button.onclick=()=>{if(busy||state.stage!=='ready')return;delete state.edits[button.dataset.defaultId];save();});
    const body = shadow.querySelector('.body'); if (body) body.scrollTop = wasEditing && !editing ? 0 : oldScroll;
  }

  // 关闭标签页期间没有定时器；重开同一标签页后只恢复能确认的状态。
  if (state.stage === 'submitting') {
    state.stage = 'await_result';
    state.currentError = '';
    save();
  }
  if (state.stage === 'scanning') {
    state.stage = 'idle'; state.scanComplete = false;
    state.logs.push('页面刷新打断了扫描，请重新扫描；未执行任何订单提交');
    save();
  }
  render();
  setInterval(tick, 2500);
  window.addEventListener('focus', tick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
