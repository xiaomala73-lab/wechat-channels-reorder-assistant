// ==UserScript==
// @name         千川调控助手
// @namespace    local.qianchuan.task-governor
// @version      0.1.11
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-windows.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-windows.user.js
// @description  直播高ROI任务追加预算，支持因任务预算不足暂停的任务；低ROI删除；先检查本页再执行
// @match        https://qianchuan.jinritemai.com/overall-prom*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const ROOT = 'qc-task-governor-root';
  if (window.top !== window.self || document.getElementById(ROOT)) return;
  const host = document.createElement('div');
  host.id = ROOT;
  host.style.cssText = 'position:fixed;right:0;top:62%;z-index:2147483646;padding:9px;background:#eaf3ff;color:#175aaf;border-radius:10px 0 0 10px;font:12px sans-serif;pointer-events:auto';
  host.textContent = '调控助手正在启动';
  document.documentElement.appendChild(host);

  try {
    const CFG_KEY = 'qc-task-governor-config-v1';
    const TAB_KEY = 'qc-task-governor-tab-v1';
    const LOCK_PREFIX = 'qc-task-governor-lock-v1-';
    const REPORT_PREFIX = 'qc-task-governor-report-v1-';
    const LAUNCHER_KEY = 'qc-task-governor-launcher-top-v1';
    const MAX_PREVIEW_AGE = 2 * 60 * 1000;
    let tabToken = '';
    try {
      tabToken = sessionStorage.getItem(TAB_KEY) || '';
      if (!tabToken) {
        tabToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem(TAB_KEY, tabToken);
      }
    } catch (_) { /* 刷新后无法可靠恢复当前标签页锁定时要求重新锁定 */ }
    const cfg = Object.assign({ action: '', liveDeleteRoi: '', liveBudgetRoi: '',
      gap: '', add: '', productMarketingRoi: '', productPaymentRoi: '' }, GM_getValue(CFG_KEY, {}));
    if (cfg.productMarketingRoi === '' && cfg.productDeleteRoi !== undefined) cfg.productMarketingRoi = cfg.productDeleteRoi;
    if (cfg.productPaymentRoi === '' && cfg.productDeleteRoi !== undefined) cfg.productPaymentRoi = cfg.productDeleteRoi;
    delete cfg.productDeleteRoi;
    const state = {
      open: false, busy: false, stop: false, phase: '请进入计划详情并锁定当前计划',
      lock: tabToken ? GM_getValue(LOCK_PREFIX + tabToken, null) : null,
      preview: null, logs: [], report: tabToken ? GM_getValue(REPORT_PREFIX + tabToken, '') : '',
      scrollTop: 0, launcherTop: Math.max(12, Math.min(88, Number(GM_getValue(LAUNCHER_KEY, 62)) || 62))
    };
    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
    function number(value, label, positive = false) {
      const raw = String(value == null ? '' : value).trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error(label + '须填写最多两位小数的非负数');
      const n = Number(raw);
      if (!Number.isFinite(n) || (positive && n <= 0)) throw new Error(label + '须大于 0');
      return n;
    }
    function cents(value, label, positive = false) {
      return Math.round(number(value, label, positive) * 100);
    }
    function parseMoney(value) {
      const s = String(value == null ? '' : value).replace(/,/g, '').trim();
      return /^\d+(?:\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN;
    }
    function parseRoi(value) {
      const s = String(value == null ? '' : value).replace(/,/g, '').trim();
      return /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN;
    }
    function dashRoi(value) {
      return /^[-—–−－]+$/.test(String(value == null ? '' : value).trim());
    }
    function yuan(value) { return (value / 100).toFixed(2); }
    function log(message) {
      const line = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + message;
      state.logs.push(line);
      state.logs = state.logs.slice(-100);
      render();
    }
    function phase(message) { state.phase = message; render(); }
    function report(message) {
      const lock = state.lock;
      state.report = [
        '千川调控助手',
        lock ? '账户：' + lock.accountId + '；计划：' + lock.planName + '（' + lock.planId + '）' : '尚未锁定计划',
        '结果：' + message, '', ...state.logs.slice(-60)
      ].join('\n');
      if (tabToken) GM_setValue(REPORT_PREFIX + tabToken, state.report);
      render();
    }
    function urlInfo() {
      const u = new URL(location.href);
      const hash = new URLSearchParams(u.hash.replace(/^#\??/, ''));
      const kind = hash.get('marGoal') === '2' ? 'live' : hash.get('marGoal') === '1' ? 'product' : '';
      if (u.origin !== 'https://qianchuan.jinritemai.com' ||
          !['/overall-prom', '/overall-prom/detail'].includes(u.pathname) ||
          u.searchParams.get('campaignType') !== '1' || u.searchParams.get('uniTab') !== 'ad' ||
          !/^\d+$/.test(u.searchParams.get('aavid') || '') || !kind) {
        throw new Error('请进入千川乘方的推直播或推商品计划页');
      }
      const planId = u.searchParams.get('adId') || '';
      return { accountId: u.searchParams.get('aavid'), planId,
        detail: /^\d+$/.test(planId), kind };
    }
    function detailIdentity() {
      const u = urlInfo();
      // 推商品详情以 /overall-prom?adId=... 抽屉显示，不一定切换到 /detail 路径。
      if (!/^\d+$/.test(u.planId)) throw new Error('请先打开一条计划的详情页');
      const drawer = one(document.querySelectorAll('.ad-detail-wrapper'), '计划详情');
      const intro = text(drawer).slice(0, 650);
      if (!new RegExp('(?:计划)?ID[：:]\\s*' + u.planId + '(?!\\d)').test(intro)) {
        throw new Error('详情中的计划 ID 与网址不一致');
      }
      const name = text(drawer.querySelector('[class*="detailHeader-"] [class*="title-"]'));
      if (!name) throw new Error('未能读取当前计划名称');
      if (!/投放中/.test(intro)) throw new Error('当前计划未显示投放中');
      return { ...u, planName: name, drawer };
    }
    function assertLock() {
      if (!state.lock) throw new Error('请先锁定当前计划');
      const d = detailIdentity();
      if (d.accountId !== state.lock.accountId || d.planId !== state.lock.planId ||
          d.kind !== state.lock.kind || d.planName !== state.lock.planName) {
        throw new Error('账户或计划已切换，请重新锁定');
      }
      return d;
    }
    function lockCurrent() {
      try {
        if (state.busy) throw new Error('正在执行，暂不能更换计划');
        readCfg();
        const d = detailIdentity();
        state.lock = { accountId: d.accountId, planId: d.planId,
          planName: d.planName, kind: d.kind };
        if (tabToken) GM_setValue(LOCK_PREFIX + tabToken, state.lock);
        state.preview = null;
        phase('已锁定' + (d.kind === 'live' ? '推直播' : '推商品') + '计划');
        log('锁定 ' + d.planName + '（' + d.planId + '）');
      } catch (error) { phase('锁定失败：' + error.message); }
    }
    async function wait(check, label, timeout = 16000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (state.stop) throw new Error('用户已停止本轮操作');
        const value = check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(label + '等待超时');
    }
    function actionKind() {
      const a = cfg.action;
      const d = assertLock();
      if (a === 'live-delete' || a === 'live-budget') {
        if (d.kind !== 'live') throw new Error('当前不是推直播计划');
      } else if (a === 'product-delete') {
        if (d.kind !== 'product') throw new Error('当前不是推商品计划');
      } else throw new Error('请先选择操作');
      return a;
    }
    async function openTaskView() {
      let d = assertLock();
      if (d.kind === 'live' && /已选\s*\d+\s*个?\s*任务/.test(text(d.drawer).slice(0, 1200))) {
        throw new Error('页面已有勾选任务，请先取消勾选再检查本页');
      }
      const tab = d.drawer.querySelector('[id$="-tab-uni_task_center"]');
      if (!tab) throw new Error('未找到计划详情中的“调控”标签');
      if (tab.getAttribute('aria-selected') !== 'true') {
        tab.click();
        await wait(() => {
          try { return assertLock().drawer.querySelector('[id$="-tab-uni_task_center"][aria-selected="true"]'); }
          catch (_) { return null; }
        }, '调控标签');
      }
      d = assertLock();
      const expected = d.kind === 'live' ? '素材/人群追投' : '素材追投';
      const option = await wait(() => Array.from(d.drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .find(x => visible(x) && text(x) === expected), expected + '标签');
      if (!option.classList.contains('main-vmok-plugin-radio-item--checked')) option.click();
      let lastTableError = null;
      try {
        await wait(() => {
          try { return taskTable().rows; }
          catch (error) { lastTableError = error; return null; }
        }, expected + '任务表', 20000);
      } catch (error) {
        if (lastTableError && /等待超时/.test(error.message)) {
          throw new Error(expected + '任务表未就绪：' + lastTableError.message);
        }
        throw error;
      }
      return assertLock();
    }
    function taskTable() {
      const d = assertLock();
      const selected = Array.from(d.drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .filter(x => visible(x) && x.classList.contains('main-vmok-plugin-radio-item--checked'));
      const expected = d.kind === 'live' ? '素材/人群追投' : '素材追投';
      const normalView = selected.length === 1 && text(selected[0]) === expected;
      // 千川勾选直播任务后会用“已选 N 个任务”操作栏替换顶部类型标签，表格仍是同一张表。
      const batchView = d.kind === 'live' && /已选\s*\d+\s*个?\s*任务/.test(text(d.drawer).slice(0,1200));
      if (!normalView && !batchView) throw new Error('当前不是“' + expected + '”列表');
      const tables = Array.from(d.drawer.querySelectorAll('table.main-vmok-plugin-table')).filter(visible);
      const header = tables.find(t => Array.from(t.querySelectorAll('thead th')).some(x => text(x) === '任务名称'));
      if (!header) throw new Error('任务表表头未加载');
      const labels = Array.from(header.querySelectorAll('thead tr:first-child th')).map(text);
      const required = d.kind === 'live' ? ['任务名称', '调控状态', '调控预算(元)', '调控消耗'] :
        ['任务名称', '调控状态', '调控综合成本', '调控消耗'];
      const column = {};
      const normalized = value => value.replace(/\s+/g, '').replace(/[（(]元[）)]/g, '');
      for (const label of required) {
        const positions = labels.map((x, i) => normalized(x) === normalized(label) ? i : -1).filter(i => i >= 0);
        if (positions.length !== 1) throw new Error('缺少唯一的“' + label + '”列');
        column[label] = positions[0];
      }
      const roiOptions = d.kind === 'live' ? ['调控支付ROI'] : ['调控综合营销ROI', '调控支付ROI'];
      const roiLabels = [];
      for (const label of roiOptions) {
        const positions = labels.map((value, index) => value === label ? index : -1).filter(index => index >= 0);
        if (positions.length > 1) throw new Error('任务表中“' + label + '”列重复');
        if (positions.length === 1) { column[label] = positions[0]; roiLabels.push(label); }
      }
      if (d.kind === 'live' && !roiLabels.includes('调控支付ROI')) throw new Error('任务表缺少“调控支付ROI”列');
      if (d.kind === 'product' && !roiLabels.length) throw new Error('任务表没有可用的调控 ROI 列');
      const body = tables.find(t => t !== header && t.querySelector('tbody tr.main-vmok-plugin-tr'));
      if (!body && !/共\s*0\s*条/.test(text(d.drawer))) throw new Error('任务数据仍在加载');
      const rows = body ? Array.from(body.querySelectorAll('tbody tr.main-vmok-plugin-tr')) : [];
      const footer = d.drawer.querySelector('.main-vmok-plugin-oc-pagination-wrapper');
      const active = footer && footer.querySelector('.main-vmok-plugin-page-turner__item--active');
      const page = active ? text(active) : '1';
      const sizeInput = footer && footer.querySelector('.main-vmok-plugin-select--xs input');
      const size = sizeInput ? sizeInput.value : '';
      return { d, rows, column, roiLabels, page, size };
    }
    function readRows(table) {
      return table.rows.map(row => {
        const cells = Array.from(row.querySelectorAll(':scope > td'));
        const nameCell = cells[table.column['任务名称']];
        const rawName = text(nameCell);
        const id = (rawName.match(/ID[：:]\s*(\d+)/) || [])[1];
        if (!id || cells.length <= Math.max(...Object.values(table.column))) throw new Error('任务行 ID 或列数异常');
        const status = text(cells[table.column['调控状态']]);
        const budget = table.d.kind === 'live' ? parseMoney(text(cells[table.column['调控预算(元)']])) : NaN;
        const comprehensiveCost = table.d.kind === 'product' ?
          parseMoney(text(cells[table.column['调控综合成本']])) : NaN;
        const spend = parseMoney(text(cells[table.column['调控消耗']]));
        const marketingRaw = Number.isInteger(table.column['调控综合营销ROI']) ?
          text(cells[table.column['调控综合营销ROI']]) : '';
        const paymentRaw = Number.isInteger(table.column['调控支付ROI']) ?
          text(cells[table.column['调控支付ROI']]) : '';
        const marketingRoi = parseRoi(marketingRaw);
        const paymentRoi = parseRoi(paymentRaw);
        const roi = table.d.kind === 'live' ? paymentRoi : NaN;
        return { id, name: rawName.replace(/\s*ID[：:]\s*\d+[\s\S]*$/, '').trim(),
          status, budget, comprehensiveCost, spend, roi, marketingRoi, paymentRoi,
          marketingRoiDash: dashRoi(marketingRaw), paymentRoiDash: dashRoi(paymentRaw), row };
      });
    }
    function readCfg() {
      for (const [key, id] of [['action', 'action'], ['liveDeleteRoi', 'live-delete-roi'],
        ['liveBudgetRoi', 'live-budget-roi'], ['gap', 'gap'], ['add', 'add'],
        ['productMarketingRoi', 'product-marketing-roi'], ['productPaymentRoi', 'product-payment-roi']]) {
        const el = shadow.getElementById(id);
        if (el) cfg[key] = el.value;
      }
      GM_setValue(CFG_KEY, cfg);
    }
    function settings() {
      readCfg();
      const action = actionKind();
      if (action === 'live-delete') return { action, roi: number(cfg.liveDeleteRoi, '直播删除 ROI 阈值') };
      if (action === 'product-delete') return { action,
        marketingRoi: number(cfg.productMarketingRoi, '综合营销 ROI 阈值'),
        paymentRoi: number(cfg.productPaymentRoi, '支付 ROI 阈值') };
      return { action, roi: number(cfg.liveBudgetRoi, '追加预算 ROI 下限'),
        gap: cents(cfg.gap, '预算与消耗差值'), add: cents(cfg.add, '每次追加金额', true) };
    }
    function eligible(item, params) {
      if (params.action === 'product-delete') {
        if (!Number.isSafeInteger(item.comprehensiveCost) || item.comprehensiveCost <= 0 ||
            !Number.isSafeInteger(item.spend) || item.spend <= 0) return false;
        return item.marketingRoiDash || item.paymentRoiDash ||
          (Number.isFinite(item.marketingRoi) && item.marketingRoi < params.marketingRoi) ||
          (Number.isFinite(item.paymentRoi) && item.paymentRoi < params.paymentRoi);
      }
      if (!Number.isFinite(item.roi)) return false;
      if (params.action === 'live-delete') return /调控中/.test(item.status) && item.roi < params.roi;
      if (params.action !== 'live-budget') return false;
      const status = (item.status || '').replace(/\s+/g, '');
      const budgetPaused = /已暂停/.test(status) && /任务预算不足/.test(status) &&
        !/手动|人工|已结束|调控结束|已终止|已取消|账户余额不足/.test(status);
      return Number.isSafeInteger(item.budget) && item.budget >= 0 &&
        Number.isSafeInteger(item.spend) && item.spend >= 0 && item.roi >= params.roi &&
        (budgetPaused || (/调控中/.test(status) && item.budget - item.spend < params.gap));
    }
    function sameValues(a, b) {
      const equalNumber = (x, y) => x === y || (Number.isNaN(x) && Number.isNaN(y));
      return a.id === b.id && a.status === b.status && equalNumber(a.roi, b.roi) &&
        equalNumber(a.marketingRoi, b.marketingRoi) && equalNumber(a.paymentRoi, b.paymentRoi) &&
        a.marketingRoiDash === b.marketingRoiDash && a.paymentRoiDash === b.paymentRoiDash &&
        equalNumber(a.budget, b.budget) && equalNumber(a.comprehensiveCost, b.comprehensiveCost) &&
        equalNumber(a.spend, b.spend);
    }
    function rowsById(table) {
      const items = readRows(table), map = new Map();
      for (const item of items) {
        if (map.has(item.id)) throw new Error('本页出现重复任务 ID');
        map.set(item.id, item);
      }
      return map;
    }
    async function previewPage() {
      if (state.busy) return;
      readCfg();
      state.busy = true; state.stop = false; state.preview = null; render();
      try {
        const params = settings();
        await openTaskView();
        const table = taskTable(), items = readRows(table);
        const targets = items.filter(x => eligible(x, params)).map(x => ({
          id: x.id, name: x.name, status: x.status, roi: x.roi,
          marketingRoi: x.marketingRoi, paymentRoi: x.paymentRoi,
          marketingRoiDash: x.marketingRoiDash, paymentRoiDash: x.paymentRoiDash,
          budget: x.budget, comprehensiveCost: x.comprehensiveCost, spend: x.spend
        }));
        state.preview = { params, targets, page: table.page, size: table.size,
          roiLabels: table.roiLabels,
          accountId: table.d.accountId, planId: table.d.planId, kind: table.d.kind,
          at: Date.now() };
        phase('本页 ' + items.length + ' 条任务，符合条件 ' + targets.length + ' 条；请核对下方清单');
        log('检查第 ' + table.page + ' 页：' + targets.length + ' 条符合“' + params.action + '”条件；ROI 列：' + table.roiLabels.join('、') +
          (params.action === 'product-delete' ? '；综合成本和消耗均大于 0，任一 ROI 为“—”或低于阈值：综合营销 ' + params.marketingRoi + '、支付 ' + params.paymentRoi : ''));
        report('已生成本页预览；尚未修改千川任务');
      } catch (error) { phase('检查失败：' + error.message); report(error.message); }
      finally { state.busy = false; render(); }
    }
    function currentPreview() {
      const p = state.preview;
      if (!p || !p.targets.length) throw new Error('请先检查本页，且确认存在符合条件的任务');
      if (Date.now() - p.at > MAX_PREVIEW_AGE) throw new Error('预览已超过 2 分钟，请重新检查');
      const params = settings();
      if (JSON.stringify(params) !== JSON.stringify(p.params)) throw new Error('条件已改变，请重新检查');
      const t = taskTable();
      if (t.d.accountId !== p.accountId || t.d.planId !== p.planId || t.d.kind !== p.kind ||
          JSON.stringify(t.roiLabels) !== JSON.stringify(p.roiLabels) ||
          t.page !== p.page || t.size !== p.size) throw new Error('计划或页码已变化，请重新检查');
      const map = rowsById(t);
      for (const old of p.targets) {
        const fresh = map.get(old.id);
        if (!fresh || !sameValues(old, fresh) || !eligible(fresh, params)) {
          throw new Error('任务 ' + old.id + ' 的状态或数据已变化，请重新检查');
        }
      }
      return { p, t };
    }
    function taskById(id) {
      const table = taskTable();
      return rowsById(table).get(id) || null;
    }
    function visibleDeleteModal(expected) {
      const modals = Array.from(document.querySelectorAll('.main-vmok-plugin-modal')).filter(visible);
      return one(modals.filter(m => text(m).includes(expected) && text(m).includes('删除后不可恢复')),
        '千川删除确认弹窗');
    }
    async function confirmDelete(expected) {
      const modal = await wait(() => {
        try { return visibleDeleteModal(expected); } catch (_) { return null; }
      }, '删除确认弹窗', 8000);
      const yes = one(Array.from(modal.querySelectorAll('button')).filter(b => text(b) === '确定'), '删除确认按钮');
      yes.click();
      return modal;
    }
    async function waitRemoved(ids) {
      await wait(() => {
        try {
          const table = taskTable();
          const found = rowsById(table);
          return ids.every(id => !found.has(id));
        } catch (_) { return false; }
      }, '删除后任务列表更新', 20000);
    }
    async function deleteLive(p) {
      const selectedByScript = [];
      const selected = readRows(taskTable()).filter(x => x.row.querySelector('input[type="checkbox"]')?.checked);
      if (selected.length) throw new Error('页面已有勾选任务，请先清空勾选再执行');
      let submitted = false;
      try {
        for (const old of p.targets) {
          if (state.stop) throw new Error('用户已停止本轮操作');
          const fresh = taskById(old.id);
          if (!fresh || !sameValues(old, fresh)) throw new Error('任务 ' + old.id + ' 已变化');
          const box = one(fresh.row.querySelectorAll('input[type="checkbox"]'), '任务 ' + old.id + ' 的勾选框');
          box.click(); selectedByScript.push(old.id);
          await wait(() => {
            try {
              const checked = new Set(readRows(taskTable())
                .filter(x => x.row.querySelector('input[type="checkbox"]')?.checked).map(x => x.id));
              return selectedByScript.every(id => checked.has(id));
            } catch (_) { return false; }
          }, '任务 ' + old.id + ' 勾选后列表稳定', 6000);
        }
        const now = readRows(taskTable()).filter(x => x.row.querySelector('input[type="checkbox"]')?.checked).map(x => x.id);
        if (now.length !== p.targets.length || now.some(id => !selectedByScript.includes(id))) {
          throw new Error('实际勾选任务与预览不一致');
        }
        assertLock();
        const button = one(Array.from(document.querySelectorAll('button,[role="button"]'))
          .filter(b => text(b) === '删除'), '顶部批量删除按钮');
        button.click();
        const expected = '确定删除所选的' + p.targets.length + '条任务吗？';
        const modal = await wait(() => {
          try { return visibleDeleteModal(expected); } catch (_) { return null; }
        }, '批量删除确认弹窗', 8000);
        if (!text(modal).includes(expected)) throw new Error('千川确认数量与预览不一致');
        if (state.stop) throw new Error('用户已停止本轮操作');
        await confirmDelete(expected);
        submitted = true;
        await waitRemoved(selectedByScript);
        log('直播任务本页已删除 ' + selectedByScript.length + ' 条：' + selectedByScript.join(', '));
      } finally {
        if (!submitted) {
          const modal = Array.from(document.querySelectorAll('.main-vmok-plugin-modal'))
            .find(x => visible(x) && text(x).includes('确定删除所选的'));
          modal?.querySelector('.main-vmok-plugin-modal__close-icon')?.click();
          for (let pass = 0; pass < 3; pass++) {
            let changed = false;
            for (const id of selectedByScript) {
              try {
                const row = taskById(id)?.row;
                const box = row?.querySelector('input[type="checkbox"]');
                if (box?.checked) {
                  box.click(); changed = true;
                  await new Promise(resolve => setTimeout(resolve, 250));
                }
              } catch (_) { /* 页面刷新中，下一轮重新找任务 */ }
            }
            if (!changed) break;
          }
          const leftovers = selectedByScript.filter(id => {
            try { return taskById(id)?.row.querySelector('input[type="checkbox"]')?.checked; }
            catch (_) { return false; }
          });
          if (leftovers.length) log('未提交；请人工取消仍勾选的任务：' + leftovers.join(', '));
        }
      }
    }
    async function deleteProduct(p) {
      let count = 0;
      for (const old of p.targets) {
        if (state.stop) throw new Error('用户已停止；已完成 ' + count + ' 条');
        const fresh = taskById(old.id);
        if (!fresh || !sameValues(old, fresh) || !eligible(fresh, p.params)) {
          throw new Error('任务 ' + old.id + ' 已变化或不再符合删除条件；已完成 ' + count + ' 条');
        }
        const icon = one(fresh.row.querySelectorAll('iconpark-icon[name="oc-icon-delete"]'),
          '任务 ' + old.id + ' 的单条删除按钮');
        icon.click();
        const expected = '确定删除所选的任务吗？';
        let submitted = false;
        try {
          await wait(() => {
            try { return visibleDeleteModal(expected); } catch (_) { return null; }
          }, '任务 ' + old.id + ' 的删除确认', 8000);
          if (state.stop) throw new Error('用户已停止；已完成 ' + count + ' 条');
          await confirmDelete(expected);
          submitted = true;
        } finally {
          if (!submitted) {
            const modal = Array.from(document.querySelectorAll('.main-vmok-plugin-modal'))
              .find(x => visible(x) && text(x).includes(expected));
            modal?.querySelector('.main-vmok-plugin-modal__close-icon')?.click();
          }
        }
        await waitRemoved([old.id]);
        count++;
        log('商品素材追投任务已删除 ' + old.id + '；本页累计 ' + count + ' 条');
      }
    }
    function setInput(input, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus(); setter.call(input, String(value));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    }
    function budgetPopover() {
      const input = one(Array.from(document.querySelectorAll('input[placeholder="请输入"]')).filter(x =>
        visible(x) && text(x.closest('.main-vmok-plugin-oc-row-input')).includes('调控日预算')),
      '调控日预算输入框');
      let box = input.parentElement;
      while (box && (!Array.from(box.querySelectorAll('button')).some(b => visible(b) && text(b) === '取消') ||
          !Array.from(box.querySelectorAll('button')).some(b => visible(b) && text(b) === '确定'))) box = box.parentElement;
      if (!box || box === document.body) throw new Error('预算编辑弹层按钮未就绪');
      const cancel = one(Array.from(box.querySelectorAll('button')).filter(b => text(b) === '取消'), '预算取消按钮');
      const confirm = one(Array.from(box.querySelectorAll('button')).filter(b => text(b) === '确定'), '预算确定按钮');
      return { input, box, cancel, confirm };
    }
    async function addBudget(p) {
      let count = 0;
      for (const old of p.targets) {
        if (state.stop) throw new Error('用户已停止；已完成 ' + count + ' 条');
        const fresh = taskById(old.id);
        if (!fresh || !sameValues(old, fresh) || !eligible(fresh, p.params)) throw new Error('任务 ' + old.id + ' 已变化；已完成 ' + count + ' 条');
        const cell = fresh.row.querySelectorAll(':scope > td')[taskTable().column['调控预算(元)']];
        const hoverTargets = [cell, cell.querySelector('.main-vmok-plugin-oc-promotion-data-card'),
          cell.querySelector('.main-vmok-plugin-oc-promotion-data-group-title')].filter(Boolean);
        for (const target of hoverTargets) {
          target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        }
        const icon = await wait(() => cell.querySelector('iconpark-icon[name="oc-icon-light-edit"]'),
          '预算编辑按钮；请将鼠标移到该任务的预算金额上后重试', 3000);
        icon.click();
        const pop = await wait(() => { try { return budgetPopover(); } catch (_) { return null; } },
          '预算编辑弹层', 8000);
        let submitted = false;
        try {
          const current = parseMoney(pop.input.value);
          if (current !== old.budget) throw new Error('任务 ' + old.id + ' 弹层预算与列表不一致');
          const match = text(pop.box).match(/当前最多可再追加预算\s*([\d,.]+)/);
          if (match && parseMoney(match[1]) < p.params.add) throw new Error('任务 ' + old.id + ' 可追加额度小于设定金额');
          const target = old.budget + p.params.add;
          if (!Number.isSafeInteger(target)) throw new Error('新预算金额超出安全范围');
          setInput(pop.input, yuan(target));
          if (parseMoney(pop.input.value) !== target) throw new Error('任务 ' + old.id + ' 的新预算输入未生效');
          if (state.stop) throw new Error('用户已停止；未提交任务 ' + old.id);
          assertLock();
          const beforeSubmit = taskById(old.id);
          if (!beforeSubmit || !sameValues(old, beforeSubmit) || !eligible(beforeSubmit, p.params)) {
            throw new Error('任务 ' + old.id + ' 提交前状态、ROI 或预算已变化；未提交');
          }
          submitted = true;
          pop.confirm.click();
          await wait(() => taskById(old.id)?.budget === target, '任务 ' + old.id + ' 新预算更新', 20000);
          count++;
          log('任务 ' + old.id + ' 预算 ' + yuan(old.budget) + ' → ' + yuan(target) + ' 元');
        } finally { if (!submitted && pop.cancel.isConnected) pop.cancel.click(); }
      }
    }
    async function executePage() {
      if (state.busy) return;
      readCfg();
      state.busy = true; state.stop = false; render();
      let action = '';
      try {
        const { p } = currentPreview();
        action = p.params.action;
        phase('正在执行第 ' + p.page + ' 页，共 ' + p.targets.length + ' 条');
        log('开始执行 ' + action + '，任务 ID：' + p.targets.map(x => x.id).join(', '));
        if (action === 'live-delete') await deleteLive(p);
        else if (action === 'product-delete') await deleteProduct(p);
        else await addBudget(p);
        state.preview = null;
        phase('本页操作完成，请等待平台刷新后再检查下一页');
        report('本页 ' + p.targets.length + ' 条任务已完成；可继续检查当前页或下一页');
      } catch (error) {
        state.preview = null;
        phase('已停止：' + error.message);
        report(error.message + '。若平台结果不明确，请人工核对任务 ID，勿直接重试。');
      } finally { state.busy = false; render(); }
    }

    host.style.cssText = 'position:fixed;z-index:2147483646;inset:0;pointer-events:none';
    host.textContent = '';
    const shadow = host.attachShadow({ mode: 'open' });
    const css = `<style>
      :host{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#243047}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.48;cursor:not-allowed}
      .launcher{pointer-events:auto;position:fixed;right:0;width:35px;min-height:122px;writing-mode:vertical-rl;letter-spacing:2px;background:#087bfa;color:white;border:1px solid #a7caff;border-right:0;border-radius:13px 0 0 13px;padding:10px 7px;box-shadow:0 8px 24px #064d9d40;font-size:12px;font-weight:700;cursor:grab;touch-action:none;user-select:none}
      .panel{pointer-events:auto;position:fixed;right:12px;top:12px;width:min(404px,calc(100vw - 24px));height:calc(100dvh - 24px);display:flex;flex-direction:column;overflow:hidden;background:#f7f9fc;border:1px solid #dce4ee;border-radius:20px;box-shadow:0 18px 48px #23395233;font-size:13px;line-height:1.5}
      .head{flex:none;display:flex;align-items:center;justify-content:space-between;min-height:63px;padding:12px 16px;background:white;border-bottom:1px solid #e5eaf2}.head strong{font-size:15px}.head strong:before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:50%;background:#087bfa;box-shadow:0 0 0 4px #e8f2ff}.head small{display:block;margin:3px 0 0 18px;color:#8a95a7;font-size:11px}.head button{width:31px;height:31px;border:0;border-radius:50%;background:#eff2f6;color:#607082;font-size:20px}
      .body{min-height:0;flex:1;overflow:auto;padding:14px 15px 18px;scrollbar-width:thin}.card{background:white;border:1px solid #e4eaf2;border-radius:14px;padding:12px;margin-bottom:12px;box-shadow:0 1px 4px #25344c08;overflow-wrap:anywhere}.eyebrow{font-size:12px;font-weight:700;color:#657387;margin-bottom:8px}.title{font-weight:700}.muted,.hint{color:#738196;font-size:11px;line-height:1.55}.hint{margin-top:8px}.warn{color:#ad5714}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field{display:block;margin:5px 0;color:#526177;font-size:12px}.field input,.field select{display:block;width:100%;min-height:38px;margin-top:5px;padding:8px 10px;border:1px solid #d4deea;border-radius:10px;background:white;color:#243047}.field input:focus,.field select:focus{outline:none;border-color:#087bfa;box-shadow:0 0 0 3px #087bfa20}.row{display:flex;gap:8px;margin-top:10px}.btn{flex:1;padding:9px 10px;border:1px solid #cbdfff;border-radius:10px;background:white;color:#086bd6;font-weight:700}.btn.primary{background:#087bfa;border-color:#087bfa;color:white}.btn.stop{flex:0 0 54px;color:#c93934;border-color:#ffd8d4}.status{padding:10px;border:1px solid #dcecff;border-radius:10px;background:#eaf4ff;color:#1459af;font-weight:700}.item{padding:8px 0;border-bottom:1px solid #edf0f4;font-size:11px}.item:last-child{border-bottom:0}.item b{display:block;font-size:12px}.pill{display:inline-block;margin:3px 5px 0 0;padding:2px 6px;border-radius:5px;background:#eef5ff;color:#2867b5}.check{display:flex;align-items:flex-start;gap:7px;margin-top:10px;color:#9b4c17;font-size:11px}.check input{margin-top:2px}.log{height:105px;overflow:auto;border-radius:10px;background:#172236;color:#dceaff;padding:9px;white-space:pre-wrap;font:11px/1.5 Consolas,monospace}.report{max-height:150px;overflow:auto;white-space:pre-wrap;border:1px solid #e2e8ef;border-radius:10px;padding:9px;font:11px/1.5 Consolas,monospace}
    </style>`;
    function render() {
      const old = shadow.querySelector('.body');
      if (old) state.scrollTop = old.scrollTop;
      const lock = state.lock, p = state.preview;
      let current = null;
      try { current = urlInfo(); } catch (_) { /* 页面尚未就绪 */ }
      const kind = current?.kind || lock?.kind || '';
      const needsRelock = lock && current && (lock.accountId !== current.accountId ||
        lock.planId !== current.planId || lock.kind !== current.kind);
      const live = kind === 'live';
      const choices = live ? `<option value="live-delete">直播低 ROI 批量删除</option><option value="live-budget">直播高 ROI 追加预算</option>` :
        `<option value="product-delete">商品低 ROI 逐条删除</option>`;
      const action = cfg.action && ((live && cfg.action.startsWith('live-')) || (!live && cfg.action === 'product-delete')) ? cfg.action : '';
      const fieldDisabled = state.busy ? 'disabled' : '';
      const conditionFields = action === 'live-delete' ?
        `<label class="field">调控支付 ROI 低于<input id="live-delete-roi" type="number" min="0" step="0.01" value="${esc(cfg.liveDeleteRoi)}" ${fieldDisabled}></label>` :
        action === 'live-budget' ?
        `<div class="grid"><label class="field">调控支付 ROI 不低于<input id="live-budget-roi" type="number" min="0" step="0.01" value="${esc(cfg.liveBudgetRoi)}" ${fieldDisabled}></label><label class="field">预算 − 消耗低于（元）<input id="gap" type="number" min="0" step="0.01" value="${esc(cfg.gap)}" ${fieldDisabled}></label><label class="field">每条追加预算（元）<input id="add" type="number" min="0.01" step="0.01" value="${esc(cfg.add)}" ${fieldDisabled}></label></div>` :
        action === 'product-delete' ?
        `<div class="grid"><label class="field">调控综合营销ROI 低于<input id="product-marketing-roi" type="number" min="0" step="0.01" value="${esc(cfg.productMarketingRoi)}" ${fieldDisabled}></label><label class="field">调控支付ROI 低于<input id="product-payment-roi" type="number" min="0" step="0.01" value="${esc(cfg.productPaymentRoi)}" ${fieldDisabled}></label></div>` :
        '<div class="hint">选择操作后，填写该操作需要的条件。</div>';
      const conditionHint = action === 'live-delete' ? '仅筛选当前页“调控中”且 ROI 低于阈值的任务。' :
        action === 'live-budget' ? 'ROI 达标且满足任一条件：调控中且预算与消耗差值低于阈值；或已暂停且明确提示“任务预算不足”（此时不再要求差值低于阈值）。其他暂停原因跳过。' :
        action === 'product-delete' ? '仅当调控综合成本和调控消耗都大于 0 时删除：任一已显示的 ROI 为“—”或低于各自阈值即符合条件。成本或消耗为 0、无法读取时跳过；未显示的 ROI 列不参与判定。' : '';
      const targets = p?.targets || [];
      const missingProductRoi = p?.kind === 'product' ? ['调控综合营销ROI', '调控支付ROI']
        .filter(label => !p.roiLabels.includes(label)) : [];
      const previewItems = targets.slice(0, 100).map(x => `<div class="item"><b>${esc(x.name || x.id)}</b><span class="pill">ID ${esc(x.id)}</span>${p.params.action === 'product-delete' ? `<span class="pill">调控综合营销ROI ${Number.isFinite(x.marketingRoi) ? esc(x.marketingRoi) : x.marketingRoiDash ? '—' : '不可用'}</span><span class="pill">调控支付ROI ${Number.isFinite(x.paymentRoi) ? esc(x.paymentRoi) : x.paymentRoiDash ? '—' : '不可用'}</span><span class="pill">综合成本 ${yuan(x.comprehensiveCost)} 元</span><span class="pill">调控消耗 ${yuan(x.spend)} 元</span>` : `<span class="pill">ROI ${esc(x.roi)}</span>`}${Number.isInteger(x.budget) ? `<span class="pill">预算 ${yuan(x.budget)}</span><span class="pill">消耗 ${yuan(x.spend)}</span>` : ''}${p.params.action === 'live-budget' ? `<span class="pill">拟改为 ${yuan(x.budget + p.params.add)}</span>` : ''}</div>`).join('');
      shadow.innerHTML = css + `<button id="launch" class="launcher" style="display:${state.open ? 'none' : 'block'};top:${esc(state.launcherTop)}%" title="点击展开，拖动调整位置">调控助手</button>
        <div class="panel" style="display:${state.open ? 'flex' : 'none'}"><div class="head"><div><strong>千川调控助手</strong><small>v0.1.10 · 默认静默最小化</small></div><button id="minimize" title="最小化">−</button></div><div class="body">
        <div class="card"><div class="eyebrow">锁定当前计划</div><div class="title">${esc(lock?.planName || '尚未锁定')}</div><div class="muted">账户 ${esc(lock?.accountId || '—')} · 计划 ${esc(lock?.planId || '—')} · ${lock?.kind === 'live' ? '推直播' : lock?.kind === 'product' ? '推商品' : '未识别'}</div>${needsRelock ? '<div class="hint warn">当前页面与已锁定计划不同，请重新锁定当前计划。</div>' : ''}<div class="row"><button id="lock" class="btn" ${state.busy ? 'disabled' : ''}>锁定当前计划</button></div></div>
        <div class="card"><div class="eyebrow">筛选条件</div><label class="field">本次操作<select id="action" ${fieldDisabled}><option value="">请选择</option>${choices}</select></label>${conditionFields}${conditionHint ? `<div class="hint">${conditionHint}</div>` : ''}</div>
        <div class="card"><div class="eyebrow">执行本页</div><div class="hint warn">先检查并核对任务清单，再点击执行。直播删除仅勾选本页合格任务并批量删除；商品删除逐条执行；预算逐条改为当前值加设定金额。可先在千川选 100 条/页；跨页请逐页检查。删除后不可恢复。</div><div class="row"><button id="preview" class="btn" ${state.busy || !lock ? 'disabled' : ''}>检查本页</button><button id="execute" class="btn primary" ${state.busy || !p?.targets.length ? 'disabled' : ''}>执行本页 ${targets.length} 条</button><button id="stop" class="btn stop" ${state.busy ? '' : 'disabled'}>停止</button></div>${p?.targets.length ? '<label class="check"><input id="ack" type="checkbox">我已核对下方任务 ID、ROI 和金额，确认执行本页操作</label>' : ''}</div>
        <div class="card"><div class="eyebrow">执行状态</div><div class="status">${esc(state.phase)}</div>${p ? `<div class="hint">第 ${esc(p.page)} 页 · ${esc(p.size || '当前条数')} · ROI 列：${esc(p.roiLabels.join('、'))} · 预览于 ${new Date(p.at).toLocaleTimeString('zh-CN', { hour12: false })}</div>${missingProductRoi.length ? `<div class="hint warn">当前表格未显示：${esc(missingProductRoi.join('、'))}；这些指标不参与判定。</div>` : ''}<div style="max-height:240px;overflow:auto;margin-top:8px">${previewItems || '<div class="muted">本页没有符合条件的任务</div>'}</div>` : '<div class="hint">尚未生成本页预览</div>'}</div>
        <div class="card"><div class="eyebrow">执行记录</div><div class="log">${esc(state.logs.join('\n') || '尚无记录')}</div></div><div class="card"><div class="eyebrow">结果报告</div><div class="report">${esc(state.report || '执行后生成报告')}</div><div class="row"><button id="copy" class="btn">复制报告</button></div></div></div></div>`;
      const actionInput = shadow.getElementById('action');
      actionInput.value = action;
      actionInput.onchange = e => { cfg.action = e.target.value; state.preview = null; GM_setValue(CFG_KEY, cfg); render(); };
      for (const [key, id] of [['liveDeleteRoi', 'live-delete-roi'], ['liveBudgetRoi', 'live-budget-roi'],
        ['gap', 'gap'], ['add', 'add'], ['productMarketingRoi', 'product-marketing-roi'],
        ['productPaymentRoi', 'product-payment-roi']]) {
        const input = shadow.getElementById(id);
        if (input) input.onchange = e => { cfg[key] = e.target.value; state.preview = null; GM_setValue(CFG_KEY, cfg); render(); };
      }
      shadow.getElementById('minimize').onclick = () => { state.open = false; render(); };
      shadow.getElementById('lock').onclick = lockCurrent;
      shadow.getElementById('preview').onclick = previewPage;
      shadow.getElementById('execute').onclick = () => {
        if (!shadow.getElementById('ack')?.checked) { phase('请先核对并勾选确认本页清单'); return; }
        executePage();
      };
      shadow.getElementById('stop').onclick = () => { state.stop = true; phase('已请求停止；当前未完成的操作会暂停'); };
      shadow.getElementById('copy').onclick = () => { if (state.report) GM_setClipboard(state.report); };
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
      if (old) shadow.querySelector('.body').scrollTop = state.scrollTop;
    }
    render();
    window.addEventListener('pageshow', e => { if (e.persisted) { state.open = false; state.preview = null; render(); } });
  } catch (error) {
    host.style.cssText = 'position:fixed;right:0;top:50%;z-index:2147483646;max-width:320px;padding:12px;background:#fff0ee;color:#a32920;border:1px solid #f2b9b2;border-radius:10px 0 0 10px;font:12px/1.5 sans-serif;pointer-events:auto';
    const message = '调控助手启动失败：' + (error && error.message || String(error));
    if (host.shadowRoot) host.shadowRoot.textContent = message;
    else host.textContent = message;
    console.error('千川调控助手启动失败', error);
  }
})();
