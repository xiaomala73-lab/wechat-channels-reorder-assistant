// ==UserScript==
// @name         巨量千川零消耗素材清理助手
// @namespace    local.qianchuan.empty-cost-cleaner
// @version      1.1.5
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-windows.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-windows.user.js
// @description  自选投放视频清理；末页保留一条；AIGC警告临时逐条排查，补标成功立即恢复批量删除
// @match        https://qianchuan.jinritemai.com/overall-prom*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const ROOT_ID = 'qc-empty-cost-cleaner-root';
  if (window.top !== window.self || document.getElementById(ROOT_ID)) return;

  const SAVED_KEY = 'qc-empty-cost-cleaner-config-v1';
  const LOG_KEY = 'qc-empty-cost-cleaner-last-report-v1';
  const LAUNCHER_TOP_KEY = 'qc-empty-cost-cleaner-launcher-top-v1';
  const SOURCE = '自选投放';
  const SORT = '综合成本(元)';
  const PAGE_SIZE = 20;
  const MAX_QUOTA = 500;
  const QUICK_CLICK = { before: 140, after: 180 };
  const AIGC_WARNING = /本素材生成的\s*AIGC\s*素材具备跑量优势|删除可能会影响\s*AIGC\s*消耗/;
  const ORDINARY_DELETE = /确定要删除视频吗[？?]?/;
  const cfg = Object.assign({ cutoff: '', quota: 90 }, GM_getValue(SAVED_KEY, {}));
  const state = {
    lock: null, busy: false, stop: false, phase: '请锁定当前商品或直播计划',
    logs: [], deleted: [], tagged: [], skipped: [], failed: [], protectedTailIds: [],
    lastReport: GM_getValue(LOG_KEY, ''), panelOpen: false, panelScroll: 0,
    viewport: null, pendingApproval: null,
    launcherTop: Math.max(12, Math.min(88, Number(GM_getValue(LAUNCHER_TOP_KEY, 70)) || 70))
  };

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function text(el) { return (el && el.innerText || '').trim().replace(/\s+/g, ' '); }
  function escapeHTML(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  function one(nodes, label) {
    const found = Array.from(nodes).filter(visible);
    if (found.length !== 1) throw new Error(label + '应恰好出现一次，实际 ' + found.length + ' 次');
    return found[0];
  }
  function exact(root, selector, value, label) {
    return one(Array.from(root.querySelectorAll(selector)).filter(el => text(el) === value), label || value);
  }
  async function wait(check, label, timeout = 16000, ignoreStop = false) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (state.stop && !ignoreStop) throw new Error('用户已停止');
      try { const answer = check(); if (answer) return answer; } catch (_) { /* 列表刷新中 */ }
      await sleep(180);
    }
    throw new Error(label + '等待超时；结果未确认，已停止，禁止直接重试删除');
  }
  function log(message) {
    state.logs.push(new Date().toLocaleTimeString('zh-CN', {hour12:false}) + '  ' + message);
    if (state.logs.length > 180) state.logs.shift();
    render();
  }
  function phase(message) { state.phase = message; render(); }
  function saveCfg() { GM_setValue(SAVED_KEY, { cutoff: cfg.cutoff, quota: cfg.quota }); }
  function assertViewport() {
    if (!state.viewport) return;
    const v = state.viewport;
    if (innerWidth !== v.width || innerHeight !== v.height || devicePixelRatio !== v.scale ||
      screen.width !== v.screenWidth || screen.height !== v.screenHeight) {
      throw new Error('窗口大小、缩放或屏幕分辨率已改变');
    }
  }
  function assertRun() {
    if (state.stop) throw new Error('用户已停止');
    assertViewport();
    context();
  }
  function detectBlock() {
    const words = Array.from(document.querySelectorAll('[role="dialog"], .main-vmok-plugin-modal__wrap'))
      .filter(visible).map(text).join(' ');
    if (/验证码|滑块验证|登录失效|权限不足|访问受限|平台风控/.test(words)) {
      throw new Error('平台登录、验证、权限或风控提示');
    }
  }
  function context(ignoreLock = false) {
    detectBlock();
    const url = new URL(location.href);
    const livePlan = url.pathname === '/overall-prom/detail' && url.hash.includes('marGoal=2');
    const productPlan = url.pathname === '/overall-prom' && url.hash.includes('marGoal=1');
    if (url.origin !== 'https://qianchuan.jinritemai.com' || (!livePlan && !productPlan) ||
      url.searchParams.get('campaignType') !== '1' || url.searchParams.get('uniTab') !== 'ad') {
      throw new Error('当前不是乘方商品或直播在投计划页');
    }
    const accountEl = one(document.querySelectorAll('.account-info-box'), '账户信息');
    const accountRaw = text(accountEl);
    const accountId = (accountRaw.match(/ID[：:]\s*(\d+)/) || [])[1];
    const accountName = accountRaw.slice(0, accountRaw.indexOf('ID')).trim();
    const drawer = one(document.querySelectorAll('.ad-detail-wrapper'), '计划详情抽屉');
    const lines = (drawer.innerText || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 12);
    const planName = livePlan ? lines[2] : lines[0];
    const planId = (lines.join('\n').match(livePlan ? /计划ID[：:]\s*(\d+)/ : /ID[：:]\s*(\d+)/) || [])[1];
    if (!accountId || !planId || !planName || url.searchParams.get('aavid') !== accountId ||
      url.searchParams.get('adId') !== planId) throw new Error('网址与页面账户或计划 ID 不一致');
    if (!lines.includes('投放中')) throw new Error('计划状态不是投放中');
    if (!drawer.querySelector('[id$="-tab-creative"][aria-selected="true"]')) throw new Error('请打开计划的素材标签');
    if (livePlan) {
      if (lines[0] !== '推直播间' || !planName || !lines.includes('直播大屏')) {
        throw new Error('当前不是推直播间计划');
      }
      if (!Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .some(el => text(el) === '视频' && el.className.includes('--checked'))) {
        throw new Error('请打开直播计划的“素材→视频”页');
      }
    } else {
      if (!document.querySelector('[id$="-tab-1"][aria-selected="true"]')) throw new Error('当前不是商品自选计划');
      const active = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map(text);
      if (!active.includes('商品') || !active.includes('商品自选')) throw new Error('当前不是商品→商品自选');
    }
    if (!ignoreLock && (!state.lock || state.lock.accountId !== accountId || state.lock.planId !== planId ||
      state.lock.accountName !== accountName || state.lock.planName !== planName ||
      state.lock.planKind !== (livePlan ? 'live' : 'product'))) {
      throw new Error('账户或计划与锁定对象不一致');
    }
    return { drawer, accountId, accountName, planId, planName, planKind: livePlan ? 'live' : 'product' };
  }
  async function click(el, label, beforeClick, pace = { before: 260, after: 480 }) {
    assertRun();
    if (!visible(el)) throw new Error(label + '不可见');
    const drawer = context().drawer;
    const allowed = drawer.contains(el) || !!el.closest('.main-vmok-plugin-modal__wrap, [role="dialog"], .main-vmok-plugin-oc-popover-text__content, .main-vmok-plugin-popover, .main-vmok-plugin-select__options, .main-vmok-plugin-cascader-panel');
    if (!allowed) throw new Error(label + '超出当前素材操作区域');
    phase('即将操作：' + label);
    await sleep(pace.before);
    assertRun();
    if (!visible(el)) throw new Error(label + '在操作前消失');
    if (beforeClick) beforeClick();
    el.click();
    await sleep(pace.after);
  }
  function sourceChip(drawer) {
    const label = state.lock?.planKind === 'live' ? '视频类型：自选投放视频' : '素材类型：自选投放';
    return Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-filter-echo-item'))
      .some(el => text(el).replace(/\s+/g, '').includes(label));
  }
  async function ensureFilter() {
    const drawer = context().drawer;
    const live = state.lock.planKind === 'live';
    const field = live ? '视频类型' : '素材类型';
    const optionLabel = live ? '自选投放视频' : SOURCE;
    if (sourceChip(drawer)) return;
    const more = one(drawer.querySelectorAll('.main-vmok-plugin-more-filter-btn button'), '更多筛选');
    if (!/^更多筛选(?:\s*\d+)?$/.test(text(more))) throw new Error('更多筛选按钮文字已改变');
    await click(more, '更多筛选');
    const item = await wait(() => Array.from(document.querySelectorAll('.main-vmok-plugin-body-title-item'))
      .filter(visible).find(el => text(el).includes(field)), field + '筛选');
    const popup = item.closest('.main-vmok-plugin-oc-popover-text__content');
    if (!popup) throw new Error('无法定位' + field + '筛选面板');
    const input = one(item.querySelectorAll('input[readonly][placeholder="请选择"]'), field + '选择框');
    await click(input, field + '选择框');
    const option = await wait(() => Array.from(document.querySelectorAll('li.main-vmok-plugin-cascader-panel__selection-item'))
      .filter(visible).find(el => text(el) === optionLabel), optionLabel + '选项');
    await click(option, optionLabel);
    await click(exact(popup, 'button', '确定', '筛选确定'), '筛选确定');
    await wait(() => sourceChip(context().drawer), field + '筛选生效');
    log('已筛选' + field + '：' + optionLabel);
  }
  function table() {
    const drawer = context().drawer;
    const head = one(drawer.querySelectorAll('.main-vmok-plugin-table__head-wrapper table'), '素材表头');
    const body = one(drawer.querySelectorAll('.main-vmok-plugin-table__body-wrapper table'), '素材表体');
    const headers = Array.from(head.querySelectorAll('thead tr:first-child th')).map(text);
    const sourceColumn = state.lock?.planKind === 'live' ? '视频类型' : '素材类型';
    const index = Object.fromEntries(['视频',sourceColumn,'标签','创建时间',SORT].map(name => [name, headers.indexOf(name)]));
    if (index['视频'] < 0 || index[sourceColumn] < 0 || index['标签'] < 0 || index['创建时间'] < 0 || index[SORT] < 0) {
      throw new Error('当前不是视频素材表，或缺少视频类型、标签、创建时间、综合成本列');
    }
    return { drawer, head, body, headers, index, sourceColumn };
  }
  function sorted(t) {
    const th = one(Array.from(t.head.querySelectorAll('thead tr:first-child th')).filter(el => text(el) === SORT), SORT + '列');
    return !!th.querySelector('.main-vmok-plugin-th__sorter-down--active');
  }
  function footer() {
    return one(context().drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
  }
  function pageInfo() {
    const f = footer();
    const count = (text(f).match(/共\s*(\d+)\s*条记录/) || [])[1];
    const size = Number((one(f.querySelectorAll('.main-vmok-plugin-page-select input[readonly]'), '每页条数').value || '').match(/^\d+/)?.[0]);
    const page = Number(text(one(f.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '当前页码')));
    if (count == null || !Number.isInteger(size) || !Number.isInteger(page) || size < 1 || page < 1) {
      throw new Error('无法读取分页数量、页码或每页条数');
    }
    return { total: Number(count), size, page, pages: Math.max(1, Math.ceil(Number(count) / size)) };
  }
  function costValue(raw) {
    const value = raw.trim();
    if (value === '' || /^[-—–]+$/.test(value) || value === '暂无数据') return null;
    const number = Number(value.replace(/[,￥¥\s]/g, ''));
    if (!Number.isFinite(number) || number < 0) throw new Error('综合成本数值无法识别：' + value);
    return number;
  }
  function rows() {
    const t = table();
    if (!sourceChip(t.drawer)) throw new Error('自选投放视频筛选已失效');
    if (!sorted(t)) throw new Error('综合成本(元)降序已失效');
    const result = [], ids = new Set();
    for (const tr of Array.from(t.body.querySelectorAll('tbody tr')).filter(visible)) {
      const cells = Array.from(tr.querySelectorAll(':scope > td'));
      if (cells.length !== t.headers.length) throw new Error('素材行与表头列数不一致');
      const id = (text(cells[1]).match(/素材ID[：:]\s*(\d+)/) || [])[1];
      if (!id || ids.has(id)) throw new Error('素材 ID 缺失或本页重复');
      ids.add(id);
      const date = (text(cells[t.index['创建时间']]).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      if (!date) throw new Error('素材 ' + id + ' 创建日期未就绪');
      const source = text(cells[t.index[t.sourceColumn]]);
      const label = text(cells[t.index['标签']]);
      const rawCost = text(cells[t.index[SORT]]);
      const checkbox = one(cells[0].querySelectorAll('input[type="checkbox"]'), '素材 ' + id + ' 复选框');
      result.push({ id, date, source, label, rawCost, cost: costValue(rawCost), checkbox, tr });
    }
    return result;
  }
  function signature() {
    const info = pageInfo();
    const rr = rows();
    const expected = Math.min(info.size, Math.max(0, info.total - (info.page - 1) * info.size));
    if (rr.length !== expected) return '';
    if (rr.some(r => r.checkbox.checked)) return '';
    let last = Infinity, sawEmpty = false;
    for (const r of rr) {
      if (r.cost === null) sawEmpty = true;
      else {
        if (sawEmpty || r.cost > last) return '';
        last = r.cost;
      }
    }
    return info.total + '/' + info.page + '/' + rr.map(r => r.id + ':' + r.rawCost + ':' + r.label).join('|');
  }
  async function stable() {
    let prior = '', since = 0;
    await wait(() => {
      const next = signature();
      if (!next) { prior = ''; since = 0; return false; }
      if (next !== prior) { prior = next; since = Date.now(); return false; }
      return Date.now() - since >= 1450;
    }, '整页素材、综合成本和排序稳定', 22000);
  }
  async function ensureSizeSort() {
    const f = footer();
    const input = one(f.querySelectorAll('.main-vmok-plugin-page-select input[readonly]'), '每页条数');
    if (input.value !== PAGE_SIZE + '条/页') {
      await click(input, '每页条数');
      const opt = await wait(() => Array.from(document.querySelectorAll('.main-vmok-plugin-select__options .main-vmok-plugin-option__content'))
        .filter(visible).find(el => text(el) === PAGE_SIZE + '条/页'), PAGE_SIZE + '条/页');
      await click(opt, PAGE_SIZE + '条/页');
      await wait(() => pageInfo().size === PAGE_SIZE, '每页20条生效');
    }
    let t = table();
    if (!sorted(t)) {
      const th = one(Array.from(t.head.querySelectorAll('thead tr:first-child th')).filter(el => text(el) === SORT), SORT + '列');
      await click(one(th.querySelectorAll('.main-vmok-plugin-th__sorter-down'), '综合成本降序箭头'), '综合成本降序');
    }
    await stable();
  }
  function pagerButton(kind) {
    const f = footer();
    return one(Array.from(f.querySelectorAll('li.main-vmok-plugin-page-turner__item')).filter(el =>
      !!el.querySelector('.main-vmok-plugin-page-turner__' + kind + '-icon')), kind + '页按钮');
  }
  async function move(kind) {
    const before = pageInfo(), currentIds = rows().map(r => r.id).join('|');
    const button = pagerButton(kind);
    if (button.className.includes('disabled') || button.getAttribute('aria-disabled') === 'true') return false;
    await click(button, kind === 'next' ? '下一页' : '上一页');
    const target = before.page + (kind === 'next' ? 1 : -1);
    await wait(() => pageInfo().page === target, '切换到第' + target + '页');
    await wait(() => rows().map(r => r.id).join('|') !== currentIds, '第' + target + '页素材刷新');
    await stable();
    return true;
  }
  async function lastPage() {
    const before = pageInfo();
    if (before.page === before.pages) return;
    const oldIds = rows().map(r => r.id).join('|');
    const last = one(Array.from(footer().querySelectorAll('li.main-vmok-plugin-page-turner__item'))
      .filter(el => text(el) === String(before.pages)), '末页页码 ' + before.pages);
    phase('直接跳到末页：第 ' + before.page + ' → ' + before.pages + ' 页');
    await click(last, '末页页码 ' + before.pages);
    await wait(() => pageInfo().page === before.pages, '切换到第 ' + before.pages + ' 页');
    await wait(() => rows().map(r => r.id).join('|') !== oldIds, '末页素材刷新');
    await stable();
    log('已直接跳到综合成本降序末页：第 ' + pageInfo().page + '/' + pageInfo().pages + ' 页');
  }
  function selectedRows() { return rows().filter(r => r.checkbox.checked); }
  function toolbarSelectedCount() {
    const matches = Array.from(context().drawer.innerText.matchAll(/已选\s*(\d+)\s*个\s*视频/g));
    if (matches.length !== 1) throw new Error('无法唯一读取工具栏已选视频数量');
    return Number(matches[0][1]);
  }
  function selectionMatches(ids) {
    const actual = selectedRows().map(r => r.id);
    return actual.length === ids.length && ids.every(id => actual.includes(id)) && toolbarSelectedCount() === ids.length;
  }
  function headerCheckbox() {
    const found = Array.from(table().head.querySelectorAll('thead tr:first-child th:first-child input[type="checkbox"]')).filter(visible);
    return found.length === 1 ? found[0] : null;
  }
  async function clearSelection() {
    const initial = selectedRows();
    const header = headerCheckbox();
    if (initial.length && initial.length === rows().length && header && header.checked) {
      await click(header, '取消本页全选', null, QUICK_CLICK);
      await wait(() => selectedRows().length === 0, '取消本页全选生效', 3500);
      return;
    }
    for (const id of selectedRows().map(r => r.id)) {
      const current = rows().find(r => r.id === id);
      if (!current || !current.checkbox.checked) throw new Error('清除勾选时素材列表已变化');
      await click(current.checkbox, '取消勾选素材 ' + id, null, QUICK_CLICK);
    }
    await wait(() => selectedRows().length === 0, '清除全部勾选');
  }
  async function selectIds(ids) {
    if (selectedRows().length) throw new Error('页面已有勾选，禁止叠加');
    const current = rows();
    if (!ids.length || ids.some(id => !current.some(r => r.id === id && eligible(r)))) {
      throw new Error('待选素材 ID 或筛选条件已改变');
    }
    const info = pageInfo();
    if (info.page === info.pages && ids.length === current.length) {
      throw new Error('末页禁止全页删除；须保留最后一条素材');
    }
    const header = headerCheckbox();
    const last = current[current.length - 1];
    const keepLast = current.length > 1 && info.page === info.pages &&
      ids.length === current.length - 1 && last && state.protectedTailIds.includes(last.id) &&
      ids.every((id, index) => current[index].id === id) && header && !header.checked;
    if (keepLast) {
      await click(header, '末页全选后保留最后一条', null, QUICK_CLICK);
      await wait(() => selectionMatches(current.map(r => r.id)), '末页全选生效', 3500);
      const protectedRow = rows().find(r => r.id === last.id);
      if (!protectedRow || !protectedRow.checkbox.checked) throw new Error('末页保留素材状态已改变');
      await click(protectedRow.checkbox, '取消末页保留素材 ' + last.id, null, QUICK_CLICK);
    } else if (ids.length === current.length && header && !header.checked) {
      await click(header, '本页合格素材全选', null, QUICK_CLICK);
    } else {
      for (const id of ids) {
        const row = rows().find(r => r.id === id);
        if (!row || row.checkbox.checked) throw new Error('待选素材 ' + id + ' 已改变');
        await click(row.checkbox, '勾选素材 ' + id, null, QUICK_CLICK);
      }
    }
    await wait(() => selectionMatches(ids), '勾选指定素材 ID 生效', 3500);
  }
  function eligibleBase(r) {
    return r.source === (state.lock?.planKind === 'live' ? '自选投放视频' : '自选投放素材') &&
      r.cost === null && r.date < cfg.cutoff &&
      !r.label.includes('AIGC跑量') && !state.deleted.includes(r.id) && !state.tagged.includes(r.id);
  }
  function eligible(r) { return eligibleBase(r) && !state.protectedTailIds.includes(r.id); }
  function protectFinalPageTail(info, current) {
    if (info.page !== info.pages || !current.length ||
        current.some(r => state.protectedTailIds.includes(r.id)) ||
        !current.every(eligibleBase)) return;
    const id = current[current.length - 1].id;
    state.protectedTailIds.push(id);
    log('末页 ' + current.length + ' 条全部符合删除条件；保留最后一条素材 ' + id + '，本轮不删除');
  }
  function warningVisible() {
    // 千川有时把警告放在普通确认框之外；只读取网页可见文字，不读取助手的 Shadow DOM。
    return AIGC_WARNING.test(document.body.innerText || '');
  }
  function visibleDialogs() {
    const drawer = context().drawer;
    const all = Array.from(document.querySelectorAll('.main-vmok-plugin-modal__wrap, .tools-vmok-plugin-modal__wrap, [role="alertdialog"], [role="dialog"]'))
      .filter(visible)
      .filter(el => !el.contains(drawer)) // 计划抽屉也可能带 role="dialog"，不能当作删除确认框。
      .filter(el => {
        const wording = text(el);
        return wording.length < 1000 && (ORDINARY_DELETE.test(wording) || AIGC_WARNING.test(wording));
      });
    return all.filter(el => !all.some(other => other !== el && el.contains(other)));
  }
  function deletionDialog() {
    const matches = visibleDialogs();
    if (matches.length > 1) throw new Error('同时出现多个删除提示，无法判明，已停止');
    return matches[0] || null;
  }
  async function openDelete(ids) {
    const drawer = context().drawer;
    const candidates = Array.from(drawer.querySelectorAll('button, a, span')).filter(el => visible(el) && text(el) === '删除')
      .filter(el => !el.closest('tbody'));
    const button = one(candidates.filter(el => !candidates.some(other => other !== el && el.contains(other))), '选中素材后的工具栏删除');
    if (!selectionMatches(ids)) {
      throw new Error('点击删除前勾选 ID 已改变');
    }
    if (warningVisible() || deletionDialog()) throw new Error('点击删除前页面已有未处理的删除提示');
    const prompt = { dialog: null, warningSeen: false, observer: null };
    // 从点击前开始监听，避免短暂出现的 AIGC 警告在读取弹窗时已经消失。
    const observer = new MutationObserver(() => { if (warningVisible()) prompt.warningSeen = true; });
    prompt.observer = observer;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden'] });
    try {
      await click(button, '工具栏删除（只打开确认框）', null, QUICK_CLICK);
      prompt.dialog = await wait(deletionDialog, '删除确认或 AIGC 警告', 10000);
      await sleep(900);
      if (warningVisible()) prompt.warningSeen = true;
      if (!visible(prompt.dialog)) throw new Error('删除提示在核对时消失，结果不明');
      return prompt;
    } catch (error) { observer.disconnect(); throw error; }
  }
  function dialogKind(prompt) {
    const wording = text(prompt.dialog);
    if (prompt.warningSeen || warningVisible() || AIGC_WARNING.test(wording)) return 'aigc';
    if (/AIGC|跑量优势/.test(wording)) throw new Error('删除提示涉及 AIGC，但警告内容无法准确识别');
    if (!ORDINARY_DELETE.test(wording)) throw new Error('删除弹窗内容未知');
    const buttons = Array.from(prompt.dialog.querySelectorAll('button')).filter(visible).map(text);
    if (buttons.filter(value => value === '确定').length !== 1 ||
      buttons.filter(value => value === '取消').length !== 1) {
      throw new Error('普通删除弹窗按钮不完整或不唯一');
    }
    const extra = wording.replace(ORDINARY_DELETE, '').replace(/取消|确定|[×✕]/g, '').trim();
    if (extra) throw new Error('普通删除弹窗出现额外说明，已停止：' + extra.slice(0, 100));
    return 'normal';
  }
  async function dismissDialog(dialog) {
    const buttons = Array.from(dialog.querySelectorAll('button')).filter(visible);
    const cancel = buttons.filter(el => ['取消','关闭','我知道了'].includes(text(el)));
    if (cancel.length === 1) await click(cancel[0], '取消删除弹窗');
    else {
      const close = Array.from(dialog.querySelectorAll('[aria-label], .main-vmok-plugin-modal__close')).filter(visible)
        .find(el => /关闭|close/i.test(el.getAttribute('aria-label') || el.className));
      if (!close) throw new Error('无法安全关闭 AIGC/测试弹窗');
      await click(close, '关闭删除弹窗');
    }
    await wait(() => !deletionDialog(), '删除弹窗关闭');
  }
  async function deletionEvidence(ids, oldTotal, timeout) {
    const end = Date.now() + timeout;
    let observed = '列表尚未就绪';
    while (Date.now() < end) {
      try {
        const info = pageInfo();
        const current = rows();
        const stillHere = ids.filter(id => current.some(r => r.id === id));
        const expected = Math.min(info.size, Math.max(0, info.total - (info.page - 1) * info.size));
        observed = '总数 ' + info.total + '（原 ' + oldTotal + '），当前页仍有目标 ID：' + (stillHere.join(', ') || '无');
        if (info.page <= info.pages && current.length === expected && !current.some(r => r.checkbox.checked) &&
          info.total === oldTotal - ids.length && stillHere.length === 0) {
          return { confirmed: true, observed };
        }
      } catch (_) { observed = '素材列表刷新中'; }
      await sleep(240);
    }
    return { confirmed: false, observed };
  }
  async function confirmDelete(prompt, ids, oldTotal) {
    if (!ids.length || ids.length > PAGE_SIZE) throw new Error('删除组数超出本页范围');
    const info = pageInfo();
    if (info.page === info.pages && ids.length === rows().length) {
      throw new Error('确认前发现待删素材占满末页，已停止以保留最后一条');
    }
    if (dialogKind(prompt) !== 'normal') throw new Error('不是普通删除确认框');
    assertRun();
    if (!selectionMatches(ids)) throw new Error('确认前素材勾选发生变化');
    if (ids.some(id => !rows().some(r => r.id === id && eligible(r)))) throw new Error('确认删除前素材条件已改变');
    if (warningVisible()) throw new Error('确认前出现 AIGC 警告，未删除');
    const confirm = one(Array.from(prompt.dialog.querySelectorAll('button')).filter(el => text(el) === '确定'), '删除确认按钮');
    await click(confirm, '确认删除 ' + ids.length + ' 条', () => {
      if (dialogKind(prompt) !== 'normal' || warningVisible()) {
        throw new Error('点击确定前提示发生变化或出现 AIGC 警告，未删除');
      }
      if (!selectionMatches(ids) || ids.some(id => !rows().some(r => r.id === id && eligible(r)))) {
        throw new Error('点击确定前素材 ID、条件或勾选发生变化，未删除');
      }
    }, QUICK_CLICK);
    // 先等页面自行更新；未更新时只翻页重读，不再次点击删除。
    let evidence = await deletionEvidence(ids, oldTotal, 8000);
    if (!evidence.confirmed && !state.stop) {
      if (deletionDialog()) throw new Error('删除弹窗仍在，目标 ID：' + ids.join(', ') + '；结果不明，未重复提交');
      log('目标 ID ' + ids.join(', ') + ' 删除结果尚未刷新；只翻页重读一次，不重复删除');
      if (selectedRows().length) await clearSelection();
      const info = pageInfo();
      if (info.page > 1) {
        await move('prev');
        await lastPage();
      } else if (info.pages > 1) {
        await move('next');
        await move('prev');
      }
      evidence = await deletionEvidence(ids, oldTotal, 6000);
    }
    if (!evidence.confirmed) {
      throw new Error('目标 ID ' + ids.join(', ') + ' 删除结果不明确：' + evidence.observed + '；已停止，禁止直接重试删除');
    }
    state.deleted.push(...ids);
    log('确认删除 ' + ids.length + ' 条；累计 ' + state.deleted.length + '/' + cfg.quota);
    await wait(() => !deletionDialog(), '删除弹窗消失', 10000, true);
  }
  async function tagAigc(id) {
    // 仅在单条素材触发千川明确的 AIGC 跑量警告后执行。
    const row = rows().find(r => r.id === id);
    if (!row || !row.checkbox.checked || selectedRows().length !== 1) throw new Error('AIGC 标记前选中素材不唯一');
    const drawer = context().drawer;
    const buttons = Array.from(drawer.querySelectorAll('button, a, span')).filter(el => visible(el) && text(el) === '添加标签' && !el.closest('tbody'));
    const tagButton = one(buttons.filter(el => !buttons.some(other => other !== el && el.contains(other))), '工具栏添加标签');
    await click(tagButton, '添加标签');
    const candidate = await wait(() => Array.from(document.querySelectorAll('label, li, button, span'))
      .filter(visible).filter(el => text(el) === 'AIGC跑量' && !drawer.querySelector('.main-vmok-plugin-table__body-wrapper')?.contains(el))
      .sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0], 'AIGC跑量标签选项', 8000);
    const box = candidate.closest('label')?.querySelector('input[type="checkbox"]') || candidate.querySelector('input[type="checkbox"]');
    if (box && box.checked) throw new Error('AIGC 跑量标签选择状态不明');
    await click(box || candidate, '选择 AIGC跑量 标签');
    const popups = Array.from(document.querySelectorAll('.main-vmok-plugin-modal__wrap, [role="dialog"], .main-vmok-plugin-oc-popover-text__content'))
      .filter(visible).filter(el => text(el).includes('AIGC跑量') && !el.contains(drawer));
    const popup = popups.sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (!popup) throw new Error('无法定位 AIGC 标签确认面板');
    const confirms = Array.from(popup.querySelectorAll('button')).filter(el => visible(el) && ['确定','确认'].includes(text(el)));
    if (confirms.length !== 1) throw new Error('AIGC 标签确认按钮不唯一');
    await click(confirms[0], '确认 AIGC跑量 标签');
    await wait(() => rows().some(r => r.id === id && r.label.includes('AIGC跑量')), 'AIGC 跑量标签生效', 15000);
    state.tagged.push(id);
    log('素材 ' + id + ' 触发 AIGC 警告，已添加 AIGC跑量 标签');
    if (selectedRows().length) await clearSelection();
  }
  async function processOne(id) {
    // 每轮只处理一条。千川删除后会重排列表，下一条必须从刷新后的末页重新核对。
    if (!id || selectedRows().length) throw new Error('逐条删除前选择状态不正确');
    const row = rows().find(r => r.id === id);
    if (!row || !eligible(row)) throw new Error('待处理素材条件已改变');
    const before = pageInfo().total;
    await selectIds([id]);
    const prompt = await openDelete([id]);
    try {
      const kind = dialogKind(prompt);
      if (kind === 'aigc') {
        await dismissDialog(prompt.dialog);
        log('素材 ' + id + ' 出现 AIGC 警告；取消删除并尝试补标');
        await tagAigc(id);
        return 'tagged';
      }
      await confirmDelete(prompt, [id], before);
      return 'deleted';
    } finally {
      prompt.observer.disconnect();
    }
  }
  async function processBatch(ids) {
    if (!ids.length || ids.length > PAGE_SIZE || selectedRows().length) throw new Error('批量删除前选择状态不正确');
    if (ids.some(id => !rows().some(r => r.id === id && eligible(r)))) throw new Error('批量候选素材条件已改变');
    const before = pageInfo().total;
    await selectIds(ids);
    const prompt = await openDelete(ids);
    try {
      if (dialogKind(prompt) === 'aigc') {
        await dismissDialog(prompt.dialog);
        await clearSelection();
        log('本组 ' + ids.length + ' 条出现 AIGC 警告；已取消批量删除，改为逐条排查');
        return 'aigc';
      }
      await confirmDelete(prompt, ids, before);
      return 'deleted';
    } finally {
      prompt.observer.disconnect();
    }
  }
  async function prepare() {
    const preselected = Array.from(table().body.querySelectorAll('tbody tr input[type="checkbox"]')).filter(el => el.checked);
    if (preselected.length) throw new Error('页面原本已勾选 ' + preselected.length + ' 条素材；请先手动清除勾选后再运行');
    await ensureFilter();
    await ensureSizeSort();
    await lastPage();
    await stable();
  }
  function report(reason) {
    const c = state.lock || {};
    const body = [
      '千川零消耗素材清理报告',
      '账户：' + (c.accountName || '-') + '（' + (c.accountId || '-') + '）',
      '计划：' + (c.planName || '-') + '（' + (c.planId || '-') + '）',
      '计划类型：' + (c.planKind === 'live' ? '推直播间' : c.planKind === 'product' ? '商品自选' : '未锁定'),
      '条件：' + (c.planKind === 'live' ? '视频类型为自选投放视频' : '素材类型为自选投放素材') +
        '；综合成本为空；创建日期早于 ' + cfg.cutoff + '；无 AIGC跑量 标签',
      '数量上限：' + cfg.quota,
      '已确认删除：' + state.deleted.length,
      '本轮补标 AIGC跑量：' + state.tagged.length,
      '末页保留素材 ID：' + (state.protectedTailIds.join(', ') || '无'),
      '停止位置：' + (() => { try { const p = pageInfo(); return '第 ' + p.page + '/' + p.pages + ' 页'; } catch (_) { return '无法确认'; } })(),
      '停止原因：' + reason,
      '已删素材 ID：' + (state.deleted.join(', ') || '无'),
      '补标素材 ID：' + (state.tagged.join(', ') || '无'),
      '最近操作：', ...state.logs.slice(-30)
    ].join('\n');
    state.lastReport = body;
    GM_setValue(LOG_KEY, body);
    return body;
  }
  function requestRunApproval() {
    return new Promise(resolve => {
      state.pendingApproval = { resolve };
      state.panelOpen = true;
      render();
    });
  }
  function closeRunApproval(approved) {
    const pending = state.pendingApproval;
    if (!pending) return;
    state.pendingApproval = null;
    render();
    pending.resolve(approved);
  }
  async function run(dry) {
    if (state.busy) return;
    try {
      if (!state.lock) throw new Error('请先锁定当前计划');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.cutoff) || Number.isNaN(Date.parse(cfg.cutoff + 'T00:00:00'))) throw new Error('请输入有效的截止日期');
      if (!Number.isInteger(cfg.quota) || cfg.quota < 1 || cfg.quota > MAX_QUOTA) throw new Error('删除数量须为 1—' + MAX_QUOTA);
      context();
      if (!dry) {
        const ok = await requestRunApproval();
        if (!ok) return;
        context();
      }
      state.busy = true; state.stop = false; state.deleted = []; state.tagged = []; state.skipped = []; state.failed = []; state.protectedTailIds = []; state.logs = [];
      state.viewport = { width: innerWidth, height: innerHeight, scale: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height };
      phase(dry ? '演练：定位末页并检查，不勾选或删除' : '正式执行：准备素材页');
      await prepare();
      if (dry) {
        const rr = rows();
        protectFinalPageTail(pageInfo(), rr);
        const eligibleRows = rr.filter(eligible);
        log('末页第 ' + pageInfo().page + ' 页：' + rr.length + ' 条，本轮可删除 ' + eligibleRows.length + ' 条；ID：' + eligibleRows.map(r => r.id).join(', '));
        phase('演练完成：未勾选、未标记、未删除');
        report('演练检查当前末页，未删除');
        return;
      }
      let visits = 0, scanned = 0, reason = '', returnToLast = false;
      const singleFallbackIds = new Set();
      while (state.deleted.length < cfg.quota) {
        assertRun();
        if (++visits > 1000) throw new Error('扫描超过1000轮，已停止以避免循环');
        await stable();
        if (returnToLast) {
          await lastPage();
          returnToLast = false;
        }
        const info = pageInfo(), current = rows();
        protectFinalPageTail(info, current);
        scanned++;
        const candidates = current.filter(eligible).slice(0, cfg.quota - state.deleted.length);
        if (candidates.length) {
          const fallback = candidates.find(r => singleFallbackIds.has(r.id));
          if (fallback) {
            log('第 ' + info.page + '/' + info.pages + ' 页逐条排查 AIGC 警告组素材 ' + fallback.id);
            const result = await processOne(fallback.id);
            singleFallbackIds.delete(fallback.id);
            if (result === 'tagged') {
              singleFallbackIds.clear();
              log('已找到并补标 AIGC 跑量素材；结束逐条排查，下一轮重新读取合格素材并恢复批量删除');
            }
            if (result === 'deleted') returnToLast = true;
          } else {
            const ids = candidates.map(r => r.id);
            log('第 ' + info.page + '/' + info.pages + ' 页拟批量删除 ' + ids.length + ' 条；逐条核对 ID、日期、成本和标签');
            const result = await processBatch(ids);
            if (result === 'aigc') ids.forEach(id => singleFallbackIds.add(id));
            else returnToLast = true;
          }
          continue;
        }
        if (info.page <= 1) { reason = '已扫描到第1页，无更多符合条件的素材；末页保留素材不会删除'; break; }
        if (!(await move('prev'))) { reason = '无法继续翻上一页'; break; }
      }
      if (!reason) reason = '达到删除数量上限 ' + cfg.quota + ' 条';
      phase('已停止：' + reason);
      log('扫描页次 ' + scanned + '，删除 ' + state.deleted.length + ' 条，补标 ' + state.tagged.length + ' 条');
      report(reason);
    } catch (error) {
      const message = error && error.message || String(error);
      phase('已停止：' + message);
      log('安全停止：' + message);
      report(message + '。请人工核对当前弹窗与素材列表；不要直接重复本轮删除。');
    } finally {
      state.busy = false; state.viewport = null; render();
    }
  }
  function lockCurrent() {
    try {
      if (state.busy) throw new Error('运行中不能切换计划');
      const current = context(true);
      state.lock = { accountId: current.accountId, accountName: current.accountName, planId: current.planId,
        planName: current.planName, planKind: current.planKind };
      phase('已锁定当前' + (current.planKind === 'live' ? '直播' : '商品') + '在投计划');
      log('锁定 ' + current.accountName + ' → ' + current.planName + '（' + current.planId + '）');
    } catch (error) { phase('锁定失败：' + error.message); }
    render();
  }

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'position:fixed;z-index:2147483646;inset:0;pointer-events:none';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({mode:'open'});
  const css = `<style>
    :host{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}
    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer;transition:background .16s,border-color .16s,box-shadow .16s}button:disabled{opacity:.48;cursor:not-allowed}
    .launcher{pointer-events:auto;position:fixed;right:0;z-index:2147483645;width:34px;min-height:116px;writing-mode:vertical-rl;letter-spacing:2px;background:rgba(0,122,255,.95);color:#fff;border:1px solid rgba(255,255,255,.38);border-right:0;border-radius:13px 0 0 13px;padding:11px 7px;box-shadow:0 6px 20px rgba(0,72,158,.22);font-size:12px;font-weight:600;cursor:grab;touch-action:none;user-select:none;backdrop-filter:blur(12px)}
    .launcher:hover{background:#0066d6;width:38px}
    .panel{pointer-events:auto;position:fixed;right:12px;top:12px;width:min(380px,calc(100vw - 24px));height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:hidden;display:flex;flex-direction:column;z-index:2147483646;background:rgba(250,251,253,.97);border:1px solid rgba(200,208,220,.7);border-radius:18px;box-shadow:0 18px 48px rgba(28,41,62,.2),0 2px 8px rgba(28,41,62,.08);backdrop-filter:blur(18px);font-size:13px;line-height:1.5}
    .head{flex:none;display:flex;align-items:center;justify-content:space-between;min-height:58px;padding:12px 14px 12px 18px;color:#1d1d1f;background:rgba(255,255,255,.92);border-bottom:1px solid #e5e9ef}.head strong{font-size:15px;letter-spacing:.2px;font-weight:700}.head strong:before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:50%;background:#007aff;box-shadow:0 0 0 4px #eaf3ff;vertical-align:1px}.head small{display:block;margin:3px 0 0 18px;color:#7c8595;font-size:11px;font-weight:400}.head button{width:30px;height:30px;display:grid;place-items:center;color:#596272;background:#f0f2f5;border:0;border-radius:50%;font-size:21px;line-height:1}.head button:hover{background:#e3e7ed;color:#1d1d1f}
    .body{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 16px 18px;scrollbar-color:#c8d0db transparent;scrollbar-width:thin}.card{background:#fff;border:1px solid #e5e9ef;border-radius:13px;padding:11px 12px;margin-bottom:12px;line-height:1.55;overflow-wrap:anywhere;box-shadow:0 1px 3px rgba(24,44,72,.035)}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.4px;color:#596273;margin-bottom:7px}.title{font-weight:700;overflow-wrap:anywhere}.muted{font-size:12px;color:#7c8595}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.field{display:block;min-width:0;margin:5px 0;color:#505b6d;font-size:12px}.field input{display:block;width:100%;min-height:37px;margin-top:5px;border:1px solid #d6dde7;border-radius:10px;padding:8px 10px;background:#fff;color:#1d1d1f;font-size:13px;outline:none}.field input:focus{border-color:#007aff;box-shadow:0 0 0 3px rgba(0,122,255,.12)}
    .row{display:flex;gap:8px;margin-top:10px}.btn{border:1px solid #cbdcff;border-radius:10px;padding:9px 11px;background:#fff;color:#0066d6;font-weight:600;flex:1}.btn:hover:not(:disabled){background:#edf5ff}.btn.primary{background:#007aff;color:#fff;border-color:#007aff}.btn.primary:hover:not(:disabled){background:#0069df}.btn.stop{color:#d33b32;border-color:#ffd4d1;flex:0 0 55px}.btn.stop:hover:not(:disabled){background:#fff2f0}.hint{font-size:11px;color:#697386;line-height:1.55;margin-top:8px}.warn{color:#a14b0c}.status{padding:10px 11px;background:#eaf3ff;border:1px solid #d9eaff;border-radius:10px;color:#175aaf;font-weight:700;overflow-wrap:anywhere}.log{height:110px;overflow:auto;background:#17202f;color:#dbe8fa;border-radius:11px;padding:9px 10px;white-space:pre-wrap;font:11px/1.55 Consolas,monospace}.report{max-height:190px;overflow:auto;white-space:pre-wrap;background:#fff;border:1px solid #e5e9ef;border-radius:11px;padding:10px;font:11px/1.5 Consolas,monospace;overflow-wrap:anywhere}
    .confirm-layer{position:absolute;inset:0;z-index:5;background:rgba(19,32,52,.38);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(5px)}.confirm-box{width:100%;background:#fff;border:1px solid #e5e9ef;border-radius:17px;box-shadow:0 18px 44px rgba(22,37,61,.2);padding:18px}.confirm-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;background:#fff2e8;color:#b85e11;font-weight:800;margin-bottom:10px}.confirm-title{font-size:16px;font-weight:700;margin-bottom:8px}.confirm-detail{font-size:12px;color:#596273;line-height:1.55;overflow-wrap:anywhere}.confirm-summary{background:#f4f7fb;border-radius:11px;padding:10px;margin:12px 0;font-size:12px;line-height:1.6}.confirm-summary strong{color:#1d1d1f}
  </style>`;
  function render() {
    const oldBody = shadow.querySelector('.body');
    if (oldBody) state.panelScroll = oldBody.scrollTop;
    const lock = state.lock;
    const live = lock ? lock.planKind === 'live' : location.pathname === '/overall-prom/detail' && location.hash.includes('marGoal=2');
    const planLabel = live ? '直播在投计划' : '商品在投计划';
    const sourceLabel = live ? '视频类型为自选投放视频' : '素材类型为自选投放素材';
    shadow.innerHTML = css + `<button class="launcher" id="launch" title="点击展开，拖动调整位置" aria-label="展开千川零消耗素材清理助手" style="display:${state.panelOpen?'none':'block'};top:${escapeHTML(state.launcherTop)}%">清理助手</button>
      <div class="panel" style="display:${state.panelOpen?'flex':'none'}"><div class="head"><div><strong>千川零消耗素材清理助手</strong><small>v1.1.4 · ${planLabel} · 自选投放视频</small></div><button id="close" title="最小化" aria-label="最小化助手">−</button></div><div class="body">
      <div class="card"><div class="eyebrow">锁定账户 / 当前计划</div><div class="title">${lock?escapeHTML(lock.accountName):'尚未锁定'}</div><div class="muted">${lock?escapeHTML(lock.accountId):''}</div><div class="title" style="margin-top:6px">${lock?escapeHTML(lock.planName):'请先打开素材页'}</div><div class="muted">${lock?escapeHTML(lock.planId):''}</div><div class="row"><button class="btn" id="lock" ${state.busy?'disabled':''}>锁定当前计划</button></div></div>
      <div class="card"><div class="eyebrow">筛选条件</div><div class="grid"><label class="field">创建日期严格早于<input id="cutoff" type="date" value="${escapeHTML(cfg.cutoff)}" ${state.busy?'disabled':''}></label><label class="field">最多删除条数<input id="quota" type="number" min="1" max="${MAX_QUOTA}" step="1" value="${escapeHTML(cfg.quota)}" ${state.busy?'disabled':''}></label></div><div class="hint">${live?'直播素材→视频页筛选“视频类型：自选投放视频”':'商品素材页筛选“素材类型：自选投放”'}，20 条/页；按<strong>综合成本(元)降序</strong>从末页往前检查。仅删成本为空（-、--、暂无数据或空白）、日期早于截止日、且无 AIGC跑量 标签的素材。</div></div>
      <div class="card"><div class="eyebrow">执行</div><div class="hint warn">先演练查看末页候选。末页全部合格时保留最后一条，避免删除后空页；其余合格素材优先整批处理。出现 AIGC 警告则取消本批，逐条排查；找到并补标 AIGC 素材后恢复批量删除，再遇警告才重新排查。提示不明确或删除结果未确认时立即停止，不重复提交。</div><div class="row"><button class="btn" id="preview" ${state.busy?'disabled':''}>检查末页</button><button class="btn primary" id="start" ${state.busy?'disabled':''}>开始清理</button><button class="btn stop" id="stop" ${state.busy?'':'disabled'}>停止</button></div></div>
      <div class="card"><div class="eyebrow">执行状态</div><div class="status">${escapeHTML(state.phase)}</div><div class="hint">本轮已删 ${state.deleted.length} 条 · 补标 AIGC ${state.tagged.length} 条</div></div>
      <div class="card"><div class="eyebrow">执行记录</div><div class="log">${escapeHTML(state.logs.slice(-35).join('\n')||'尚无记录')}</div></div>
      <div class="card"><div class="eyebrow">结果报告</div><div class="report">${escapeHTML(state.lastReport||'执行后生成报告')}</div><div class="row"><button class="btn" id="copy">复制报告</button></div></div>
      </div>${state.pendingApproval ? `<div class="confirm-layer" role="dialog" aria-modal="true" aria-label="确认开始清理"><div class="confirm-box"><div class="confirm-icon">!</div><div class="confirm-title">确认开始清理</div><div class="confirm-detail">将按当前条件在锁定的${planLabel}中执行删除。请核对对象和数量；关闭此确认区不会启动任务。</div><div class="confirm-summary"><strong>${escapeHTML(lock?.accountName || '')}</strong><br>${escapeHTML(lock?.planName || '')}（${escapeHTML(lock?.planId || '')}）<br>创建日期早于 <strong>${escapeHTML(cfg.cutoff)}</strong><br>最多删除 <strong>${escapeHTML(cfg.quota)}</strong> 条；仅处理综合成本为空、无 AIGC跑量 标签且${sourceLabel}的素材。</div><div class="row"><button class="btn" id="approval-cancel">取消</button><button class="btn primary" id="approval-confirm">确认开始清理</button></div></div></div>` : ''}</div>`;
    const launcher = shadow.querySelector('#launch');
    let dragStart = null, suppressLaunchClick = false;
    launcher.onpointerdown = event => {
      dragStart = { y: event.clientY, top: launcher.getBoundingClientRect().top };
      launcher.setPointerCapture(event.pointerId);
    };
    launcher.onpointermove = event => {
      if (!dragStart) return;
      if (Math.abs(event.clientY - dragStart.y) > 5) suppressLaunchClick = true;
      if (!suppressLaunchClick) return;
      const top = Math.max(12, Math.min(innerHeight - launcher.offsetHeight - 12, dragStart.top + event.clientY - dragStart.y));
      launcher.style.top = top + 'px';
      state.launcherTop = top / innerHeight * 100;
    };
    launcher.onpointerup = () => {
      if (suppressLaunchClick) GM_setValue(LAUNCHER_TOP_KEY, state.launcherTop);
      dragStart = null;
      setTimeout(() => { suppressLaunchClick = false; }, 0);
    };
    launcher.onpointercancel = () => { dragStart = null; suppressLaunchClick = false; };
    launcher.onclick = () => { if (!suppressLaunchClick) { state.panelOpen = true; render(); } };
    shadow.querySelector('#close').onclick = () => {
      if (state.pendingApproval) closeRunApproval(false);
      state.panelOpen = false;
      render();
    };
    const approvalCancel = shadow.querySelector('#approval-cancel');
    if (approvalCancel) approvalCancel.onclick = () => closeRunApproval(false);
    const approvalConfirm = shadow.querySelector('#approval-confirm');
    if (approvalConfirm) approvalConfirm.onclick = () => closeRunApproval(true);
    shadow.querySelector('#lock').onclick = lockCurrent;
    shadow.querySelector('#preview').onclick = () => run(true);
    shadow.querySelector('#start').onclick = () => run(false);
    shadow.querySelector('#stop').onclick = () => { state.stop = true; phase('已请求停止；当前动作结束后停止'); };
    shadow.querySelector('#copy').onclick = () => { if (state.lastReport) GM_setClipboard(state.lastReport); };
    shadow.querySelector('#cutoff').onchange = e => { cfg.cutoff = e.target.value; saveCfg(); };
    shadow.querySelector('#quota').onchange = e => { cfg.quota = Number(e.target.value); saveCfg(); };
    const body = shadow.querySelector('.body');
    if (body) body.scrollTop = state.panelScroll;
  }
  render();
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (state.pendingApproval) closeRunApproval(false);
    state.panelOpen = false;
    state.busy = false;
    state.stop = true;
    state.phase = '页面已恢复；请重新锁定计划后再执行';
    render();
  });
})();
