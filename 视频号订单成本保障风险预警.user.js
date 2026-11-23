// ==UserScript==
// @name         视频号订单成本保障风险预警
// @namespace    local.channels.cost-protection-risk
// @version      0.1.9
// @description  按ROI范围扫描在投标准订单，估算成本保障风险并由用户决定是否停止加热
// @match        https://channels.weixin.qq.com/promote/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const ROOT = 'channels-cost-protection-risk';
  if (window.top !== window.self || document.getElementById(ROOT)) return;

  const PREF_KEY = ROOT + ':preferences:v1';
  const savedPreferences = GM_getValue(PREF_KEY, {}) || {};
  const defaults = Object.assign({ roiMinimum: '', roiMaximum: '', panelPosition: null }, savedPreferences);
  if (!Object.prototype.hasOwnProperty.call(savedPreferences, 'roiMaximum') && savedPreferences.roiMinimum != null) {
    defaults.roiMaximum = String(savedPreferences.roiMinimum);
    defaults.roiMinimum = '';
  }
  const state = { scanning: false, stopping: false, stopProgress: '', complete: false, page: 0, totalPages: 0, account: '', rows: [], error: '' };
  const host = document.createElement('div');
  host.id = ROOT;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const css = `<style>
    :host{font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1e293b}*{box-sizing:border-box}
    button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.48;cursor:not-allowed}
    .launcher{pointer-events:auto;position:fixed;right:0;top:39%;z-index:2147483646;width:34px;min-height:122px;border:1px solid #d6e7ff;border-right:0;border-radius:12px 0 0 12px;background:#087bff;color:white;padding:10px 7px;writing-mode:vertical-rl;box-shadow:0 5px 18px #0b64bb44;font-weight:700}
    .panel{pointer-events:auto;position:fixed;width:min(410px,calc(100vw - 24px));height:calc(100dvh - 24px);display:flex;flex-direction:column;border:1px solid #dce5f1;border-radius:17px;background:#f8fbff;box-shadow:0 18px 45px #22334d35;overflow:hidden}
    .head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:13px 15px;background:white;border-bottom:1px solid #e4eaf2;cursor:move;touch-action:none;user-select:none}.head strong{font-size:15px}.head small{display:block;color:#738196;font-size:11px}.head button{width:30px;height:30px;border:0;border-radius:50%;background:#eef2f7;color:#5a6473;font-size:19px;cursor:pointer}
    .body{min-height:0;overflow:auto;padding:13px}.card{padding:12px;margin-bottom:11px;border:1px solid #e1e8f1;border-radius:12px;background:white}.title{font-weight:700;margin-bottom:7px}.muted{color:#697789;font-size:11px}.hint{color:#697789;font-size:11px;margin-top:7px}.status{padding:9px 10px;background:#eaf3ff;color:#135fae;border-radius:9px;font-weight:700;overflow-wrap:anywhere}
    input{width:100%;padding:8px 9px;border:1px solid #ccd8e8;border-radius:8px;outline:0;background:white;color:#1e293b}input:focus{border-color:#087bff;box-shadow:0 0 0 3px #087bff18}
    .row{display:flex;gap:8px;align-items:center;margin-top:9px}.row label{flex:1;min-width:0}.row input{width:96px;flex:none}.rangeRow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}.rangeField{min-width:0}.rangeField label{display:block;margin-bottom:4px;color:#536273;font-size:11px}.rangeField input{width:100%}.btn{border:1px solid #c9dcf7;border-radius:9px;background:white;color:#0765d5;padding:8px 10px;font-weight:700}.btn.primary{width:100%;background:#087bff;border-color:#087bff;color:white}.btn.danger{color:#c7423d;border-color:#ffd2ce;background:#fff;white-space:nowrap}.btn.batch{width:100%;margin-top:8px}
    .progress{height:6px;margin-top:9px;overflow:hidden;border-radius:8px;background:#eaf0f7}.progress span{display:block;height:100%;border-radius:inherit;background:#087bff;transition:width .2s}.progress.indeterminate span{width:35%;animation:slide 1.1s ease-in-out infinite alternate}@keyframes slide{from{transform:translateX(0)}to{transform:translateX(185%)}}
    .stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:9px}.stat{min-width:0;padding:8px;background:#f4f7fb;border-radius:8px}.stat b{display:block;font-size:16px;color:#1e293b}.stat span{display:block;color:#697789;font-size:10px;overflow-wrap:anywhere}
    .list{display:grid;gap:8px;margin-top:9px}.item{padding:10px;border:1px solid #e6ecf3;border-radius:10px;background:#fff}.itemTop{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.item b{min-width:0;overflow-wrap:anywhere}.badge{flex:none;padding:2px 7px;border-radius:99px;background:#fff1e8;color:#a44915;font-size:10px;font-weight:700}.item .meta{margin-top:5px;color:#536273;font-size:11px;overflow-wrap:anywhere}.item .flag{color:#a44915;font-weight:700}.itemActions{display:flex;justify-content:flex-end;margin-top:8px}.error{margin-top:8px;padding:8px 9px;border-radius:8px;background:#fff1f0;color:#a12622;font-weight:700;overflow-wrap:anywhere}
  </style>`;
  let open = false;
  function clampPosition(left, top) {
    const panel = shadow.querySelector('.panel');
    const width = panel?.offsetWidth || Math.min(410, innerWidth - 24);
    const height = panel?.offsetHeight || innerHeight - 24;
    return {
      left: Math.max(8, Math.min(Math.round(left), innerWidth - width - 8)),
      top: Math.max(8, Math.min(Math.round(top), innerHeight - height - 8))
    };
  }
  function defaultPosition() {
    const width = Math.min(410, innerWidth - 24);
    return clampPosition(innerWidth >= 850 ? innerWidth - width - 434 : innerWidth - width - 12, innerWidth >= 850 ? 12 : 62);
  }
  function currentPosition() {
    const saved = defaults.panelPosition;
    return saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)
      ? clampPosition(saved.left, saved.top)
      : defaultPosition();
  }
  function bindPanelDrag() {
    const panel = shadow.querySelector('.panel');
    const head = shadow.querySelector('.head');
    if (!panel || !head) return;
    head.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      head.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        const position = clampPosition(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
        defaults.panelPosition = position;
        panel.style.left = position.left + 'px';
        panel.style.top = position.top + 'px';
      };
      const finish = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', finish);
        head.removeEventListener('pointercancel', finish);
        GM_setValue(PREF_KEY, defaults);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', finish, { once: true });
      head.addEventListener('pointercancel', finish, { once: true });
      event.preventDefault();
    });
  }

  function clean(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' '); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function visible(el) { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; }
  function number(value) {
    const normalized = clean(value).normalize('NFKC').replace(/[￥¥元,\s]/g, '');
    if (!/^-?(?:\d+|\d*\.\d+)$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function roiNumber(value) {
    const normalized = clean(value).normalize('NFKC').replace(/,/g, '');
    const match = normalized.match(/-?(?:\d+\.?\d*|\.\d+)/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function orderTable() {
    return [...document.querySelectorAll('table')].find(table => {
      const header = [...table.querySelectorAll('thead tr')].flatMap(row => [...row.cells]).map(cell => clean(cell.innerText));
      return ['订单信息','投放进度','订单状态'].every(label => header.includes(label)) && header.includes('出价(ROI)');
    }) || null;
  }
  function isList() {
    return location.origin === 'https://channels.weixin.qq.com' && /\/promote\/pages\/platform\/order-list\/?$/.test(location.pathname) && !!orderTable();
  }
  function accountName() { return clean(document.querySelector('.account-info .name')?.innerText); }
  function readRows() {
    const table = orderTable();
    if (!table) throw new Error('请打开订单管理中的标准订单列表');
    const header = [...table.querySelectorAll('thead tr:last-child th, thead tr:last-child td')].map(cell => clean(cell.innerText));
    const index = label => header.indexOf(label);
    const required = ['订单信息','投放进度','订单状态','出价(ROI)','直接成交ROI','直接成交订单数'];
    if (required.some(label => index(label) < 0)) throw new Error('订单表缺少必需列：' + required.filter(label => index(label) < 0).join('、'));
    return [...table.querySelectorAll('tbody tr')].filter(visible).map(row => {
      const cells = [...row.querySelectorAll(':scope > td')];
      if (cells.length < header.length - 1) return null;
      const first = clean(cells[index('订单信息')]?.innerText);
      const id = (first.match(/\b\d{10,}_\d+\b/) || [])[0];
      if (!id) return null;
      const progress = clean(cells[index('投放进度')]?.innerText).normalize('NFKC').match(/([\d,.]+)\s*\/\s*[￥¥]?\s*([\d,.]+)/);
      const bidText = clean(cells[index('出价(ROI)')]?.innerText);
      const bid = number(bidText);
      const roi = roiNumber(cells[index('直接成交ROI')]?.innerText);
      const count = number(cells[index('直接成交订单数')]?.innerText);
      const amountIndex = index('直接成交金额');
      const name = first.split(/短视频加热|直播加热/)[0].trim();
      return {
        id, name, promoteType: first.includes('直播加热') ? '直播' : first.includes('短视频加热') ? '短视频' : '未知类型',
        spent: progress ? number(progress[1]) : null, budget: progress ? number(progress[2]) : null,
        status: clean(cells[index('订单状态')]?.innerText), bidText, bid, bidIsCost: /[￥¥元]/.test(bidText),
        roi, count, amount: amountIndex >= 0 ? number(cells[amountIndex]?.innerText) : null,
        page: pageNumber(), row
      };
    }).filter(Boolean);
  }
  function pageNumber() {
    const direct = Number(clean(document.querySelector('.finder-ui-desktop-pagination__num_current')?.innerText));
    if (Number.isInteger(direct) && direct > 0) return direct;
    const input = document.querySelector('.finder-ui-desktop-pagination__input');
    const fromInput = Number(input?.value);
    return Number.isInteger(fromInput) && fromInput > 0 ? fromInput : 1;
  }
  function maxPage() {
    const pager = document.querySelector('.finder-ui-desktop-pagination');
    const nums = [...(pager?.querySelectorAll('.finder-ui-desktop-pagination__num') || [])]
      .map(el => Number(clean(el.innerText))).filter(value => Number.isInteger(value) && value > 0);
    return Math.max(1, ...nums);
  }
  function orderTotal() {
    const match = document.body.innerText.match(/订单总数（\s*([\d,]+)\s*）/);
    return match ? number(match[1]) : null;
  }
  function setInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('无法操作平台页码输入框');
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles:true }));
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }
  function rowsSignature(rows = readRows()) { return rows.map(row => row.id + ':' + row.spent).join('|'); }
  async function waitForPage(page, previousSignature = '') {
    const deadline = Date.now() + 15000;
    let last = '';
    let stable = 0;
    while (Date.now() < deadline) {
      if (!isList()) throw new Error('扫描期间已离开标准订单列表');
      if (pageNumber() === page) {
        const rows = readRows();
        const sig = rowsSignature(rows);
        if (sig && sig !== previousSignature && sig === last) { if (!stable) stable = Date.now(); if (Date.now() - stable >= 350) return rows; }
        else { last = sig; stable = 0; }
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('等待第 ' + page + ' 页订单加载超时');
  }
  async function gotoPage(target) {
    if (pageNumber() === target) return waitForPage(target);
    const previousSignature = rowsSignature();
    const pager = document.querySelector('.finder-ui-desktop-pagination');
    const input = pager?.querySelector('input.finder-ui-desktop-pagination__input');
    const jump = [...(pager?.querySelectorAll('a,button') || [])].find(el => clean(el.innerText) === '跳转');
    if (!input || !jump) throw new Error('找不到平台订单分页跳转控件');
    setInput(input, target);
    jump.click();
    return waitForPage(target, previousSignature);
  }
  function statusFilter() {
    const field = document.querySelector('.finder-card .finder-ui-desktop-form__dropdowncascade-label');
    if (!field) throw new Error('找不到平台订单状态筛选器');
    return field;
  }
  function selectedStatuses(field = statusFilter()) {
    const summary = clean(field.querySelector('dt')?.innerText);
    if (!summary || summary === '选择订单状态') return [];
    return [...field.querySelectorAll('li')]
      .map(li => clean(li.querySelector('[title]')?.getAttribute('title') || li.innerText))
      .filter(label => summary.includes(label));
  }
  function checkedStatuses(field = statusFilter()) {
    return [...field.querySelectorAll('li')]
      .filter(li => li.classList.contains('checked'))
      .map(li => clean(li.querySelector('[title]')?.getAttribute('title') || li.innerText));
  }
  async function setStatusFilters(statuses) {
    const field = statusFilter();
    const menu = field.querySelector('.finder-ui-desktop-dropdown-menu');
    const isMenuOpen = () => menu && getComputedStyle(menu).display !== 'none';
    if (!isMenuOpen()) field.querySelector('dt')?.click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !isMenuOpen()) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!isMenuOpen()) {
      throw new Error('无法打开平台订单状态筛选菜单');
    }
    const desired = new Set(statuses);
    for (const li of field.querySelectorAll('li')) {
      const label = clean(li.querySelector('[title]')?.getAttribute('title') || li.innerText);
      const currentlySelected = checkedStatuses(field).includes(label);
      if (currentlySelected !== desired.has(label)) {
        li.querySelector('.finder-ui-desktop-dropdown__list-ele-contain')?.click();
        const changeDeadline = Date.now() + 1000;
        while (Date.now() < changeDeadline && checkedStatuses(field).includes(label) !== desired.has(label)) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    }
    const actual = checkedStatuses(field);
    if (actual.length !== desired.size || actual.some(label => !desired.has(label))) {
      throw new Error('无法确认平台订单状态筛选已设置');
    }
    if (isMenuOpen()) field.querySelector('dt')?.click();
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline && isMenuOpen()) await new Promise(resolve => setTimeout(resolve, 50));
    if (isMenuOpen()) throw new Error('订单状态菜单未能收起，未提交筛选');
  }
  async function applyStatusFilter(expectedStatuses) {
    const beforeTotal = orderTotal();
    const beforeSignature = rowsSignature();
    const expected = new Set(expectedStatuses);
    const alreadyApplied = selectedStatuses().length === expected.size && selectedStatuses().every(label => expected.has(label));
    const button = [...document.querySelectorAll('.finder-card button')].find(el => clean(el.innerText) === '筛选');
    if (!button) throw new Error('找不到平台“筛选”按钮');
    button.click();
    const deadline = Date.now() + 15000;
    let lastSignature = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      if (!isList()) throw new Error('筛选期间已离开标准订单列表');
      const rows = readRows();
      const total = orderTotal();
      const signature = rowsSignature(rows);
      const rowsMatch = expected.size === 0
        ? true
        : rows.length > 0 && rows.every(row => [...expected].some(status => row.status.includes(status)));
      const changed = (total !== null && beforeTotal !== null && total !== beforeTotal) || signature !== beforeSignature;
      if (signature && signature === lastSignature) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 350 && rowsMatch && (changed || alreadyApplied)) return;
      } else {
        lastSignature = signature;
        stableSince = 0;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(expected.has('加热中')
      ? '已勾选“加热中”并点击筛选，但列表仍未确认只显示在投订单，已停止扫描，结果未完成'
      : '已提交恢复原订单状态筛选，但平台列表未确认更新，已停止扫描，结果未完成');
  }
  function assess(row) {
    const active = /加热中|投放中/.test(row.status) && !/已结束|已取消|审核未通过/.test(row.status);
    const minimumRoi = defaults.roiMinimum === '' ? null : Number(defaults.roiMinimum);
    const maximumRoi = defaults.roiMaximum === '' ? null : Number(defaults.roiMaximum);
    const matchesRoi = Number.isFinite(row.roi) && (minimumRoi === null || row.roi >= minimumRoi) && (maximumRoi === null || row.roi <= maximumRoi);
    if (!active || !matchesRoi) return null;
    if (!row.bidIsCost || !(row.bid > 0)) return { ...row, estimate: null, risk: false, note: 'ROI 出价目标：赔付预期消耗口径未知，无法可靠估算' };
    if (!(row.spent > 0) || !(row.count > 0)) return { ...row, estimate: null, risk: false, note: '当前无有效样本，无法按成交成本外推' };
    const currentCPA = row.spent / row.count;
    const forecastConversions = row.budget > 0 ? row.budget / currentCPA : null;
    const expectedSpend = Number.isFinite(forecastConversions) ? row.bid * forecastConversions : null;
    const ratio = expectedSpend > 0 ? row.budget / expectedSpend : null;
    const risk = Number.isFinite(ratio) && ratio > 1.2;
    const cashGate = row.spent >= 300;
    const conversionGate = row.count >= 2;
    const qualification = cashGate && conversionGate
      ? '消耗及成交数已达常见门槛；支付方式、有效成交及其他资格仍需核实'
      : `预测风险；当前${cashGate ? '' : '未达到300元消耗门槛'}${!cashGate && !conversionGate ? '，' : ''}${conversionGate ? '' : '未达到2次成交门槛'}`;
    return {
      ...row, estimate: { currentCPA, forecastConversions, expectedSpend, ratio }, risk,
      note: risk ? qualification : '目前趋势未超过严格120%线'
    };
  }
  function allActiveRows() { return state.rows.filter(row => /加热中|投放中/.test(row.status) && !/已结束|已取消|审核未通过/.test(row.status)); }
  function candidates() {
    const minimumRoi = defaults.roiMinimum === '' ? null : Number(defaults.roiMinimum);
    const maximumRoi = defaults.roiMaximum === '' ? null : Number(defaults.roiMaximum);
    if ((minimumRoi !== null && (!Number.isFinite(minimumRoi) || minimumRoi < 0)) ||
        (maximumRoi !== null && (!Number.isFinite(maximumRoi) || maximumRoi < 0)) ||
        (minimumRoi === null && maximumRoi === null) ||
        (minimumRoi !== null && maximumRoi !== null && minimumRoi > maximumRoi)) return [];
    return allActiveRows().map(row => assess(row)).filter(Boolean);
  }
  function groupedCandidates() {
    const matches = candidates();
    return {
      below: matches.filter(row => row.estimate && !row.risk),
      above: matches.filter(row => row.estimate && row.risk),
      unknown: matches.filter(row => !row.estimate || !Number.isFinite(row.estimate.ratio))
    };
  }
  function readRoiRange() {
    const minText = shadow.querySelector('#minimum')?.value.trim() || '';
    const maxText = shadow.querySelector('#maximum')?.value.trim() || '';
    const min = minText === '' ? null : Number(minText);
    const max = maxText === '' ? null : Number(maxText);
    if (min === null && max === null) throw new Error('请至少填写 ROI 下限或上限');
    if ((min !== null && (!Number.isFinite(min) || min < 0)) || (max !== null && (!Number.isFinite(max) || max < 0))) throw new Error('ROI 上下限须为0或正数');
    if (min !== null && max !== null && min > max) throw new Error('ROI 下限不能大于上限');
    defaults.roiMinimum = minText;
    defaults.roiMaximum = maxText;
    GM_setValue(PREF_KEY, defaults);
  }
  async function scan() {
    if (state.scanning) return;
    if (!isList()) { state.error = '请先进入视频号加热平台 → 订单管理 → 标准订单'; render(); return; }
    state.scanning = true; state.complete = false; state.error = ''; state.rows = []; state.page = 0;
    const account = accountName();
    if (!account) { state.scanning = false; state.error = '未读到账户名称，请确认平台页面已加载'; render(); return; }
    state.account = account;
    const startPage = pageNumber();
    let originalStatuses = [];
    let filterChanged = false;
    try {
      originalStatuses = checkedStatuses();
      filterChanged = true;
      await setStatusFilters(['加热中']);
      await applyStatusFilter(['加热中']);
      await new Promise(resolve => setTimeout(resolve, 300));
      const pages = maxPage();
      if (pages > 20) throw new Error('“加热中”筛选后仍超过20页，已停止扫描以避免读取过大的结果集');
      state.totalPages = pages;
      const found = new Map();
      for (let page = 1; page <= pages; page++) {
        if (!isList() || accountName() !== account) throw new Error('扫描期间页面或账户发生变化，已停止');
        const rows = await gotoPage(page);
        if (!rows.length || rows.some(row => !/加热中|投放中/.test(row.status) || /已结束|已取消|审核未通过/.test(row.status))) {
          throw new Error(`第 ${page} 页含非在投订单或未读到订单，已停止并标记为未完成`);
        }
        for (const row of rows) found.set(row.id, { ...row, page });
        state.rows = [...found.values()]; state.page = page; render();
      }
      state.rows = [...found.values()];
      state.complete = true;
    } catch (error) { state.error = error.message; }
    finally {
      if (isList() && accountName() === account && filterChanged) {
        try {
          await setStatusFilters(originalStatuses);
          await applyStatusFilter(originalStatuses);
          const restoredPage = Math.min(startPage, maxPage());
          if (pageNumber() !== restoredPage) await gotoPage(restoredPage);
        } catch (restoreError) {
          state.error = (state.error ? state.error + '；' : '') + '恢复原筛选或页码失败：' + restoreError.message;
        }
      } else if (isList() && accountName() === account && pageNumber() !== startPage) {
        await gotoPage(startPage).catch(() => {});
      }
      state.scanning = false; render();
    }
  }
  async function startPauseFlow(id, options = {}) {
    const item = candidates().find(row => row.id === id);
    if (!item || state.scanning || (state.stopping && !options.fromBatch)) return false;
    if (!options.confirmed && !confirm(`将打开订单 ${item.id}（${item.name}）详情并点击“停止加热”。若平台未再弹确认框，此操作可能立即生效。继续？`)) return false;
    if (!isList() || accountName() !== state.account) { state.error = '账户或页面已变化，请重新扫描'; render(); return false; }
    try {
      const freshRows = await gotoPage(item.page);
      const fresh = freshRows.find(row => row.id === id);
      if (!fresh || fresh.status !== item.status || fresh.roi !== item.roi || fresh.spent !== item.spent || fresh.budget !== item.budget) {
        throw new Error('订单状态或指标已变化，请重新扫描并复核');
      }
      const detailLink = [...fresh.row.querySelectorAll('a')].find(anchor => clean(anchor.innerText) === '查看详情');
      if (!detailLink) throw new Error('找不到该订单的详情入口');
      detailLink.click();
      const detailDeadline = Date.now() + 15000;
      while (Date.now() < detailDeadline) {
        const detailId = new URL(location.href).searchParams.get('promotionId');
        if (location.pathname.endsWith('/detail') && detailId === id && document.body.innerText.includes('停止加热')) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      const detailId = new URL(location.href).searchParams.get('promotionId');
      if (detailId !== id || !document.body.innerText.includes(item.name)) throw new Error('订单详情与候选订单不匹配，未触发停止加热');
      if (!/订单加热中|加热中/.test(document.body.innerText)) throw new Error('订单已不在加热中，请重新扫描确认状态');
      const stopLinks = [...document.querySelectorAll('a')].filter(anchor => visible(anchor) && clean(anchor.innerText) === '停止加热');
      if (stopLinks.length !== 1) throw new Error('未能唯一确认详情页的“停止加热”入口');
      stopLinks[0].click();
      if (options.returnToList) {
        const modal = [...document.querySelectorAll('[role="dialog"],[class*="dialog"]')]
          .find(el => visible(el) && /停止|确认|确定/.test(clean(el.innerText)));
        if (modal) throw new Error('平台出现确认窗口，批量流程已停在当前订单；请先人工核对并处理平台窗口');
        history.back();
        const returnDeadline = Date.now() + 15000;
        while (Date.now() < returnDeadline && !isList()) await new Promise(resolve => setTimeout(resolve, 150));
        if (!isList()) throw new Error('触发停止加热后未返回订单列表，批量流程已暂停');
      } else {
        state.error = `已为 ${id} 触发“停止加热”入口。请核对平台弹窗；若页面未再确认且状态已变化，请以平台结果为准。`;
      }
      return true;
    } catch (error) { state.error = error.message; render(); return false; }
    render();
    return true;
  }
  async function bulkStop(groupKey) {
    if (!state.complete || state.scanning || state.stopping || !isList() || accountName() !== state.account) {
      state.error = '请在订单列表完成扫描后再批量停止'; render(); return;
    }
    const groups = groupedCandidates();
    const rows = groups[groupKey] || [];
    if (!rows.length) return;
    const label = groupKey === 'above' ? '超过赔付线' : '未超过赔付线';
    const ids = rows.map(row => row.id).join('、');
    if (!confirm(`即将对“${label}”的 ${rows.length} 笔订单逐单触发“停止加热”：\n${ids}\n\n每笔会重新核对状态和指标；若平台弹出确认窗口或页面无法返回列表，批量流程会暂停。停止操作可能立即生效，继续吗？`)) return;
    state.stopping = true; state.error = '';
    try {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        state.stopProgress = `${label}：正在处理 ${index + 1}/${rows.length} · ${row.id}`;
        render();
        const ok = await startPauseFlow(row.id, { confirmed: true, fromBatch: true, returnToList: true });
        if (!ok) throw new Error(state.error || `订单 ${row.id} 未完成，批量操作已暂停`);
        const freshRows = await gotoPage(row.page);
        const stillActive = freshRows.find(item => item.id === row.id);
        if (stillActive && /加热中|投放中/.test(stillActive.status)) {
          throw new Error(`订单 ${row.id} 仍显示在投，批量操作已暂停，请核对平台结果`);
        }
      }
      state.error = `${label} ${rows.length} 笔订单均已触发停止加热；请以平台最终状态为准。`;
    } catch (error) {
      state.error = error.message;
    } finally {
      state.stopping = false; state.stopProgress = ''; render();
    }
  }
  function render() {
    const list = candidates();
    const groups = groupedCandidates();
    const activeCount = allActiveRows().length;
    const progressPercent = state.totalPages ? Math.min(100, Math.round(state.page / state.totalPages * 100)) : 0;
    const renderItems = (rows, showRiskBadge) => rows.length ? rows.map(row => {
      const est = row.estimate;
      const metrics = est
        ? `直接成交 ROI ${row.roi} · 出价 ¥${row.bid} · 消耗 ¥${row.spent}/¥${row.budget} · 成交 ${row.count}<br>当前成交成本 ¥${est.currentCPA.toFixed(2)} · 预计消耗/预期消耗 ${Number.isFinite(est.ratio) ? (est.ratio * 100).toFixed(1) + '%' : '无法计算'}`
        : `直接成交 ROI ${row.roi ?? '未读到'} · 出价 ${esc(row.bidText)} · 消耗 ¥${row.spent ?? '未读到'}/¥${row.budget ?? '未读到'} · ${row.note}`;
      return `<article class="item"><div class="itemTop"><b>${esc(row.name || '未命名')} · ${esc(row.id)}</b>${showRiskBadge ? `<span class="badge">${row.risk ? '超过赔付线' : '未超过赔付线'}</span>` : '<span class="badge">待核实</span>'}</div><div class="meta">${esc(row.promoteType)} · 第 ${row.page} 页 · ${esc(row.status)}</div><div class="meta">${metrics}</div><div class="meta flag">${esc(row.note)}</div><div class="itemActions"><button class="btn danger" data-pause="${esc(row.id)}" ${state.stopping?'disabled':''}>停止加热</button></div></article>`;
    }).join('') : '<div class="muted">此分组暂无订单。</div>';
    const groupCard = (title, key, rows) => `<section class="card"><div class="title">${title} · ${rows.length} 笔</div><button class="btn danger batch" data-bulk="${key}" ${!state.complete || state.stopping || !rows.length ? 'disabled' : ''}>一键停止本组 ${rows.length} 笔</button><div class="list">${renderItems(rows, true)}</div></section>`;
    const roiRangeLabel = defaults.roiMinimum !== '' && defaults.roiMaximum !== '' ? `ROI ${defaults.roiMinimum}–${defaults.roiMaximum}` : defaults.roiMinimum !== '' ? `ROI ≥ ${defaults.roiMinimum}` : defaults.roiMaximum !== '' ? `ROI ≤ ${defaults.roiMaximum}` : '未设置 ROI 范围';
    const readableRoiCount = state.rows.filter(row => Number.isFinite(row.roi)).length;
    const progressLabel = state.scanning
      ? state.page ? `正在扫描第 ${state.page}/${state.totalPages} 页 · 已读取 ${state.rows.length} 笔` : '正在应用“加热中”筛选…'
      : state.complete ? `扫描完成 · ${roiRangeLabel} · 在投 ${state.rows.length} 笔 · ROI 已读取 ${readableRoiCount} 笔 / 未读取 ${state.rows.length - readableRoiCount} 笔` : '尚未完成扫描';
    const position = currentPosition();
    shadow.innerHTML = css + `<button id="launch" class="launcher" style="display:${open ? 'none' : 'block'}">成本风险</button><section class="panel" style="left:${position.left}px;top:${position.top}px;display:${open ? 'flex' : 'none'}"><header class="head"><div><strong>视频号成本保障风险预警</strong><small>趋势估算 · 不代表平台确认赔付</small></div><button id="min" title="最小化">−</button></header><main class="body"><section class="card"><div class="title">账户与扫描</div><div class="muted">${esc(state.account || accountName() || '尚未识别账户')}</div><div class="rangeRow"><div class="rangeField"><label for="minimum">ROI ≥</label><input id="minimum" inputmode="decimal" placeholder="不限" value="${esc(defaults.roiMinimum)}" ${state.scanning || state.stopping?'disabled':''}></div><div class="rangeField"><label for="maximum">ROI ≤</label><input id="maximum" inputmode="decimal" placeholder="不限" value="${esc(defaults.roiMaximum)}" ${state.scanning || state.stopping?'disabled':''}></div></div><div class="hint">填写上下限可筛选区间；只填“ROI ≤”即可按低 ROI 筛选。</div><div class="row"><button class="btn primary" id="scan" ${state.scanning || state.stopping?'disabled':''}>${state.scanning?'正在扫描…':'扫描加热中的订单'}</button></div><div class="status" style="margin-top:9px">${state.stopping ? esc(state.stopProgress) : progressLabel}</div>${state.scanning ? `<div class="progress ${state.page ? '' : 'indeterminate'}"><span style="width:${state.page ? progressPercent : 35}%"></span></div>` : ''}<div class="hint">临时筛选“加热中”并扫描全部分页，结束后恢复原筛选与页码。预测比例严格超过 120% 归为超过赔付线。</div></section>${state.complete ? `<section class="card"><div class="title">扫描汇总</div><div class="stats"><div class="stat"><b>${state.rows.length}</b><span>读取订单</span></div><div class="stat"><b>${activeCount}</b><span>在投订单</span></div><div class="stat"><b>${list.length}</b><span>ROI 条件命中</span></div></div></section>${groupCard('未超过赔付线', 'below', groups.below)}${groupCard('超过赔付线', 'above', groups.above)}<section class="card"><div class="title">暂无法判断 · ${groups.unknown.length} 笔</div><div class="hint">ROI 出价或缺少成交样本，无法可靠估算赔付线；不会误归入未超过线。</div><div class="list">${renderItems(groups.unknown, false)}</div></section>` : `<section class="card"><div class="title">扫描结果</div><div class="muted">扫描完成后按 ROI 条件和预测赔付线分组显示订单。</div></section>`}${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}<section class="card"><div class="title">判定与操作</div><div class="muted">趋势估算使用当前成交成本外推。平台有效成交、支付方式及其他赔付资格仍需人工核实。停止前逐单复核编号、状态和指标；批量操作出现平台确认窗口时会暂停。</div></section></main></section>`;
    bindPanelDrag();
    shadow.querySelector('#launch')?.addEventListener('click', () => { open = true; render(); });
    shadow.querySelector('#min')?.addEventListener('click', () => { open = false; render(); });
    shadow.querySelector('#scan')?.addEventListener('click', () => {
      try { readRoiRange(); state.error = ''; scan(); }
      catch (error) { state.error = error.message; render(); }
    });
    ['#minimum', '#maximum'].forEach(selector => shadow.querySelector(selector)?.addEventListener('change', () => {
      try { readRoiRange(); state.error = ''; render(); }
      catch (error) { state.error = error.message; render(); }
    }));
    shadow.querySelectorAll('[data-pause]').forEach(button => button.addEventListener('click', () => startPauseFlow(button.dataset.pause)));
    shadow.querySelectorAll('[data-bulk]').forEach(button => button.addEventListener('click', () => bulkStop(button.dataset.bulk)));
  }

  render();
})();
