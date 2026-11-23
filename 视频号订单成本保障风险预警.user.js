// ==UserScript==
// @name         视频号订单成本保障风险预警
// @namespace    local.channels.cost-protection-risk
// @version      0.1.0
// @description  扫描在投标准订单，估算成交出价订单的成本保障风险并由用户决定是否发起结束
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
  const defaults = Object.assign({ roiMinimum: '1.0' }, GM_getValue(PREF_KEY, {}) || {});
  const state = { scanning: false, page: 0, totalPages: 0, account: '', rows: [], error: '' };
  const host = document.createElement('div');
  host.id = ROOT;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const css = `<style>
    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
    .launcher{pointer-events:auto;position:fixed;right:0;top:42%;width:36px;min-height:138px;padding:10px 7px;border:1px solid #b8d4ef;border-right:0;border-radius:9px 0 0 9px;background:#147d64;color:#fff;font:700 13px/1.35 sans-serif;writing-mode:vertical-rl}
    .panel{pointer-events:auto;position:fixed;right:12px;top:12px;width:min(480px,calc(100vw - 24px));height:min(780px,calc(100dvh - 24px));display:flex;flex-direction:column;border:1px solid #d6e0e8;border-radius:8px;background:#f8fafb;color:#19252d;box-shadow:0 12px 36px #182b3d33;overflow:hidden;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}
    .head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#fff;border-bottom:1px solid #e2e8ed}.head strong{font-size:15px}.head small{display:block;color:#657580;font-size:11px}.head button{width:30px;height:30px;border:0;border-radius:4px;background:#edf2f5;color:#34434c;font-size:18px}
    .body{min-height:0;overflow:auto;padding:12px}.section{padding:10px 0;border-bottom:1px solid #e0e6ea}.row{display:flex;gap:8px;align-items:center;margin:8px 0}.row label{flex:1}.row input{width:90px;padding:7px;border:1px solid #bbc9d2;border-radius:4px;background:white}.btn{border:1px solid #b9c9d3;border-radius:4px;padding:7px 10px;background:white;color:#1b604f;font-weight:700}.btn.primary{background:#147d64;border-color:#147d64;color:#fff}.btn.danger{color:#b3261e;border-color:#e6aaa6}.muted{color:#5e6d76;font-size:11px}.status{padding:8px 9px;background:#eaf3f7;border-radius:4px;font-weight:700;overflow-wrap:anywhere}.list{margin-top:8px}.item{padding:9px 0;border-bottom:1px solid #dfe6ea}.item b{overflow-wrap:anywhere}.item .meta{margin-top:3px;color:#42525c;font-size:11px;overflow-wrap:anywhere}.item .flag{font-weight:700;color:#a44915}.item button{margin-top:6px}.error{color:#a12622;font-weight:700}
  </style>`;
  let open = false;

  function clean(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' '); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function visible(el) { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; }
  function number(value) {
    const normalized = clean(value).normalize('NFKC').replace(/[￥¥元,\s]/g, '');
    if (!/^-?(?:\d+|\d*\.\d+)$/.test(normalized)) return null;
    const parsed = Number(normalized);
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
      const roi = number(cells[index('直接成交ROI')]?.innerText);
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
    const nums = [...document.querySelectorAll('.finder-ui-desktop-pagination__num')].map(el => Number(clean(el.innerText))).filter(Number.isInteger);
    return Math.max(1, ...nums);
  }
  function setInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('无法操作平台页码输入框');
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles:true }));
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }
  async function waitForPage(page) {
    const deadline = Date.now() + 15000;
    let last = '';
    let stable = 0;
    while (Date.now() < deadline) {
      if (!isList()) throw new Error('扫描期间已离开标准订单列表');
      if (pageNumber() === page) {
        const rows = readRows();
        const sig = rows.map(row => row.id + ':' + row.spent).join('|');
        if (sig && sig === last) { if (!stable) stable = Date.now(); if (Date.now() - stable >= 350) return rows; }
        else { last = sig; stable = 0; }
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('等待第 ' + page + ' 页订单加载超时');
  }
  async function gotoPage(target) {
    if (pageNumber() === target) return waitForPage(target);
    const pager = document.querySelector('.finder-ui-desktop-pagination');
    const input = pager?.querySelector('input.finder-ui-desktop-pagination__input');
    const jump = [...(pager?.querySelectorAll('a,button') || [])].find(el => clean(el.innerText) === '跳转');
    if (!input || !jump) throw new Error('找不到平台订单分页跳转控件');
    setInput(input, target);
    jump.click();
    return waitForPage(target);
  }
  function assess(row, minimumRoi) {
    const active = /加热中|投放中/.test(row.status) && !/已结束|已取消|审核未通过/.test(row.status);
    const lowRoi = Number.isFinite(row.roi) && row.roi < minimumRoi;
    if (!active || !lowRoi) return null;
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
    const threshold = Number(defaults.roiMinimum);
    if (!Number.isFinite(threshold) || threshold < 0) return [];
    return allActiveRows().map(row => assess(row, threshold)).filter(Boolean);
  }
  async function scan() {
    if (state.scanning) return;
    if (!isList()) { state.error = '请先进入视频号加热平台 → 订单管理 → 标准订单'; render(); return; }
    state.scanning = true; state.error = ''; state.rows = []; state.page = 0;
    const account = accountName();
    if (!account) { state.scanning = false; state.error = '未读到账户名称，请确认平台页面已加载'; render(); return; }
    state.account = account;
    const startPage = pageNumber();
    try {
      const pages = maxPage();
      if (pages > 200) throw new Error('订单页数超过200，请先用平台筛选缩小范围');
      state.totalPages = pages;
      const found = new Map();
      for (let page = 1; page <= pages; page++) {
        if (!isList() || accountName() !== account) throw new Error('扫描期间页面或账户发生变化，已停止');
        const rows = await gotoPage(page);
        for (const row of rows) found.set(row.id, { ...row, page });
        state.rows = [...found.values()]; state.page = page; render();
      }
      state.rows = [...found.values()];
    } catch (error) { state.error = error.message; }
    finally {
      if (isList() && accountName() === account && pageNumber() !== startPage) await gotoPage(startPage).catch(() => {});
      state.scanning = false; render();
    }
  }
  async function startEndFlow(id) {
    const item = candidates().find(row => row.id === id);
    if (!item || !item.risk || state.scanning) return;
    if (!confirm(`将定位订单 ${item.id}（${item.name}），并打开平台“结束订单”流程。脚本不会点击平台最终确认按钮。继续？`)) return;
    if (!isList() || accountName() !== state.account) { state.error = '账户或页面已变化，请重新扫描'; render(); return; }
    try {
      const freshRows = await gotoPage(item.page);
      const fresh = freshRows.find(row => row.id === id);
      if (!fresh || fresh.status !== item.status || fresh.roi !== item.roi || fresh.spent !== item.spent || fresh.budget !== item.budget) {
        throw new Error('订单状态或指标已变化，请重新扫描并复核');
      }
      const more = [...fresh.row.querySelectorAll('a')].find(anchor => clean(anchor.innerText) === '更多');
      if (!more) throw new Error('找不到该订单的“更多”操作');
      const wrapper = more.closest('.finder-ui-desktop-popover__wrp');
      if (!wrapper) throw new Error('订单操作菜单结构已变化');
      if (typeof PointerEvent === 'function') {
        wrapper.dispatchEvent(new PointerEvent('pointerenter', { bubbles:true }));
        wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles:true }));
      }
      wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles:true }));
      wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles:true }));
      more.dispatchEvent(new MouseEvent('mouseenter', { bubbles:true }));
      more.dispatchEvent(new MouseEvent('mouseover', { bubbles:true }));
      const findEndAction = () => [...document.querySelectorAll('.finder-ui-desktop-popover__desc *')]
        .filter(el => visible(el) && el.children.length === 0 && clean(el.innerText) === '结束订单');
      let endActions = findEndAction();
      if (!endActions.length) {
        more.click();
        const deadline = Date.now() + 5000;
        while (!endActions.length && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          endActions = findEndAction();
        }
      }
      if (endActions.length !== 1) throw new Error('未能唯一确认平台“结束订单”菜单项；请在平台手动处理');
      endActions[0].click();
      state.error = `已为 ${id} 打开平台结束订单确认流程；请核对弹窗信息，由你完成最终确认。`;
    } catch (error) { state.error = error.message; }
    render();
  }
  function render() {
    const list = candidates();
    const activeCount = allActiveRows().length;
    const resultHtml = list.length ? list.map(row => {
      const est = row.estimate;
      const metrics = est
        ? `直接成交 ROI ${row.roi} · 出价 ¥${row.bid} · 消耗 ¥${row.spent}/¥${row.budget} · 成交 ${row.count} · 当前成交成本约 ¥${est.currentCPA.toFixed(2)} · 预计消耗/预期消耗 ${(est.ratio * 100).toFixed(1)}%`
        : `直接成交 ROI ${row.roi ?? '未读到'} · 出价 ${esc(row.bidText)} · 消耗 ¥${row.spent ?? '未读到'}/¥${row.budget ?? '未读到'} · ${row.note}`;
      return `<article class="item"><b>${esc(row.name || '未命名')} · ${esc(row.id)}</b><div class="meta">${esc(row.promoteType)} · 第 ${row.page} 页 · ${esc(row.status)}</div><div class="meta">${metrics}</div><div class="meta flag">${esc(row.note)}</div>${row.risk ? `<button class="btn danger" data-end="${esc(row.id)}">核对后打开结束流程</button>` : ''}</article>`;
    }).join('') : '<div class="muted">当前没有符合 ROI 条件的在投订单。扫描后会保留 ROI 出价订单的“估算不足”记录。</div>';
    shadow.innerHTML = css + `<button id="launch" class="launcher" style="display:${open ? 'none' : 'block'}">成本风险</button><section class="panel" style="display:${open ? 'flex' : 'none'}"><header class="head"><div><strong>视频号成本保障风险预警</strong><small>趋势估算，不代表平台确认赔付</small></div><button id="min" title="最小化">−</button></header><main class="body"><div class="section"><div><b>账户</b>：${esc(state.account || accountName() || '未识别')}</div><div class="row"><label>低于该直接成交 ROI 时检查</label><input id="minimum" inputmode="decimal" value="${esc(defaults.roiMinimum)}" ${state.scanning?'disabled':''}></div><div class="row"><button class="btn primary" id="scan" ${state.scanning?'disabled':''}>${state.scanning?`扫描第 ${state.page}/${state.totalPages} 页`:'扫描全部在投订单'}</button></div><div class="muted">估算适用于按元成交出价：用当前消耗/直接成交订单数估算成交成本，并假设后续表现不变。超成本线必须严格高于120%。直接成交订单数不等同平台确认的有效成交数。</div></div><div class="section"><b>结果</b><div class="status">已扫描 ${state.rows.length} 单 · 当前在投 ${activeCount} 单 · ROI 低于阈值 ${list.length} 单</div><div class="muted">预测比值超过120%才显示“核对后打开结束流程”。常见的300元消耗和2次有效成交门槛、支付方式、控成本加热及审核资格无法仅凭列表确认；ROI出价订单不套用成交出价公式。</div>${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}<div class="list">${resultHtml}</div></div><div class="section muted">结束流程会再次核对订单编号和扫描时的状态、ROI、消耗、预算。脚本仅打开平台结束确认；最终结束由你在平台弹窗中完成。</div></main></section>`;
    shadow.querySelector('#launch')?.addEventListener('click', () => { open = true; render(); });
    shadow.querySelector('#min')?.addEventListener('click', () => { open = false; render(); });
    shadow.querySelector('#scan')?.addEventListener('click', () => {
      const value = shadow.querySelector('#minimum')?.value.trim();
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) { state.error = 'ROI阈值须为0或正数'; render(); return; }
      defaults.roiMinimum = String(parsed); GM_setValue(PREF_KEY, defaults);
      scan();
    });
    shadow.querySelectorAll('[data-end]').forEach(button => button.addEventListener('click', () => startEndFlow(button.dataset.end)));
  }

  render();
})();
