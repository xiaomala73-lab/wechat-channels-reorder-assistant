// ==UserScript==
// @name         视频号标准订单逐单加热助手
// @namespace    local.channels.standard-order-reorder
// @version      0.2.3
// @description  来源订单按记录页码和ID快速定位，向后查找并更新页码；支持自定义名称/预算、优惠券、人工支付后继续
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
    names: '', matches: [], choices: {}, edits: {}, settingsExpanded: true, queue: [], index: 0,
    stage: 'idle', account: '', scanComplete: false, pageCount: 0, lastSourcePage: 0,
    detailUrl: '', reviewUrl: '', returningAt: 0, openingAt: 0, reviewAmount: null,
    approvedQueueKey: '', pausedFrom: '', currentError: '', logs: []
  }, stored && typeof stored === 'object' ? stored : {});
  // 兼容旧版已超时/刷新中断的提交，禁止把原表单重新当作未提交订单。
  if (currentItem() && (state.stage === 'submitting' ||
      /提交结果需要核对|提交后页面曾刷新/.test(state.currentError))) {
    currentItem().submittedAt = currentItem().submittedAt || Date.now();
  }
  let open = false;
  let busy = false;
  let scanCancel = false;
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
  function hasStandardOrderRows() {
    return Array.from(document.querySelectorAll('tr')).some(row => {
      if (!visible(row)) return false;
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      return cells.length >= 4 && /\b\d{10,}_\d+\b/.test(text(cells[0])) &&
        text(cells[0]).includes('短视频加热') && text(cells[cells.length - 1]).includes('更多');
    });
  }
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
  function currentItem() { return state.queue[state.index] || null; }
  function targetName(item) { return item?.targetName == null ? item?.name || '' : item.targetName; }
  function targetBudget(item) { return item?.targetBudget == null ? item?.budget : item.targetBudget; }
  function orderDraft(item) {
    const edit = state.edits[item.id] || {};
    return {name:edit.name == null ? item.name : edit.name, budget:edit.budget == null ? String(item.budget) : edit.budget};
  }
  function selectedDraftTotal() {
    try {
      const names=parseNames(state.names);
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
    return JSON.stringify([state.account, state.queue.map(x => [x.id, x.name, x.budget, targetName(x), targetBudget(x)])]);
  }
  function batchApprovalActive() {
    return !!state.approvedQueueKey && state.approvedQueueKey === queueApprovalKey();
  }
  function approvedFor(item) {
    return !!item && batchApprovalActive() && currentItem()?.id === item.id;
  }
  function pageNumber() { return Number(text(document.querySelector('.finder-ui-desktop-pagination__num_current'))) || 0; }
  function maxPage() { const nums = Array.from(document.querySelectorAll('.finder-ui-desktop-pagination__num')).map(x => Number(text(x))).filter(Number.isInteger); return Math.max(1, ...nums); }

  function readRows() {
    if (!onList()) throw new Error('请打开标准订单列表');
    return Array.from(document.querySelectorAll('tr')).filter(visible).map(row => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      if (cells.length < 4) return null;
      const first = text(cells[0]);
      const id = (first.match(/\b\d{10,}_\d+\b/) || [])[0];
      if (!id) return null;
      const name = text(cells[0].querySelector('.text-sm.font-medium.text-fg-0')) || first.split('短视频加热')[0].trim();
      const budgetMatch = text(cells[1]).match(/[￥¥]\s*[\d,.]+\s*\/\s*[￥¥]\s*([\d,.]+)/);
      return { id, name, budget: budgetMatch ? Number(budgetMatch[1].replace(/,/g, '')) : NaN,
        status: text(cells[2]), page: pageNumber(), row };
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
      const next = rows.map(x => x.id + ':' + x.name + ':' + x.budget).join('|');
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
  async function scanPages(names, collect, stopWhenId = '') {
    await waitUntil(() => onList() && pageNumber() > 0 && readRows().length > 0, '标准订单表加载', 20000);
    const total = maxPage();
    for (let page = 1; page <= total; page++) {
      if (page > 200) throw new Error('前 200 页仍未找齐订单，请先用平台筛选缩小范围');
      if (scanCancel) throw new Error('已停止扫描');
      ensureAccount();
      await gotoPage(page);
      const rows = await stableOrderPage(page);
      for (const row of rows) {
        if (stopWhenId && row.id === stopWhenId) return row;
        if (!stopWhenId && names.includes(row.name) && !collect.has(row.name)) collect.set(row.name, {
          id: row.id, name: row.name, budget: row.budget, status: row.status, page
        });
      }
      state.pageCount = page;
      if (!stopWhenId && collect.size === names.length) { save(); return null; }
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
      const input = shadow.getElementById('names');
      const names = parseNames(input.value);
      if (!names.length) throw new Error('请先输入要查找的完整订单名称');
      state.names = names.join('\n');
      state.account = accountName();
      if (!state.account) throw new Error('无法确认当前视频号账户');
      state.matches = []; state.choices = {}; state.edits = {}; state.scanComplete = false; state.pageCount = 0; state.lastSourcePage = 0;
      state.stage = 'scanning'; save();
      const found = new Map();
      await scanPages(names, found);
      state.matches = Array.from(found.values());
      state.choices = Object.fromEntries(state.matches.map(x => [x.name, x.id]));
      state.scanComplete = true;
      state.stage = 'ready'; state.settingsExpanded = true;
      log('扫描完成：' + state.pageCount + ' 页；每个名称只取最靠前的一条，找到 ' + state.matches.length + '/' + names.length + ' 个名称');
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
      ensureAccount();
      const names = parseNames(state.names), queue = [];
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
      log('已核对并授权本轮 ' + queue.length + ' 单自动提交；追投预算合计 ¥' + queue.reduce((sum,x)=>sum+targetBudget(x),0).toFixed(2));
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
    await waitUntil(() => onList() && pageNumber() > 0 && readRows().length > 0,
      '标准订单列表重新加载', 20000);
    const row = await locateSourceOrder(item);
    if (!row) throw new Error('找不到来源订单 ' + item.id + '，未按同名订单替代');
    if (row.name !== item.name || row.budget !== item.budget)
      throw new Error('来源订单信息与锁定记录不符：页面“' + row.name + '”/¥' +
        row.budget + '，锁定“' + item.name + '”/¥' + item.budget);
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
      log('已核对并授权本轮剩余订单自动提交；当前新单 ' + targetName(item) + '，预算 ¥' + targetBudget(item));
      tick();
    } catch (error) { fail(error.message); }
  }

  function reviewInfo() {
    const u = new URL(location.href);
    if (u.pathname !== '/promote/pages/platform/create-order' ||
        u.searchParams.get('orderType') !== 'standard') return null;
    const names = Array.from(document.querySelectorAll('input[placeholder="输入订单名称"]')).filter(visible);
    const cards = Array.from(document.querySelectorAll('.finder-card')).filter(card =>
      visible(card) && text(card).includes('需支付') &&
      text(card).includes('微信视频号企业账号加热功能服务协议'));
    if (names.length !== 1 || cards.length !== 1) return null;
    const card = cards[0];
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
  async function submitReviewedOrder() {
    if (currentItem()?.submittedAt) throw new Error('本单已点击过提交，请核对支付结果，禁止重复提交');
    await prepareNewForm();
    verifyReview();
    const { checkbox, label } = agreementBox();
    if (!checkbox.checked) {
      const clicker = label.closest('label') || checkbox;
      clicker.click();
    }
    await waitUntil(() => checkbox.isConnected && checkbox.checked,
      '协议勾选生效', 5000);
    const submit = one(Array.from(document.querySelectorAll('button')).filter(x => text(x) === '提交'), '订单提交按钮');
    await waitUntil(() => submit.isConnected && visible(submit) && !submit.disabled &&
      submit.getAttribute('aria-disabled') !== 'true' &&
      !submit.classList.contains('finder-ui-desktop-btn_disabled'),
      '平台提交按钮启用', 5000);
    // 勾选协议期间优惠券可能刷新，点击提交前再次核对预算与实际抵扣。
    verifyReview();
    currentItem().submittedAt = Date.now();
    state.stage = 'await_result'; save();
    submit.click();
    log('已点击提交：' + targetName(currentItem()) + '；追投预算 ¥' + targetBudget(currentItem()) + '；接下来等待你扫码支付');
    // 支付由人完成，定时器持续核对；不以固定 18 秒判定失败。
  }
  async function confirmAndSubmit() {
    if (busy || state.stage !== 'review') return;
    busy = true;
    try { await submitReviewedOrder(); }
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
    if (paidDetail()) state.stage = 'verifying_payment';
    else if (paymentPrompt()) state.stage = 'await_payment';
    else if (currentItem()?.submittedAt || ['await_result','await_payment'].includes(state.pausedFrom)) {
      state.stage = 'await_result';
    } else if (reviewInfo()) state.stage = 'review';
    else if (onList()) state.stage = 'locating';
    else { fail('当前页面无法识别，请先回到对应订单页面'); return; }
    state.pausedFrom = '';
    save(); tick();
  }
  function recover() {
    if (busy || state.stage !== 'needs_review') return;
    if (paymentPrompt()) state.stage = 'await_payment';
    else if (paidDetail()) state.stage = 'verifying_payment';
    else if (currentItem()?.submittedAt) state.stage = 'await_result';
    else if (reviewInfo()) state.stage = 'review';
    else if (onList() && currentItem()?.result === 'pending' &&
      (/“再来一单”(?:菜单等待超时|页面未打开)/.test(state.currentError) ||
       /来源订单(?:名称或预算已变|信息与锁定记录不符)/.test(state.currentError)))
      state.stage = 'locating';
    else { log('仍无法确认当前订单状态，请人工核对'); return; }
    state.currentError = ''; save(); tick();
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
    const selected = names.map(name => {
      const candidates = state.matches.filter(x => x.name === name);
      const chosen=candidates.find(x=>x.id===state.choices[name]);
      const draft=chosen?orderDraft(chosen):null,editable=state.stage==='ready'&&!busy;
      const editor=draft?`<div style="padding:7px 0"><label>新订单名称<input data-edit-id="${esc(chosen.id)}" data-edit-field="name" maxlength="25" value="${esc(draft.name)}" ${editable?'':'disabled'}></label><label>追投预算（元）<input type="number" inputmode="numeric" min="100" max="300000" step="100" data-edit-id="${esc(chosen.id)}" data-edit-field="budget" value="${esc(draft.budget)}" ${editable?'':'disabled'}></label><div class="muted">100～300000 元，且为 100 的整数倍；优惠券抵扣另行计算。</div><button class="btn small" data-default-id="${esc(chosen.id)}" ${editable?'':'disabled'}>恢复原名称与预算</button></div>`:'';
      return `<div class="group"><b>${esc(name)}</b> <span class="muted">${candidates.length} 条</span>${candidates.length ? candidates.map(x =>
        `<label class="candidate"><input type="radio" name="choice-${esc(name)}" data-name="${esc(name)}" value="${esc(x.id)}" ${state.choices[name] === x.id ? 'checked' : ''} ${editable?'':'disabled'}><span><b>${esc(x.id)}</b><br>${esc(x.status)} · 原预算 ¥${esc(x.budget)} · 第 ${x.page} 页</span></label>`).join('') : '<div class="muted">未找到，请核对名称或平台筛选条件。</div>'}${editor}</div>`;
    }).join('');
    const totalBudget = selectedDraftTotal();
    const queue = state.queue.map((x,i) => `<div class="queueItem ${i === state.index ? 'current' : ''}">${i+1}. ${esc(targetName(x))} · 追投 ¥${esc(targetBudget(x))}<br><span class="muted">来源：${esc(x.name)} · 原预算 ¥${esc(x.budget)}<br>${esc(x.id)} · ${esc(x.result)}</span></div>`).join('');
    let action = '';
    if (state.stage === 'awaiting_consent') action = `<div class="hint">当前队列尚未得到整批确认，或发生需重新核对的异常。请核对剩余订单及《微信视频号企业账号加热功能服务协议》；点击一次后，剩余订单将在每次手动支付成功后自动继续。</div><div class="row"><button class="btn primary" id="approve">我已核对剩余订单并同意协议，继续</button></div>`;
    if (state.stage === 'review') action = approvedFor(item)
      ? '<div class="hint">正在核对新单来源、名称及订单预算；优惠券抵扣后的需支付金额核对通过后自动提交。</div>'
      : `<div class="hint">本轮确认未生效，请核对新单名称与需支付金额，并阅读《微信视频号企业账号加热功能服务协议》；点击后助手会勾选协议并提交。</div><div class="row"><button class="btn primary" id="submit">我已阅读并同意协议，提交本单</button></div>`;
    if (state.stage === 'await_payment') action = '<div class="hint">请在平台扫码页面人工完成支付。助手只等待并核对支付后页面。</div>';
    if (state.stage === 'needs_review') action = `<div class="hint">${esc(state.currentError)}</div><div class="row"><button class="btn" id="recover">重新核对当前页面</button></div>`;
    if (state.stage === 'paused') action = '<div class="row"><button class="btn primary" id="resume">继续</button></div>';
    if (item?.submittedAt && ['await_result','await_payment','needs_review','paused'].includes(state.stage)) {
      action += '<div class="hint">如已付款但未识别，请先在平台核对新订单名称、预算及付款状态，返回标准订单列表后人工确认。此操作会跳过本单的自动核验。</div><div class="row"><button class="btn" id="manualPaid">已人工核实付款，完成本单</button></div>';
    }
    shadow.innerHTML = css + `<button class="launcher" id="launch" style="display:${open ? 'none' : 'block'}">加热助手</button><div class="panel ${editing ? 'editing' : ''}" style="display:${open ? 'flex' : 'none'}"><div class="head"><div><strong>视频号标准订单逐单加热助手</strong><small>v0.2.3 · 记住来源页码 / ID快速定位 · 人工支付</small></div><button id="min" title="最小化">−</button></div><div class="body">
      <div class="card"><div class="title">账户与进度</div><div class="muted">${esc(state.account || accountName() || '尚未锁定账户')}</div><div class="status">${esc({idle:'等待查找来源订单',scanning:'正在扫描第 '+state.pageCount+' 页',ready:'已预选各名称最靠前的订单，请核对',locating:'正在定位来源订单',awaiting_consent:'等待核对本轮剩余订单',opening:'正在打开“再来一单”',review:approvedFor(item) ? '正在核对新单并自动提交' : '等待核对本单并提交',submitting:'已点击提交，正在核实平台结果',await_result:'已提交，持续等待支付结果',await_payment:'等待你完成支付',verifying_payment:'支付后核对并返回列表',returning:'正在返回标准订单列表',needs_review:'已暂停，需核对当前结果',paused:'已暂停',complete:'队列全部完成'}[state.stage] || state.stage)}</div>${item ? `<div class="hint">新单：${esc(targetName(item))} · 追投预算 ¥${esc(targetBudget(item))}<br>来源：${esc(item.name)} · ${esc(item.id)} · 原预算 ¥${esc(item.budget)}${state.reviewAmount != null ? ' · 本单需支付 ¥'+esc(state.reviewAmount) : ''}</div>` : ''}${action}</div>
      <div class="card"><button id="toggleSettings" class="settingsToggle">${expanded ? '收起设置' : '展开设置'}</button><div class="title">来源订单与新单设置</div>${!expanded ? `<div class="settingsSummary">${state.queue.length ? '本轮已锁定 '+state.queue.length+' 单，新名称和追投预算可在下方队列查看。' : '展开后扫描订单、编辑新名称和追投预算。'}</div>` : ''}<div style="display:${expanded ? 'block' : 'none'};clear:both"><div class="muted">每行一个完整名称；首次扫描从第一页找齐；开始后优先记录页码定位来源 ID，未找到时继续向后查找。</div><textarea id="names" placeholder="增香液-1&#10;增香液-2&#10;增香液-3" ${!['idle','ready','complete'].includes(state.stage) ? 'disabled' : ''}>${esc(state.names)}</textarea><div class="row"><button class="btn" id="scan" ${busy || !['idle','ready','complete'].includes(state.stage) ? 'disabled' : ''}>扫描订单</button>${state.stage === 'scanning' ? '<button class="btn danger" id="cancelScan">停止扫描</button>' : ''}</div>${state.matches.length || state.scanComplete ? `<div class="muted" style="margin:8px 0">已扫描 ${state.pageCount} 页，找到 ${state.matches.length}/${names.length} 个名称</div><div class="list">${selected}</div>${state.stage === 'ready' ? `<div class="hint">请核对本轮 ${names.length} 单的来源编号、新订单名称和追投预算。<span id="targetTotal">${totalBudget == null ? '请检查新名称及追投预算' : '追投预算合计 ¥' + totalBudget.toFixed(2)}</span>。点击开始表示你已阅读并同意《微信视频号企业账号加热功能服务协议》；助手将逐单核实新单金额后自动勾选协议和提交，每单支付仍由你手动完成。</div>` : ''}<div class="row"><button class="btn primary" id="start" ${state.stage !== 'ready' ? 'disabled' : ''}>我已核对本轮订单并同意协议，开始逐单提交</button></div>` : ''}</div>
      </div><div class="card"><div class="title">逐单队列</div>${queue || '<div class="muted">尚未选择来源订单</div>'}<div class="row"><button class="btn danger" id="pause" ${!['locating','awaiting_consent','opening','review','await_result','await_payment'].includes(state.stage) ? 'disabled' : ''}>暂停</button><button class="btn" id="reset">清空队列</button></div></div>
      <div class="card"><div class="title">执行记录</div><div class="log">${esc(state.logs.slice(-35).join('\n') || '尚无记录')}</div><div class="row"><button class="btn" id="copy">复制记录</button></div></div>
      </div></div>`;
    shadow.getElementById('launch').onclick = () => { open = true; render(); };
    shadow.getElementById('min').onclick = () => { open = false; render(); };
    shadow.getElementById('scan').onclick = scan;
    shadow.getElementById('start')?.addEventListener('click', startQueue);
    shadow.getElementById('toggleSettings')?.addEventListener('click',()=>{state.settingsExpanded=!expanded;save();});
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
