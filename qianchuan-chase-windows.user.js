// ==UserScript==
// @name         巨量千川素材追投助手（安全锁定版）
// @namespace    local.qianchuan.chase
// @version      0.4.36
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-windows.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-windows.user.js
// @description  商品日期追投可设最终尾组最低数量；直播日期允许未审核素材；整组复核补选；提交失败限重试一次
// @match        https://qianchuan.jinritemai.com/overall-prom*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window.self || document.getElementById('qc-chase-helper-root')) return;

  var STORAGE_KEY = 'qc-chase-helper-journal-v1';
  var BATCH_KEY = 'qc-chase-helper-live-batch-v1';
  var REFRESH_KEY = 'qc-chase-helper-refresh-v1';
  var REFRESH_TAB_KEY = 'qc-chase-helper-refresh-tab-v1';
  var LAUNCHER_TOP_KEY = 'qc-chase-helper-launcher-top-v1';
  var MAX_PRODUCT_GROUPS = 20;
  var MAX_LIVE_GROUPS = 40;
  var MIN_BUDGET = 100;
  var MAX_BUDGET = 500;
  var MAX_HOURS = 24;
  var SOURCE_LABEL = '自选投放素材';
  var FILTER_LABEL = '自选投放';
  var SUCCESS_RE = /操作成功|创建成功|提交成功/;
  var FAILURE_RE = /操作失败|创建失败|提交失败|请求失败|系统繁忙|稍后重试/;
  var RETRYABLE_FAILURE_RE = /操作失败|创建失败|提交失败/;
  var state = {
    config: {
      mode: 'roi',
      planKind: 'product',
      accountId: '',
      accountName: '',
      planId: '',
      planName: '',
      budget: 100,
      hours: 24,
      maxGroups: 10,
      roiGroupSize: 10,
      dateGroupSize: 20,
      roiThreshold: 1,
      roiStrategy: 'strict',
      startDate: '',
      endDate: '',
      dashPolicy: 'pause',
      dryRun: true,
      skipControlling: true,
      bid: 10.5,
      liveGoal: '直播间成交',
      liveRoiTarget: '',
      liveGender: '不限',
      tailMin: 5
    },
    busy: false,
    stopRequested: false,
    stopMessage: '用户已请求停止',
    viewportLock: null,
    phase: '等待锁定当前计划',
    logs: [],
    report: '',
    currentRun: null,
    previewSelection: null,
    batch: null,
    batchRunActive: false,
    refreshing: false,
    resumeRun: null,
    open: false,
    panelScrollTop: 0,
    launcherTop: 42,
    lastConfirmedRefreshAt: 0
  };
  var savedLauncherTop = Number(GM_getValue(LAUNCHER_TOP_KEY, 42));
  if (Number.isFinite(savedLauncherTop)) state.launcherTop = Math.max(12, Math.min(88, savedLauncherTop));
  var journal = GM_getValue(STORAGE_KEY, { runs: [] });
  if (!journal || !Array.isArray(journal.runs)) journal = { runs: [] };
  var savedBatch = GM_getValue(BATCH_KEY, null);
  if (savedBatch && typeof savedBatch === 'object' &&
      ['navigating', 'running', 'refreshing', 'needs_review'].includes(savedBatch.status)) state.batch = savedBatch;
  if (location.pathname === '/overall-prom' && location.hash.includes('marGoal=2')) {
    state.config.planKind = 'live';
    state.config.roiThreshold = 2;
  }

  function saveBatch() {
    GM_setValue(BATCH_KEY, state.batch);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  function unique(items, label) {
    var found = Array.from(items).filter(visible);
    if (found.length !== 1) throw new Error(label + '应恰好出现一次，实际为' + found.length + '次');
    return found[0];
  }

  function exactText(el) {
    return (el && el.innerText || '').trim().replace(/\s+/g, ' ');
  }

  function waitFor(check, label, timeout) {
    var limit = Date.now() + (timeout || 5000);
    return new Promise(function (resolve, reject) {
      function step() {
        try {
          var value = check();
          if (value) return resolve(value);
          if (Date.now() > limit) return reject(new Error('等待超时：' + label));
          setTimeout(step, 120);
        } catch (error) { reject(error); }
      }
      step();
    });
  }

  function saveJournal() {
    journal.runs = journal.runs.slice(-30);
    GM_setValue(STORAGE_KEY, journal);
  }

  function addLog(message) {
    var line = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + message;
    state.logs.push(line);
    state.logs = state.logs.slice(-60);
    if (state.currentRun) {
      state.currentRun.logs.push(line);
      state.currentRun.logs = state.currentRun.logs.slice(-100);
      saveJournal();
    }
    render();
  }

  function setPhase(message) {
    state.phase = message;
    render();
  }

  var CLICK_PREVIEW_MS = 180;
  var CLICK_SETTLE_MS = 520;

  async function dismissKnownPromo() {
    var matches = Array.from(document.querySelectorAll('.tools-vmok-plugin-modal__wrap')).filter(function (el) {
      return visible(el) && exactText(el).includes('开启联盟合作达人自动投') &&
        exactText(el).includes('新建自动投放计划');
    });
    if (!matches.length) return;
    var promo = unique(matches, '联盟合作达人自动投推广弹窗');
    var close = unique(promo.querySelectorAll('.tools-vmok-plugin-modal__close-icon'), '推广弹窗关闭按钮');
    setPhase('关闭联盟合作达人自动投推广弹窗');
    await sleep(CLICK_PREVIEW_MS);
    if (!visible(promo) || !visible(close)) throw new Error('推广弹窗关闭按钮已变化');
    close.click();
    await waitFor(function () { return !visible(promo); }, '推广弹窗关闭', 5000);
    await sleep(CLICK_SETTLE_MS);
    addLog('已关闭联盟合作达人自动投推广弹窗');
  }

  async function safeClick(el, label, allowDuringStop, onBeforeClick) {
    await dismissKnownPromo();
    if (!visible(el)) throw new Error(label + '不可见');
    if (!allowDuringStop) assertViewport();
    if (state.stopRequested && !allowDuringStop) throw new Error(state.stopMessage);
    setPhase('即将点击：' + label);
    await sleep(CLICK_PREVIEW_MS);
    if (!visible(el)) throw new Error(label + '在点击前已消失');
    if (!allowDuringStop) assertViewport();
    if (state.stopRequested && !allowDuringStop) throw new Error(state.stopMessage);
    var drawer = document.querySelector('.ad-detail-wrapper');
    var inAllowedSurface = (drawer && drawer.contains(el)) ||
      !!el.closest('.assist-task-modal') ||
      !!el.closest('.main-vmok-plugin-modal__wrap') ||
      !!el.closest('[class*="paginationContainer"]') ||
      !!el.closest('.main-vmok-plugin-oc-popover-text__content') ||
      !!el.closest('.main-vmok-plugin-select__options') ||
      !!el.closest('.main-vmok-plugin-option__content') ||
      !!el.closest('.main-vmok-plugin-cascader-panel') ||
      !!el.closest('li.main-vmok-plugin-cascader-panel__selection-item');
    if (!inAllowedSurface) throw new Error(label + '不在允许操作的素材或追投界面内');
    if (typeof onBeforeClick === 'function') onBeforeClick();
    el.click();
    setPhase('已点击：' + label);
    await sleep(CLICK_SETTLE_MS);
  }

  function viewportChanged() {
    var locked = state.viewportLock;
    return !!locked && (
      locked.width !== window.innerWidth ||
      locked.height !== window.innerHeight ||
      locked.ratio !== window.devicePixelRatio ||
      locked.screenWidth !== window.screen.width ||
      locked.screenHeight !== window.screen.height ||
      locked.availableWidth !== window.screen.availWidth ||
      locked.availableHeight !== window.screen.availHeight
    );
  }

  function assertViewport() {
    if (viewportChanged()) {
      state.stopRequested = true;
      state.stopMessage = '浏览器窗口、屏幕分辨率或缩放比例改变，已停止后续操作';
    }
  }

  window.addEventListener('resize', function () {
    if (state.busy && viewportChanged() && !state.stopRequested) {
      state.stopRequested = true;
      state.stopMessage = '浏览器窗口、屏幕分辨率或缩放比例改变，已停止后续操作';
      addLog(state.stopMessage);
    }
  });

  function textMatch(root, selector, text, label) {
    return unique(Array.from(root.querySelectorAll(selector)).filter(function (el) {
      return exactText(el) === text;
    }), label);
  }

  function checkPlatformBlock() {
    var toolsModals = Array.from(document.querySelectorAll('.tools-vmok-plugin-modal__wrap')).filter(visible);
    if (toolsModals.some(function (el) {
      return !exactText(el).includes('开启联盟合作达人自动投') ||
        !exactText(el).includes('新建自动投放计划');
    })) throw new Error('出现了未知推广弹窗，已停止');
    var siteModals = Array.from(document.querySelectorAll('.main-vmok-plugin-modal__wrap')).filter(visible);
    if (siteModals.some(function (el) { return !el.classList.contains('assist-task-modal'); })) {
      throw new Error('出现了非追投弹窗，已停止');
    }
    var dialogs = Array.from(document.querySelectorAll('[role="dialog"], .main-vmok-plugin-modal__wrap'))
      .filter(visible).map(exactText).join(' ');
    if (/请输入验证码|滑块验证|登录已失效|登录失效|权限不足|访问受限|平台风控/.test(dialogs)) {
      throw new Error('检测到登录、验证、权限或平台风控提示');
    }
  }

  function context(requiredTab, ignoreLock) {
    checkPlatformBlock();
    var url = new URL(location.href);
    var livePlan = url.pathname === '/overall-prom/detail' && url.hash.includes('marGoal=2');
    var productPlan = url.pathname === '/overall-prom' && url.hash.includes('marGoal=1');
    if (url.origin !== 'https://qianchuan.jinritemai.com' || (!livePlan && !productPlan)) {
      throw new Error('不是千川乘方商品或直播计划素材页');
    }
    if (url.searchParams.get('campaignType') !== '1' || url.searchParams.get('uniTab') !== 'ad') {
      throw new Error('当前不是乘方在投计划路径');
    }
    var accountEl = unique(document.querySelectorAll('.account-info-box'), '账户信息');
    var accountText = exactText(accountEl);
    var accountIdMatch = accountText.match(/ID[：:]\s*(\d+)/);
    if (!accountIdMatch) throw new Error('无法读取当前账户 ID');
    var accountId = accountIdMatch[1];
    var accountName = accountText.slice(0, accountText.indexOf('ID')).trim();
    var drawer = unique(document.querySelectorAll('.ad-detail-wrapper'), '计划详情抽屉');
    var topLines = (drawer.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 12);
    var planName = livePlan ? topLines[2] : topLines[0] || '';
    var planIdMatch = topLines.join('\n').match(livePlan ? /计划ID[：:]\s*(\d+)/ : /ID[：:]\s*(\d+)/);
    if (!planIdMatch) throw new Error('无法读取当前计划 ID');
    var planId = planIdMatch[1];
    if (url.searchParams.get('aavid') !== accountId || url.searchParams.get('adId') !== planId) {
      throw new Error('网址与页面展示的账户或计划 ID 不一致');
    }
    if (!topLines.includes('投放中')) throw new Error('当前计划不是“投放中”');
    if (livePlan) {
      if (topLines[0] !== '推直播间' || !planName || !topLines.includes('直播大屏')) {
        throw new Error('当前计划不是推直播间计划');
      }
      if (requiredTab === 'creative' && !Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .some(function (el) { return exactText(el) === '视频' && el.className.includes('--checked'); })) {
        throw new Error('直播计划必须在“素材→视频”页');
      }
    } else {
      var goods = document.querySelector('[id$="-tab-1"][aria-selected="true"]');
      var activeTabs = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map(exactText);
      var oldSelfSelect = activeTabs.includes('商品自选');
      var newSelfSelect = activeTabs.includes('计划视图') &&
        Array.from(document.querySelectorAll('label')).some(function (label) {
          var radio = label.querySelector('input[type="radio"]');
          return visible(label) && exactText(label) === '商品自选' && radio && radio.checked;
        });
      if (!goods || !activeTabs.includes('商品') || !(oldSelfSelect || newSelfSelect)) {
        throw new Error('必须在“商品→商品自选”或“商品→计划视图→商品自选”的在投计划中');
      }
    }
    if (requiredTab) {
      var tab = drawer.querySelector('[id$="-tab-' + requiredTab + '"][aria-selected="true"]');
      if (!tab) throw new Error('当前计划抽屉未处于指定标签：' + requiredTab);
    }
    if (!ignoreLock && state.config.accountId && (
      accountId !== state.config.accountId ||
      accountName !== state.config.accountName ||
      planId !== state.config.planId ||
      planName !== state.config.planName ||
      (livePlan ? 'live' : 'product') !== state.config.planKind
    )) throw new Error('账户或计划已改变，已停止');
    return { drawer: drawer, accountId: accountId, accountName: accountName, planId: planId,
      planName: planName, planKind: livePlan ? 'live' : 'product' };
  }

  async function captureCurrent() {
    try {
      if (state.busy) throw new Error('执行过程中不能切换计划');
      await dismissKnownPromo();
      var current = context('creative', true);
      var changed = state.config.accountId !== current.accountId || state.config.planId !== current.planId ||
        state.config.planKind !== current.planKind;
      state.config.planKind = current.planKind;
      state.config.accountId = current.accountId;
      state.config.accountName = current.accountName;
      state.config.planId = current.planId;
      state.config.planName = current.planName;
      if (changed) {
        state.previewSelection = null;
        state.config.mode = 'roi';
        state.config.budget = 100;
        state.config.hours = 24;
        state.config.maxGroups = 10;
        state.config.roiGroupSize = 10;
        state.config.dateGroupSize = 20;
        state.config.roiThreshold = current.planKind === 'live' ? 2 : 1;
        state.config.roiStrategy = 'strict';
        state.config.startDate = '';
        state.config.endDate = '';
        state.config.dashPolicy = 'pause';
        state.config.skipControlling = true;
        state.config.bid = 10.5;
        state.config.liveGoal = '直播间成交';
        state.config.liveRoiTarget = '';
        state.config.liveGender = '不限';
        state.config.tailMin = 5;
      }
      state.config.dryRun = true;
      state.currentRun = null;
      state.report = '';
      state.phase = '已锁定当前' + (current.planKind === 'live' ? '直播' : '商品自选') + '计划；可主动再次创建追投任务';
      addLog('锁定 ' + current.accountName + ' → ' + current.planName + '（' + current.planId + '）');
    } catch (error) { setPhase('锁定失败：' + error.message); }
    render();
  }

  function filterChip(drawer, text) {
    return Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-filter-echo-item'))
      .some(function (el) { return exactText(el).replace(/\s+/g, '').includes(text.replace(/\s+/g, '')); });
  }

  async function ensureSourceFilter() {
    if (state.config.planKind === 'live') {
      context('creative');
      addLog('已确认直播素材→视频页');
      return;
    }
    var drawer = context('creative').drawer;
    if (filterChip(drawer, '素材类型：' + FILTER_LABEL)) return;
    var button = unique(drawer.querySelectorAll('.main-vmok-plugin-more-filter-btn button'), '素材页“更多筛选”按钮');
    if (!/^更多筛选(?:\s*\d+)?$/.test(exactText(button))) {
      throw new Error('“更多筛选”按钮文字无法识别：' + exactText(button));
    }
    await safeClick(button, '更多筛选');
    var item = await waitFor(function () {
      return Array.from(document.querySelectorAll('.main-vmok-plugin-body-title-item'))
        .filter(visible).find(function (el) { return exactText(el).includes('素材类型'); });
    }, '素材类型筛选');
    var popup = item.closest('.main-vmok-plugin-oc-popover-text__content');
    if (!popup || !visible(popup)) throw new Error('无法确认素材筛选面板');
    var selectInput = unique(
      item.querySelectorAll('.main-vmok-plugin-oc-filter-select-filter input.main-vmok-plugin-input[readonly][placeholder="请选择"]'),
      '素材类型“请选择”输入框'
    );
    await safeClick(selectInput, '素材类型“请选择”输入框');
    var option = await waitFor(function () {
      return Array.from(document.querySelectorAll('li.main-vmok-plugin-cascader-panel__selection-item'))
        .filter(visible).find(function (el) { return exactText(el) === FILTER_LABEL; });
    }, FILTER_LABEL + '选项');
    await safeClick(option, FILTER_LABEL + '选项');
    var confirm = textMatch(popup, 'button', '确定', '筛选“确定”按钮');
    await safeClick(confirm, '筛选确定');
    await waitFor(function () {
      return filterChip(context('creative').drawer, '素材类型：' + FILTER_LABEL);
    }, '自选素材筛选生效', 8000);
    addLog('素材类型已筛选为“' + FILTER_LABEL + '”');
  }

  function materialTable(drawer) {
    var head = unique(drawer.querySelectorAll('.main-vmok-plugin-table__head-wrapper table'), '素材表头');
    var body = unique(drawer.querySelectorAll('.main-vmok-plugin-table__body-wrapper table'), '素材表体');
    var headers = Array.from(head.querySelectorAll('thead tr:first-child th')).map(exactText);
    if (!(state.config.planKind === 'live' ? headers.includes('视频类型') && headers.includes('素材追投') && headers.includes('视频') :
      headers.includes('素材类型')) || !headers.includes('创建时间') ||
        (state.config.mode === 'roi' && !headers.includes('综合营销ROI'))) {
      throw new Error('素材表列已改变');
    }
    return { head: head, body: body, headers: headers };
  }

  function activeSort(table, label) {
    var candidates = Array.from(table.head.querySelectorAll('thead tr:first-child th')).filter(function (th) {
      return exactText(th) === label;
    });
    var th = unique(candidates, label + '列');
    return !!th.querySelector('.main-vmok-plugin-th__sorter-down--active');
  }

  function sortedPageSignature(label) {
    var drawer = context('creative').drawer;
    var table = materialTable(drawer);
    if (!activeSort(table, label)) return '';
    var column = table.headers.indexOf(label);
    if (column < 0) return '';
    var footer = unique(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
    var countMatch = exactText(footer).match(/共\s*(\d+)\s*条记录/);
    var sizeInput = unique(footer.querySelectorAll('.main-vmok-plugin-page-select input[readonly]'), '每页条数');
    var size = Number((sizeInput.value || '').match(/^\d+/)?.[0]);
    if (!countMatch || !Number.isInteger(size) || size < 1) return '';
    var expected = Math.min(size, Number(countMatch[1]) - (pageNumber(drawer) - 1) * size);
    var rows = Array.from(table.body.querySelectorAll('tbody tr')).filter(visible);
    if (expected < 1 || rows.length !== expected) return '';
    var previous = null;
    var signature = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = Array.from(rows[i].querySelectorAll(':scope > td'));
      if (cells.length !== table.headers.length) return '';
      var raw = exactText(cells[column]);
      var id = (exactText(cells[1]).match(/素材ID[：:]\s*(\d+)/) || [])[1];
      if (!id) return '';
      signature.push(id + ':' + raw);
      var value;
      if (label === '综合营销ROI') {
        if (/^[-—–\/]*$/.test(raw) || raw === '暂无数据') continue;
        value = Number(raw.replace(/,/g, ''));
        if (!Number.isFinite(value)) continue;
      } else {
        var date = raw.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
        if (!date) return '';
        value = date[0];
      }
      if (previous !== null && value > previous) return '';
      previous = value;
    }
    return signature.join('|');
  }

  async function waitForStableSort(label) {
    var lastSignature = '';
    var stableSince = 0;
    await waitFor(function () {
      var signature = '';
      try { signature = sortedPageSignature(label); } catch (_) { /* 页面切换中的短暂空表 */ }
      if (!signature) { lastSignature = ''; return false; }
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
        return false;
      }
       return Date.now() - stableSince >= 1500;
    }, label + '降序及整页数据稳定', 12000);
  }

  async function ensureSort(label) {
    var drawer = context('creative').drawer;
    var table = materialTable(drawer);
    if (!activeSort(table, label)) {
      var th = unique(Array.from(table.head.querySelectorAll('thead tr:first-child th')).filter(function (el) {
        return exactText(el) === label;
      }), label + '排序列');
      var down = unique(th.querySelectorAll('.main-vmok-plugin-th__sorter-down'), label + '降序箭头');
      await safeClick(down, label + '降序箭头');
    }
    await waitForStableSort(label);
    addLog('已确认“' + label + '降序”及整页数据稳定');
  }

  async function ensurePageSize(size) {
    var ready = await waitFor(function () {
      try {
        var drawer = context('creative').drawer;
        materialTable(drawer);
        var footer = unique(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
        var input = unique(footer.querySelectorAll('.main-vmok-plugin-page-select input[readonly]'), '每页条数');
        return { footer: footer, input: input };
      } catch (_) { return false; }
    }, '素材表格和分页栏加载', 30000);
    var footer = ready.footer;
    var input = ready.input;
    if (input.value !== size + '条/页') {
      await safeClick(input, '每页条数');
      var option = await waitFor(function () {
        return Array.from(document.querySelectorAll('.main-vmok-plugin-select__options .main-vmok-plugin-option__content'))
          .filter(visible).find(function (el) { return exactText(el) === size + '条/页'; });
      }, size + '条/页选项');
      await safeClick(option, size + '条/页选项');
    }
    await waitFor(function () {
      try {
        var drawer = context('creative').drawer;
        var f = unique(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
        var i = unique(f.querySelectorAll('.main-vmok-plugin-page-select input[readonly]'), '每页条数');
        if (i.value !== size + '条/页') return false;
        var countMatch = exactText(f).match(/共\s*(\d+)\s*条记录/);
        if (!countMatch) return false;
        var currentPage = pageNumber(drawer);
        var expected = Math.min(size, Number(countMatch[1]) - (currentPage - 1) * size);
        var count = materialTable(drawer).body.querySelectorAll('tbody tr').length;
        return expected > 0 && count === expected;
      } catch (_) { return false; }
    }, '每页' + size + '条及对应素材行生效', 30000);
    addLog('每页条数已设置为' + size);
  }

  function rowsNow() {
    var drawer = context('creative').drawer;
    if (state.config.planKind !== 'live' && !filterChip(drawer, '素材类型：' + FILTER_LABEL)) {
      throw new Error('自选素材筛选已失效');
    }
    var table = materialTable(drawer);
    var sortLabel = state.config.mode === 'roi' ? '综合营销ROI' : '创建时间';
    if (!activeSort(table, sortLabel)) throw new Error('翻页后无法确认' + sortLabel + '降序');
    var hi = {
      op: table.headers.indexOf('操作'),
      audit: table.headers.includes('审核状态') ? table.headers.indexOf('审核状态') :
        table.headers.indexOf('素材状态'),
      source: table.headers.indexOf(state.config.planKind === 'live' ? '视频类型' : '素材类型'),
      chasing: table.headers.indexOf('素材追投'),
      date: table.headers.indexOf('创建时间'),
      roi: table.headers.indexOf('综合营销ROI')
    };
    if ([hi.op, hi.audit, hi.source, hi.date].some(function (v) { return v < 0; }) ||
        (state.config.mode === 'roi' && hi.roi < 0)) throw new Error('素材表缺少必需列');
    var seen = new Set();
    var rows = Array.from(table.body.querySelectorAll('tbody tr')).filter(visible).map(function (tr) {
      var cells = Array.from(tr.querySelectorAll(':scope > td'));
      if (cells.length !== table.headers.length) throw new Error('素材行列数与表头不一致');
      var idMatches = Array.from(exactText(cells[1]).matchAll(/素材ID[：:]\s*(\d+)/g));
      if (!idMatches.length) throw new Error('无法读取素材 ID');
      var id = idMatches[idMatches.length - 1][1];
      if (seen.has(id)) throw new Error('同页出现重复素材 ID：' + id);
      seen.add(id);
      var roiRaw = hi.roi >= 0 ? exactText(cells[hi.roi]) : '';
      var roi = null;
      if (state.config.mode === 'roi') {
        roi = /^[-—–\/]*$/.test(roiRaw) || roiRaw === '暂无数据' ? null : Number(roiRaw.replace(/,/g, ''));
        if (roi !== null && !Number.isFinite(roi)) roi = null;
      }
      var dateRaw = exactText(cells[hi.date]);
      var dateMatch = dateRaw.match(/\d{4}-\d{2}-\d{2}/);
      if (!dateMatch) throw new Error('无法解析素材创建日期：' + id);
      var check = cells[0].querySelector('input[type="checkbox"]');
      if (!check) throw new Error('找不到素材勾选框：' + id);
      return {
        id: id,
        row: tr,
        check: check,
        source: exactText(cells[hi.source]),
        audit: exactText(cells[hi.audit]),
        chasing: hi.chasing < 0 ? '' : exactText(cells[hi.chasing]),
        operation: exactText(cells[hi.op]),
        date: dateMatch[0],
        roi: roi,
        roiRaw: roiRaw
      };
    });
    if (!rows.length) throw new Error('当前素材页没有可读取的行');
    for (var i = 1; i < rows.length; i++) {
      if (state.config.mode === 'date' && rows[i].date > rows[i - 1].date) {
        throw new Error('当前页创建日期不是降序');
      }
      if (state.config.mode === 'roi' && rows[i].roi !== null && rows[i - 1].roi !== null &&
          rows[i].roi > rows[i - 1].roi) {
        throw new Error('当前页综合营销 ROI 不是降序');
      }
    }
    return { drawer: drawer, table: table, rows: rows };
  }

  function validateRows(rows) {
    rows.forEach(function (item) {
      if (!eligibleForChase(item)) throw new Error('素材 ' + item.id + ' 当前状态不可追投：审核“' +
        item.audit + '”、素材追投“' + item.chasing + '”');
      if (state.config.planKind === 'live') {
        if (!item.source) throw new Error('素材 ' + item.id + ' 的视频类型为空');
        if (!item.operation.includes('追投')) throw new Error('素材 ' + item.id + ' 没有追投入口');
      } else if (item.source !== SOURCE_LABEL) throw new Error('素材 ' + item.id + ' 不是自选投放素材');
    });
  }

  async function waitForProductRowsReady() {
    var lastIssue = '素材行或追投入口仍在加载';
    var waitingShown = false;
    function waiting() {
      if (!waitingShown) {
        setPhase('等待商品素材行和追投入口加载（最多25秒）');
        waitingShown = true;
      }
    }
    try {
      return await waitFor(function () {
        assertViewport();
        if (state.stopRequested) throw new Error(state.stopMessage);
        try {
          var bundle = rowsNow();
          var label = state.config.mode === 'roi' ? '综合营销ROI' : '创建时间';
          if (!sortedPageSignature(label)) {
            lastIssue = label + '排序或整页素材尚未加载完成';
            waiting();
            return false;
          }
          validateRows(bundle.rows.filter(eligibleForChase));
          return bundle;
        } catch (error) {
          lastIssue = error.message;
          waiting();
          return false;
        }
      }, '商品素材行及追投入口加载', 25000);
    } catch (error) {
      if (error.message.startsWith('等待超时：')) {
        throw new Error('商品素材列表25秒后仍未就绪：' + lastIssue + '；未勾选下一组');
      }
      throw error;
    }
  }

  function chaseStatusKnown(item) {
    return /未追投|调控中|调控结束|追投结束|已结束|已完成|已追投|已暂停/.test(item.chasing.replace(/\s+/g, ''));
  }

  async function waitForLiveStatusPage(minStableMs) {
    var stableSignature = '';
    var stableSince = 0;
    var dataLabel = state.config.mode === 'roi' ? '综合营销ROI' : '创建时间';
    var lastIssue = dataLabel + '或素材追投状态仍在刷新';
    setPhase('等待直播素材' + dataLabel + '与“素材追投”状态刷新（最多30秒）');
    try {
      return await waitFor(function () {
        assertViewport();
        if (state.stopRequested) throw new Error(state.stopMessage);
        var bundle;
        try { bundle = rowsNow(); } catch (error) {
          stableSignature = '';
          lastIssue = error.message;
          return false;
        }
        var firstSelectable = bundle.rows.find(function (item) { return !materialBlocked(item); });
        if (state.config.mode === 'roi' && firstSelectable && firstSelectable.roi === null) {
          stableSignature = '';
          lastIssue = '当前页首条可选素材的综合营销ROI尚未显示有效数字';
          return false;
        }
        var invalidRoiSeen = false;
        for (var i = 0; i < bundle.rows.length; i++) {
          var item = bundle.rows[i];
          if (materialBlocked(item)) continue;
          if (!item.audit || item.audit === '-') {
            stableSignature = '';
            lastIssue = '素材 ' + item.id + ' 的审核状态尚未显示';
            return false;
          }
          if (state.config.mode === 'roi') {
            if (item.roi === null) invalidRoiSeen = true;
            else if (invalidRoiSeen) {
              stableSignature = '';
              lastIssue = '当前页 ROI 数值与无效值仍在重新排序';
              return false;
            }
          }
          if (!chaseStatusKnown(item)) {
            stableSignature = '';
            lastIssue = '素材 ' + item.id + ' 的“素材追投”状态' +
              (item.chasing ? '未识别：' + item.chasing : '尚未显示');
            return false;
          }
        }
        var signature = bundle.rows.map(function (item) {
          return [item.id, item.roiRaw, item.date, item.audit, item.chasing].join(':');
        }).join('|');
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
          return false;
        }
        var stableMs = minStableMs || (Date.now() - state.lastConfirmedRefreshAt < 15000 ? 250 : 1800);
        return Date.now() - stableSince >= stableMs ? bundle : false;
      }, '直播素材' + dataLabel + '与追投状态刷新完成', 30000);
    } catch (error) {
      if (error.message.startsWith('等待超时：')) {
        var notReady = new Error('等待直播素材' + dataLabel + '与追投状态30秒后仍未就绪：' + lastIssue + '；未勾选或提交当前组');
        notReady.code = 'LIVE_DATA_NOT_READY';
        throw notReady;
      }
      throw error;
    }
  }

  async function waitForLiveReadyGroup(ids, expectedPage, expectedPageIds) {
    var stableSignature = '';
    var stableSince = 0;
    var changedPageSignature = '';
    var changedPageSince = 0;
    var lastIssue = '素材行仍在刷新';
    setPhase('等待第' + expectedPage + '页素材追投入口刷新（最多15秒）');
    try {
      return await waitFor(function () {
        assertViewport();
        if (state.stopRequested) throw new Error(state.stopMessage);
        var bundle, currentPage;
        try {
          bundle = rowsNow();
          currentPage = pageNumber(bundle.drawer);
        } catch (error) {
          stableSignature = '';
          lastIssue = error.message;
          return false;
        }
        if (currentPage !== expectedPage) {
          stableSignature = '';
          lastIssue = '当前页码已变化';
          return false;
        }
        var currentPageSignature = bundle.rows.map(function (row) { return row.id; }).join('|');
        if (currentPageSignature !== expectedPageIds.join('|')) {
          stableSignature = '';
          lastIssue = '当前页素材或顺序仍在变化';
          if (currentPageSignature !== changedPageSignature) {
            changedPageSignature = currentPageSignature;
            changedPageSince = Date.now();
            return false;
          }
          if (Date.now() - changedPageSince >= 1200) {
            var changed = new Error('第' + expectedPage + '页素材顺序已更新，须重新选材');
            changed.code = 'LIVE_PAGE_REORDERED';
            throw changed;
          }
          return false;
        }
        changedPageSignature = '';
        var chosen = [];
        for (var i = 0; i < ids.length; i++) {
          var row = bundle.rows.find(function (item) { return item.id === ids[i]; });
          if (!row || (!materialBlocked(row) &&
              (!row.audit || row.audit === '-' || !row.source ||
                !row.operation.includes('追投') || !chaseStatusKnown(row)))) {
            stableSignature = '';
            lastIssue = '素材 ' + ids[i] + ' 的视频类型、追投状态或追投入口尚未显示';
            return false;
          }
          chosen.push(row);
        }
        var signature = chosen.map(function (row) {
          return [row.id, row.source, row.operation, row.audit, row.chasing, row.roiRaw, row.date].join(':');
        }).join('|');
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
          return false;
        }
        return Date.now() - stableSince >=
          (Date.now() - state.lastConfirmedRefreshAt < 15000 ? 250 : 1000) ?
          { bundle: bundle, chosen: chosen } : false;
      }, '直播素材追投入口刷新完成', 15000);
    } catch (error) {
      if (error.message.startsWith('等待超时：')) {
        throw new Error('第' + expectedPage + '页等待追投入口15秒后仍未就绪：' + lastIssue + '；未勾选或提交当前组');
      }
      throw error;
    }
  }

  function materialBlocked(item) {
    return /审核(?:不|未)通过/.test(item.audit || '') ||
      /已暂停/.test((item.audit || '') + ' ' + (item.chasing || ''));
  }

  function eligibleForChase(item) {
    // 商品的审核状态和单行操作入口不作为选材门槛；平台弹窗会再次核对实际接收的素材 ID。
    if (state.config.planKind !== 'live') return true;
    if (materialBlocked(item)) return false;
    if (!item.audit || item.audit === '-') throw new Error('素材 ' + item.id + ' 的审核状态无法确认');
    // 新增素材可能明确显示“未审核”；只在日期模式且日期落入所选范围时放行。
    // 初选、勾选前校验和提交前复核共用此判断，避免复核时又被取消勾选。
    var dateUnreviewed = state.config.mode === 'date' &&
      (item.audit || '').replace(/\s+/g, '') === '未审核' &&
      !!item.date && item.date >= state.config.startDate && item.date <= state.config.endDate;
    if (!/审核通过/.test(item.audit) && !dateUnreviewed) return false;
    if (!chaseStatusKnown(item)) throw new Error('素材 ' + item.id + ' 的追投状态无法确认');
    return !state.config.skipControlling || !/调控中|正在调控/.test(item.chasing.replace(/\s+/g, ''));
  }

  function selectedCount(drawer) {
    var match = (drawer.innerText || '').match(/已选\s*(\d+)\s*个/);
    return match ? Number(match[1]) : 0;
  }

  function assertRowsStillEligible(ids) {
    var latest = rowsNow().rows;
    ids.forEach(function (id) {
      var item = latest.find(function (row) { return row.id === id; });
      var eligible = false;
      try { eligible = !!item && eligibleForChase(item); } catch (_) { /* 列刷新中，按状态变化重读 */ }
      if (!item || (state.config.planKind === 'live' && !item.operation.includes('追投')) ||
          (state.config.planKind === 'live' ? !item.source : item.source !== SOURCE_LABEL) ||
          !eligible) {
        var error = new Error('素材 ' + id + ' 的来源或可选状态在勾选前变化');
        error.code = 'LIVE_SELECTION_CHANGED';
        throw error;
      }
    });
  }

  async function clearAttemptSelection(ids, expectedPage) {
    var bundle = await waitFor(function () {
      try {
        var current = rowsNow();
        return pageNumber(current.drawer) === expectedPage ? current : false;
      } catch (_) { return false; }
    }, '返回未提交组的素材页', 10000);
    var checked = bundle.rows.filter(function (item) { return item.check.checked; });
    var allowed = new Set(ids);
    if (checked.some(function (item) { return !allowed.has(item.id); })) {
      throw new Error('选材时出现本组以外的勾选，禁止继续');
    }
    if (!checked.length) {
      if (selectedCount(bundle.drawer) !== 0) throw new Error('选材数量与勾选框不一致，禁止继续');
      return;
    }
    for (var i = 0; i < checked.length; i++) {
      await clickMaterialCheckbox(checked[i].id, false, checked.length - i);
    }
    await waitFor(function () {
      var current = rowsNow();
      return selectedCount(current.drawer) === 0 &&
        current.rows.every(function (item) { return !item.check.checked; });
    }, '未提交组的勾选清零', 10000);
  }

  async function clickMaterialCheckbox(id, shouldCheck, expectedBefore) {
    await dismissKnownPromo();
    assertViewport();
    if (state.stopRequested) throw new Error(state.stopMessage);
    var ready = await waitFor(function () {
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      var bundle;
      try { bundle = rowsNow(); } catch (_) { return false; }
      var item = bundle.rows.find(function (row) { return row.id === id; });
      if (!item || !visible(item.check) || !bundle.drawer.contains(item.check) ||
          selectedCount(bundle.drawer) !== expectedBefore || item.check.checked === shouldCheck) return false;
      if (shouldCheck && state.config.planKind === 'live' && (!item.audit || item.audit === '-')) return false;
      if (shouldCheck && state.config.planKind !== 'live' && item.source !== SOURCE_LABEL) return false;
      if (shouldCheck && state.config.planKind === 'live' && !materialBlocked(item) &&
          (!item.source || !item.operation.includes('追投') || !chaseStatusKnown(item))) return false;
      return { bundle: bundle, item: item };
    }, '素材 ' + id + ' 的勾选框、审核状态及追投入口就绪', shouldCheck && state.config.planKind === 'live' ? 30000 : 10000).catch(function (error) {
      if (shouldCheck && state.config.planKind === 'live' && error.message.startsWith('等待超时：')) {
        error.code = 'LIVE_DATA_NOT_READY';
      }
      throw error;
    });
    if (shouldCheck) assertRowsStillEligible([id]);
    assertViewport();
    if (state.stopRequested) throw new Error(state.stopMessage);
    ready.item.check.click();
    var expectedAfter = expectedBefore + (shouldCheck ? 1 : -1);
    await waitFor(function () {
      var current;
      try { current = rowsNow(); } catch (_) { return false; }
      var latest = current.rows.find(function (row) { return row.id === id; });
      return latest && latest.check.checked === shouldCheck &&
        selectedCount(current.drawer) === expectedAfter;
    }, '素材 ' + id + (shouldCheck ? '勾选' : '取消勾选') + '生效', 5000);
  }

  async function selectRows(bundle, chosen, alreadySelected) {
    var rows = bundle.rows;
    validateRows(chosen);
    if (selectedCount(bundle.drawer) !== alreadySelected) {
      throw new Error('选中素材数量与脚本记录不一致');
    }
    if (chosen.length === rows.length && alreadySelected === 0) {
      var headerCheck = unique(bundle.table.head.querySelectorAll('input[type="checkbox"]'), '素材表头全选');
      if (headerCheck.checked) throw new Error('表头此前已经勾选');
      await safeClick(headerCheck, '素材表头全选', false, function () {
        assertRowsStillEligible(chosen.map(function (item) { return item.id; }));
      });
    } else {
      for (var i = 0; i < chosen.length; i++) {
        if (i === 0 || (i + 1) % 5 === 0) {
          setPhase('正在勾选素材 ' + (i + 1) + '/' + chosen.length);
        }
        await clickMaterialCheckbox(chosen[i].id, true, alreadySelected + i);
      }
    }
    var wanted = alreadySelected + chosen.length;
    await waitFor(function () {
      return selectedCount(context('creative').drawer) === wanted;
    }, '已选' + wanted + '条素材');
    if (chosen.length === rows.length && alreadySelected === 0) {
      if (rows.some(function (item) { return !item.check.checked; })) {
        throw new Error('表头全选后有素材未勾选');
      }
    } else {
      var latest = rowsNow().rows;
      if (chosen.some(function (item) {
        var current = latest.find(function (row) { return row.id === item.id; });
        return !current || !current.check.checked;
      })) throw new Error('整组素材勾选状态与目标 ID 不一致');
    }
  }

  async function clearPreviewSelection() {
    var current = context('creative');
    var drawer = current.drawer;
    var saved = state.previewSelection;
    var count = selectedCount(drawer);
    if (!saved) {
      if (count !== 0) throw new Error('页面存在非本次演练的遗留勾选，请先手动取消');
      return;
    }
    if (saved.accountId !== current.accountId || saved.planId !== current.planId) {
      throw new Error('演练后账户或计划已变化，无法安全清除勾选');
    }
    if (count === 0) {
      state.previewSelection = null;
      return;
    }
    if (pageNumber(drawer) !== saved.page || count !== saved.ids.length) {
      throw new Error('演练勾选的页码或数量已变化，请手动核对并取消勾选');
    }
    var table = materialTable(drawer);
    var rows = Array.from(table.body.querySelectorAll('tbody tr')).filter(visible).map(function (tr) {
      var cells = Array.from(tr.querySelectorAll(':scope > td'));
      var match = (exactText(cells[1]).match(/素材ID[：:]\s*(\d+)/g) || []);
      var id = match.length ? (match[match.length - 1].match(/\d+/) || [])[0] : '';
      var check = cells[0] && cells[0].querySelector('input[type="checkbox"]');
      if (!id || !check) throw new Error('无法核对演练勾选的素材行');
      return { id: id, check: check };
    });
    var checked = rows.filter(function (item) { return item.check.checked; });
    if (!sameIds(checked.map(function (item) { return item.id; }), saved.ids)) {
      throw new Error('当前勾选素材与演练记录不一致，请手动核对并取消勾选');
    }
    if (checked.length === rows.length) {
      var headerCheck = unique(table.head.querySelectorAll('input[type="checkbox"]'), '素材表头全选');
      if (!headerCheck.checked) throw new Error('表头全选状态不一致，未清除演练勾选');
      await safeClick(headerCheck, '取消演练表头全选');
    } else {
      for (var i = 0; i < checked.length; i++) {
        await clickMaterialCheckbox(checked[i].id, false, checked.length - i);
      }
    }
    await waitFor(function () {
      return selectedCount(context('creative').drawer) === 0;
    }, '演练勾选全部清除');
    state.previewSelection = null;
    addLog('已核对并清除上一轮演练的' + saved.ids.length + '条勾选');
  }

  async function previewCurrentPage(retries) {
    var cfg = state.config;
    var bundle = cfg.planKind === 'live' ? await waitForLiveStatusPage() : await waitForProductRowsReady();
    if (selectedCount(bundle.drawer) !== 0) throw new Error('当前页存在遗留勾选，演练未继续');
    var size = cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize;
    var chosen = [];
    var detail = '';
    if (cfg.mode === 'date') {
      var dateRows = bundle.rows.filter(function (item) {
        return item.date >= cfg.startDate && item.date <= cfg.endDate && eligibleForChase(item);
      });
      chosen = dateRows.slice(0, size);
      if (chosen.length < size && chosen.length < cfg.tailMin) {
        detail = '本页仅有' + chosen.length + '条区间内素材，不足一组且低于尾组' + cfg.tailMin + '条下限；未勾选';
        chosen = [];
      }
    } else if (cfg.roiStrategy === 'strict') {
      for (var i = 0; i < bundle.rows.length && chosen.length < size; i++) {
        if (!eligibleForChase(bundle.rows[i])) continue;
        if (bundle.rows[i].roi === null || bundle.rows[i].roi < cfg.roiThreshold) break;
        chosen.push(bundle.rows[i]);
      }
    } else {
      var selectableRows = bundle.rows.filter(eligibleForChase);
      var hasBelow = selectableRows.some(function (item) {
        return item.roi !== null && item.roi < cfg.roiThreshold;
      });
      var hasDash = selectableRows.some(function (item) { return item.roi === null; });
      if (hasDash && !hasBelow && cfg.dashPolicy === 'pause') {
        detail = '本页 ROI 出现“—”，按当前策略暂停；未勾选';
      } else {
        chosen = selectableRows.slice(0, size);
      }
    }
    if (cfg.planKind === 'live' && chosen.length) {
      var ready = await waitForLiveReadyGroup(chosen.map(function (item) { return item.id; }),
        pageNumber(bundle.drawer), bundle.rows.map(function (item) { return item.id; }));
      bundle = ready.bundle;
      chosen = ready.chosen;
      if (chosen.some(function (item) { return !eligibleForChase(item); })) {
        if ((retries || 0) >= 2) throw new Error('演练选材时追投状态持续变化，未勾选；请稍后重试');
        addLog('演练选材时有素材变为调控中、已暂停或审核不通过，重新筛选当前页');
        return previewCurrentPage((retries || 0) + 1);
      }
      validateRows(chosen);
    }
    if (chosen.length) {
      await selectRows(bundle, chosen, 0);
      state.previewSelection = {
        accountId: cfg.accountId,
        planId: cfg.planId,
        page: pageNumber(bundle.drawer),
        ids: chosen.map(function (item) { return item.id; })
      };
    }
    state.report = [
      '演练完成：只检查当前页；未打开追投弹窗，未提交任务。',
      '账户：' + cfg.accountName,
      '计划：' + cfg.planName,
      cfg.mode === 'date' ? '创建日期区间：' + cfg.startDate + ' 至 ' + cfg.endDate + '（含两端）' :
        'ROI 阈值：≥' + cfg.roiThreshold,
      '当前页：第' + pageNumber(bundle.drawer) + '页；本页素材：' + bundle.rows.length + '条',
      '本页勾选：' + chosen.length + '/' + size + '条' + (chosen.length && chosen.length < size ? '（当前页不足设定组数）' : ''),
      detail || (chosen.length ? '素材 ID：' + chosen.map(function (item) { return item.id; }).join('、') : '当前页没有符合条件的素材'),
      '如开始正式执行，脚本会先核对并清除本次演练勾选，然后重新选材。'
    ].join('\n');
    setPhase(chosen.length ? '演练完成；已勾选一组示范素材，未提交' : '演练完成；本页未勾选，未提交');
    addLog('演练当前页勾选' + chosen.length + '条；未提交');
  }

  function setInputValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  function sameIds(a, b) {
    return a.length === b.length && a.slice().sort().join('|') === b.slice().sort().join('|');
  }

  function assertSelectedGroup(ids) {
    var bundle = rowsNow();
    var checked = bundle.rows.filter(function (item) { return item.check.checked; });
    var checkedIds = checked.map(function (item) { return item.id; });
    if (selectedCount(bundle.drawer) !== ids.length || !sameIds(checkedIds, ids)) {
      throw new Error('追投前勾选素材已变化，禁止继续点击');
    }
    validateRows(checked);
  }

  async function openChaseModal(ids) {
    for (var attempt = 1; attempt <= 2; attempt++) {
      var opened = Array.from(document.querySelectorAll('.assist-task-modal')).filter(visible);
      if (opened.length) return unique(opened, '追投素材弹窗');
      assertSelectedGroup(ids);
      var button = await waitFor(function () {
        try { return textMatch(context('creative').drawer, 'button', '追投', '已选素材工具栏追投按钮'); }
        catch (_) { return false; }
      }, '已选素材工具栏追投按钮加载', 10000);
      var clicked = false;
      try {
        await safeClick(button, '素材工具栏追投', false, function () {
          assertSelectedGroup(ids);
          clicked = true;
        });
      } catch (clickError) {
        if (clicked || attempt === 2 || state.stopRequested) throw clickError;
        assertSelectedGroup(ids);
        addLog('追投入口在点击前变化；已复核当前组选材，重试打开一次');
        await sleep(350);
        continue;
      }
      try {
        return await waitFor(function () {
          return Array.from(document.querySelectorAll('.assist-task-modal')).filter(visible)[0];
        }, '追投素材弹窗', 5000);
      } catch (error) {
        if (Array.from(document.querySelectorAll('.assist-task-modal')).some(visible)) throw error;
        if (attempt === 2 || state.stopRequested) throw error;
        assertSelectedGroup(ids);
        addLog('追投弹窗未打开；已复核当前组选材，重试打开一次');
        await sleep(350);
      }
    }
    throw new Error('追投弹窗未打开');
  }

  async function waitForPostSubmitRefresh(before) {
    var started = Date.now();
    var lastSignature = '';
    var stableSince = 0;
    var refreshObserved = false;
    var label = state.config.mode === 'roi' ? '综合营销ROI' : '创建时间';
    var kind = state.config.planKind === 'live' ? '直播' : '商品';
    setPhase('已见操作成功；等待' + kind + '素材列表刷新就绪（最多25秒）');
    while (Date.now() - started < 25000) {
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      var bundle, currentPage, count, signature;
      try {
        bundle = rowsNow();
        currentPage = pageNumber(bundle.drawer);
        count = selectedCount(bundle.drawer);
        signature = sortedPageSignature(label);
        if (state.config.planKind !== 'live') validateRows(bundle.rows.filter(eligibleForChase));
        if (signature) {
          signature += '|' + bundle.rows.map(function (item) {
            return [item.id, item.source, item.operation, item.audit, item.chasing].join(':');
          }).join('|');
        }
      } catch (_) {
        lastSignature = '';
        stableSince = 0;
        await sleep(250);
        continue;
      }
      if (currentPage !== before.page) {
        throw new Error('提交后千川自动刷新改变了素材页码，已停止以防漏选或重复追投');
      }
      var firstRow = bundle.table.body.querySelector('tbody tr');
      if (!before.firstRow.isConnected || !before.body.isConnected ||
          bundle.table.body !== before.body || firstRow !== before.firstRow ||
          (before.selectedCount > 0 && count === 0)) refreshObserved = true;
      var selectionReady = state.config.planKind === 'live' ||
        (count === 0 && bundle.rows.every(function (item) { return !item.check.checked; }));
      var liveDataReady = state.config.planKind !== 'live' ||
        bundle.rows.every(function (item) {
          return materialBlocked(item) || (item.audit && item.audit !== '-' && chaseStatusKnown(item));
        });
      if (!refreshObserved || !signature || !selectionReady || !liveDataReady) {
        lastSignature = '';
        stableSince = 0;
      } else if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 250) {
        state.lastConfirmedRefreshAt = Date.now();
        addLog(kind + '素材列表已重新加载且数据就绪；继续下一组');
        return;
      }
      await sleep(250);
    }
    throw new Error(kind + '计划提交成功，但25秒内无法确认素材列表已刷新就绪；已停止，禁止直接重提上一组');
  }

  function taskName(groupNo) {
    var d = new Date();
    var day = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
    return (state.config.planKind === 'live' ? 'QCL_' : 'QC_') + day + '_' + state.config.mode.toUpperCase() + '_' + state.config.planId + '_' +
      String(groupNo).padStart(2, '0') + '_' + Date.now().toString(36);
  }

  function selectedRadio(modal, label) {
    return unique(Array.from(modal.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(function (el) { return exactText(el) === label && visible(el); }), label + '选项');
  }

  async function fillLiveModal(modal, name) {
    var cfg = state.config;
    var cost = selectedRadio(modal, '控成本追投');
    if (!cost.className.includes('--checked')) await safeClick(cost, '控成本追投');
    var goal = selectedRadio(modal, cfg.liveGoal);
    if (!goal.className.includes('--checked')) await safeClick(goal, cfg.liveGoal);
    if (!selectedRadio(modal, '控成本追投').className.includes('--checked') ||
        !selectedRadio(modal, cfg.liveGoal).className.includes('--checked')) {
      throw new Error('直播追投方式或优化目标未选中');
    }
    var budget = unique(Array.from(modal.querySelectorAll('input.main-vmok-plugin-input[placeholder="请输入"]')).filter(visible), '直播调控日预算输入框');
    var bid = cfg.liveGoal === '直播间成交' ?
      unique(Array.from(modal.querySelectorAll('input.main-vmok-plugin-input[placeholder="请输入期望的成交成本"]')).filter(visible), '直播我的出价输入框') :
      unique(Array.from(modal.querySelectorAll('input')).filter(function (el) {
        return visible(el) && /综合营销\s*ROI/.test(el.getAttribute('placeholder') || '');
      }), '直播综合营销ROI目标输入框');
    var nameInput = unique(modal.querySelectorAll('input.main-vmok-plugin-input[placeholder="请输入任务名称，1-50个字符"]'), '直播任务名称输入框');
    var target = cfg.liveGoal === '直播间成交' ? cfg.bid : Number(cfg.liveRoiTarget);
    setInputValue(budget, cfg.budget);
    setInputValue(bid, target);
    setInputValue(nameInput, name);
    if (Number(budget.value) !== cfg.budget || Number(bid.value) !== target || nameInput.value !== name) {
      throw new Error('直播预算、出价或任务名称未写入');
    }
    var audienceButton = textMatch(modal, 'button', '+ 设置定向', '设置定向按钮');
    await safeClick(audienceButton, '设置定向');
    var panel = await waitFor(function () {
      return Array.from(modal.querySelectorAll('.panel.drill-content')).filter(visible)[0];
    }, '设置定向面板');
    var genderRow = unique(Array.from(panel.querySelectorAll('.main-vmok-plugin-oc-row-radio'))
      .filter(function (el) { return exactText(el).startsWith('性别 '); }), '性别定向行');
    var gender = selectedRadio(genderRow, cfg.liveGender);
    if (!gender.className.includes('--checked')) await safeClick(gender, '定向性别' + cfg.liveGender);
    if (!selectedRadio(genderRow, cfg.liveGender).className.includes('--checked')) throw new Error('性别' + cfg.liveGender + '未选中');
    var confirm = textMatch(panel, 'button', '确定', '定向确定按钮');
    await safeClick(confirm, '确定性别' + cfg.liveGender + '定向');
    await waitFor(function () { return !visible(panel); }, '定向面板关闭');
    return { budgetInput: budget, bidInput: bid, nameInput: nameInput, target: target, goal: cfg.liveGoal, gender: cfg.liveGender,
      genderVerified: true };
  }

  async function submitGroup(items) {
    var cfg = state.config;
    var drawer = context('creative').drawer;
    if (items.length < 1 || items.length > 20) throw new Error('单组素材数量越界');
    if (selectedCount(drawer) !== items.length) throw new Error('提交前已选数量不匹配');
    var selectedIds = items.map(function (x) { return x.id; });
    var submittedThisRun = new Set();
    state.currentRun.groups.forEach(function (group) {
      if (group.uiSuccess) {
        (group.ids || []).forEach(function (id) { submittedThisRun.add(id); });
        (group.platformSkippedIds || []).forEach(function (id) { submittedThisRun.add(id); });
      }
    });
    var repeated = selectedIds.find(function (id) { return submittedThisRun.has(id); });
    if (repeated) throw new Error('素材 ' + repeated + ' 在本轮已显示追投成功，禁止再次提交');
    var modal = await openChaseModal(selectedIds);
    if (!exactText(modal).includes('追投素材')) throw new Error('打开的不是追投素材弹窗');
    var modalSignature = '';
    var modalStableSince = 0;
    var modalAudit = await waitFor(function () {
      var content = exactText(modal);
      var countMatch = content.match(/已添加[：:]\s*(\d+)\s*\/\s*20/);
      var modalIds = Array.from(content.matchAll(/素材ID[：:]\s*(\d+)/g)).map(function (m) { return m[1]; });
      var filterMatch = content.match(/已为您过滤\s*(\d+)\s*个\s*不符合条件的视频/);
      var accepted = countMatch ? Number(countMatch[1]) : -1;
      var skippedIds = selectedIds.filter(function (id) { return !modalIds.includes(id); });
      var valid = visible(modal) && accepted > 0 && accepted === modalIds.length &&
        new Set(modalIds).size === modalIds.length &&
        modalIds.every(function (id) { return selectedIds.includes(id); }) &&
        (accepted === selectedIds.length ? !filterMatch && sameIds(modalIds, selectedIds) :
          !!filterMatch && Number(filterMatch[1]) === skippedIds.length);
      if (!valid) { modalSignature = ''; modalStableSince = 0; return false; }
      var signature = modalIds.join('|') + '/' + skippedIds.join('|');
      if (signature !== modalSignature) { modalSignature = signature; modalStableSince = Date.now(); return false; }
      return Date.now() - modalStableSince >= 800 ? { acceptedIds: modalIds, skippedIds: skippedIds } : false;
    }, '千川弹窗已接收素材清单稳定', 10000).catch(function (error) {
      var content = exactText(modal);
      var count = (content.match(/已添加[：:]\s*(\d+)\s*\/\s*20/) || [])[1] || '未读到';
      throw new Error('勾选' + selectedIds.length + '条，弹窗已添加' + count + '条；未能核对平台过滤提示和素材 ID，未提交：' + error.message);
    });
    var acceptedIds = modalAudit.acceptedIds;
    var skippedIds = modalAudit.skippedIds;
    if (skippedIds.length) addLog('千川明确过滤' + skippedIds.length + '条不符合条件素材：' + skippedIds.join('、') + '；本组按弹窗实际接收的' + acceptedIds.length + '条提交');
    function assertModalSelection() {
      var current = rowsNow();
      var checked = current.rows.filter(function (item) { return item.check.checked; });
      var checkedIds = checked.map(function (item) { return item.id; });
      var count = selectedCount(current.drawer);
      if (count === selectedIds.length && sameIds(checkedIds, selectedIds)) {
        validateRows(checked);
        return;
      }
      if (skippedIds.length && count === acceptedIds.length && sameIds(checkedIds, acceptedIds)) {
        validateRows(checked);
        return;
      }
      throw new Error('千川过滤后素材表勾选与追投弹窗不一致，禁止提交');
    }
    var name = taskName(state.currentRun.groups.length + 1);
    var budgetInput, hoursInput, nameInput, liveFields;
    if (cfg.planKind === 'live') {
      liveFields = await fillLiveModal(modal, name);
      budgetInput = liveFields.budgetInput;
      nameInput = liveFields.nameInput;
    } else {
      budgetInput = unique(Array.from(modal.querySelectorAll('input[placeholder="请输入"]'))
        .filter(function (el) { return !el.hasAttribute('min'); }), '调控预算输入框');
      hoursInput = unique(modal.querySelectorAll('input[min="0.5"][max="24"]'), '调控时长输入框');
      nameInput = unique(modal.querySelectorAll('input[placeholder="请输入任务名称，1-50个字符"]'), '任务名称输入框');
      setInputValue(budgetInput, cfg.budget);
      setInputValue(hoursInput, cfg.hours);
      setInputValue(nameInput, name);
    }
    if (!Number.isInteger(cfg.budget) || cfg.budget < MIN_BUDGET || cfg.budget > MAX_BUDGET || (hoursInput && cfg.hours > MAX_HOURS)) throw new Error('参数超过脚本安全上限');
    context('creative');
    var submit = cfg.planKind === 'live' ?
      unique(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
        .filter(function (el) { return exactText(el) === '提交'; }), '直播追投弹窗提交按钮') :
      textMatch(modal, 'button', '提交', '追投弹窗提交按钮');
    function formReady(button) {
      if (!visible(modal) || !visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      if (!budgetInput.isConnected || !nameInput.isConnected || (hoursInput && !hoursInput.isConnected)) return false;
      if (Number(budgetInput.value) !== cfg.budget ||
          (hoursInput && Number(hoursInput.value) !== cfg.hours) || nameInput.value !== name) return false;
      var currentIds = Array.from(exactText(modal).matchAll(/素材ID[：:]\s*(\d+)/g))
        .map(function (match) { return match[1]; });
      if (!sameIds(currentIds, acceptedIds)) return false;
      if (cfg.planKind === 'live' && (Number(liveFields.bidInput.value) !== liveFields.target ||
          !selectedRadio(modal, '控成本追投').className.includes('--checked') ||
          !selectedRadio(modal, cfg.liveGoal).className.includes('--checked') ||
          liveFields.gender !== cfg.liveGender || !liveFields.genderVerified)) return false;
      return true;
    }
    var stableSince = 0;
    await waitFor(function () {
      if (!formReady(submit)) { stableSince = 0; return false; }
      if (!stableSince) stableSince = Date.now();
      return Date.now() - stableSince >= 700;
    }, '追投弹窗参数和提交按钮稳定', 6000);
    assertModalSelection();
    var record = {
      name: name,
      ids: acceptedIds,
      count: acceptedIds.length,
      platformSkippedIds: skippedIds,
      budget: cfg.budget,
      hours: cfg.planKind === 'live' ? null : cfg.hours,
      bid: cfg.planKind === 'live' && cfg.liveGoal === '直播间成交' ? cfg.bid : null,
      liveRoiTarget: cfg.planKind === 'live' && cfg.liveGoal === '综合营销ROI' ? Number(cfg.liveRoiTarget) : null,
      liveGoal: cfg.planKind === 'live' ? cfg.liveGoal : null,
      liveGender: cfg.planKind === 'live' ? cfg.liveGender : null,
      page: pageNumber(drawer),
      status: 'submitting',
      submitAttempts: 1,
      createdAt: new Date().toISOString(),
      taskId: ''
    };
    var materialBefore = {
      page: pageNumber(drawer),
      body: materialTable(drawer).body,
      firstRow: materialTable(drawer).body.querySelector('tbody tr'),
      selectedCount: selectedCount(drawer)
    };
    if (!materialBefore.firstRow) throw new Error('提交前素材列表未就绪');
    state.currentRun.groups.push(record);
    saveJournal();
    addLog('第' + state.currentRun.groups.length + '组：勾选' + items.length + '条，弹窗接收' + acceptedIds.length + '条，任务名 ' + name);
    var messages = [];
    var observer = new MutationObserver(function (changes) {
      changes.forEach(function (change) {
        if (change.type === 'characterData') {
          messages.push((change.target.textContent || '').slice(0, 500));
        }
        Array.from(change.addedNodes || []).forEach(function (node) {
          if (node.nodeType === 1) messages.push((node.innerText || '').slice(0, 500));
          if (node.nodeType === 3) messages.push((node.textContent || '').slice(0, 500));
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    async function waitSubmitOutcome(fromIndex) {
      var failureSeenAt = 0;
      return await waitFor(function () {
        var output = messages.slice(fromIndex).join(' ');
        if (SUCCESS_RE.test(output) && !visible(modal)) return { kind: 'success', output: output };
        if (FAILURE_RE.test(output)) {
          if (!failureSeenAt) failureSeenAt = Date.now();
          if (Date.now() - failureSeenAt >= 1500) return { kind: 'failure', output: output };
        }
        return false;
      }, '“操作成功”提示及弹窗关闭', 30000);
    }
    var clicked = false;
    try {
      if (state.stopRequested) {
        state.currentRun.groups.pop();
        saveJournal();
        throw new Error(state.stopMessage + '，当前组未提交');
      }
      if (cfg.planKind === 'live' && (Number(liveFields.bidInput.value) !== liveFields.target ||
          !selectedRadio(modal, '控成本追投').className.includes('--checked') ||
          !selectedRadio(modal, cfg.liveGoal).className.includes('--checked') ||
          liveFields.gender !== cfg.liveGender || !liveFields.genderVerified)) {
        throw new Error('直播追投参数提交前复核失败');
      }
      try {
        await safeClick(submit, '追投弹窗提交', false, function () {
          if (!formReady(submit)) throw new Error('提交前弹窗参数或按钮已变化');
          clicked = true;
        });
      } catch (clickError) {
        if (clicked || state.stopRequested) throw clickError;
        assertModalSelection();
        var freshSubmit = cfg.planKind === 'live' ?
          unique(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
            .filter(function (el) { return exactText(el) === '提交'; }), '直播追投弹窗提交按钮') :
          textMatch(modal, 'button', '提交', '追投弹窗提交按钮');
        if (!formReady(freshSubmit)) throw clickError;
        addLog('提交按钮在点击前变化；已复核参数且首次未点击，重试点击一次');
        await safeClick(freshSubmit, '追投弹窗提交', false, function () {
          if (!formReady(freshSubmit)) throw new Error('重试前弹窗参数或按钮已变化');
          clicked = true;
        });
      }
      var outcome = await waitSubmitOutcome(0);
      if (outcome.kind === 'failure') {
        if (!RETRYABLE_FAILURE_RE.test(outcome.output)) {
          throw new Error('千川提示请求异常，但未明确提交失败；禁止自动重试');
        }
        var retryStableSince = 0;
        var retryState = await waitFor(function () {
          assertViewport();
          if (state.stopRequested) throw new Error(state.stopMessage);
          if (SUCCESS_RE.test(messages.join(' ')) && !visible(modal)) return { lateSuccess: true };
          if (SUCCESS_RE.test(messages.join(' '))) throw new Error('曾出现成功提示，禁止再次提交');
          if (!visible(modal)) throw new Error('追投弹窗已关闭，不能确认首次提交失败');
          assertModalSelection();
          var fresh = cfg.planKind === 'live' ?
            unique(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
              .filter(function (el) { return exactText(el) === '提交'; }), '直播追投弹窗提交按钮') :
            textMatch(modal, 'button', '提交', '追投弹窗提交按钮');
          if (!formReady(fresh)) { retryStableSince = 0; return false; }
          if (!retryStableSince) retryStableSince = Date.now();
          return Date.now() - retryStableSince >= 700 ? { button: fresh } : false;
        }, '明确失败后的同一追投弹窗和参数稳定', 6000);
        if (retryState.lateSuccess) {
          addLog('第' + state.currentRun.groups.length + '组：失败提示后页面又显示成功，未再次提交');
        } else {
          var retryFrom = messages.length;
          record.retryReason = '千川明确提示提交失败且弹窗、素材和参数未变化';
          addLog('第' + state.currentRun.groups.length + '组：千川明确提示失败；已复核原弹窗和参数，仅重试提交一次');
          await safeClick(retryState.button, '追投弹窗提交（失败后唯一一次重试）', false, function () {
            if (SUCCESS_RE.test(messages.join(' '))) throw new Error('重试前出现成功提示，禁止再次提交');
            if (!formReady(retryState.button)) throw new Error('重试前弹窗参数或按钮已变化');
            assertModalSelection();
            record.submitAttempts = 2;
            saveJournal();
          });
          outcome = await waitSubmitOutcome(retryFrom);
          if (outcome.kind !== 'success') throw new Error('千川再次提示提交失败；已用完一次自动重试');
        }
      }
      record.uiSuccess = true;
      record.status = 'ui_success';
      saveJournal();
      addLog('第' + state.currentRun.groups.length + '组：页面显示操作成功');
    } catch (error) {
      if (!clicked) {
        if (state.currentRun.groups[state.currentRun.groups.length - 1] === record) {
          state.currentRun.groups.pop();
          saveJournal();
        }
        throw error;
      }
      record.status = 'uncertain';
      record.error = error.message;
      saveJournal();
      throw new Error('第' + state.currentRun.groups.length + '组提交结果不明确，禁止重试：' + error.message);
    } finally { observer.disconnect(); }
    if (record.uiSuccess) await waitForPostSubmitRefresh(materialBefore);
  }

  async function clearSubmittedSelection(items, expectedPage, platformSkippedIds) {
    var bundle = await waitFor(function () {
      try {
        var current = rowsNow();
        return pageNumber(current.drawer) === expectedPage ? current : false;
      } catch (_) { return false; }
    }, '提交后返回原素材页', 10000);
    var drawer = bundle.drawer;
    var checked = bundle.rows.filter(function (item) { return item.check.checked; });
    var count = selectedCount(drawer);
    if (count === 0 && checked.length === 0) return;
    var checkedIds = checked.map(function (item) { return item.id; });
    var originalIds = items.map(function (item) { return item.id; });
    var acceptedIds = originalIds.filter(function (id) { return !(platformSkippedIds || []).includes(id); });
    if ((count !== 0 && count !== checked.length) ||
        !(sameIds(checkedIds, originalIds) ||
          ((platformSkippedIds || []).length && sameIds(checkedIds, acceptedIds)))) {
      throw new Error('提交后遗留勾选与上一组素材不一致，已停止后续追投');
    }
    if (checked.length === bundle.rows.length) {
      var headerCheck = unique(bundle.table.head.querySelectorAll('input[type="checkbox"]'), '素材表头全选');
      if (!headerCheck.checked) throw new Error('提交后表头勾选状态不一致');
      await safeClick(headerCheck, '取消上一组表头全选');
    } else {
      for (var i = 0; i < checked.length; i++) {
        await clickMaterialCheckbox(checked[i].id, false, checked.length - i);
      }
    }
    await waitFor(function () {
      var current = rowsNow();
      return selectedCount(current.drawer) === 0 &&
        current.rows.every(function (item) { return !item.check.checked; });
    }, '上一组素材勾选全部清除', 10000);
    addLog('已核对并取消上一组残留勾选，继续下一组');
  }

  function pageNumber(drawer) {
    var footer = unique(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
    var active = unique(footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '当前页码');
    var number = Number(exactText(active));
    if (!Number.isInteger(number) || number < 1) throw new Error('无法读取当前页码');
    return number;
  }

  async function nextPage() {
    var drawer = context('creative').drawer;
    var footer = unique(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
    var oldPage = pageNumber(drawer);
    var oldRows = rowsNow().rows;
    var oldIds = oldRows.map(function (item) { return item.id; }).join('|');
    var boundary = oldRows[oldRows.length - 1];
    var next = unique(Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
      .filter(function (el) { return !!el.querySelector('.main-vmok-plugin-page-turner__next-icon'); }), '下一页按钮');
    if (next.className.includes('disabled') || next.getAttribute('aria-disabled') === 'true') return false;
    if (selectedCount(context('creative').drawer) !== 0) throw new Error('翻页前仍有未提交勾选，已阻止翻页以免丢失素材');
    await safeClick(next, '下一页');
    await waitFor(function () {
      return pageNumber(context('creative').drawer) === oldPage + 1;
    }, '翻到第' + (oldPage + 1) + '页', 10000);
    await waitFor(function () {
      var table = materialTable(context('creative').drawer);
      var ids = Array.from(table.body.querySelectorAll('tbody tr')).map(function (tr) {
        return (exactText(tr).match(/素材ID[：:]\s*(\d+)/) || [])[1] || '';
      }).join('|');
      return ids && ids !== oldIds;
    }, '下一页素材数据更新', 10000);
    var label = state.config.mode === 'roi' ? '综合营销ROI' : '创建时间';
    if (state.config.planKind === 'live') await waitForLiveStatusPage();
    await waitForStableSort(label);
    var first = rowsNow().rows[0];
    if (state.config.mode === 'date' && first.date > boundary.date) {
      throw new Error('翻页后创建日期次序倒退');
    }
    if (state.config.mode === 'roi' && first.roi !== null && boundary.roi !== null && first.roi > boundary.roi) {
      throw new Error('翻页后 ROI 次序倒退');
    }
    addLog('已翻到第' + (oldPage + 1) + '页，并确认' + label +
      (state.config.planKind === 'live' ? '、素材追投状态' : '') + '及降序数据已刷新');
    return true;
  }

  function roiPageSize() {
    if (state.config.planKind === 'live') return 100;
    return state.config.roiGroupSize <= 10 ? 10 : 20;
  }

  function hasNextPage(drawer) {
    var footer = unique(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
    var next = unique(Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
      .filter(function (el) { return !!el.querySelector('.main-vmok-plugin-page-turner__next-icon'); }), '下一页按钮');
    return !next.className.includes('disabled') && next.getAttribute('aria-disabled') !== 'true';
  }

  async function auditAndRefillLiveGroup(initialIds, targetCount, expectedPage, expectedPageIds,
    submittedIds, attemptIds) {
    var cfg = state.config;
    var excluded = new Set();
    var cursor = Math.max.apply(null, initialIds.map(function (id) { return expectedPageIds.indexOf(id); }));
    var expectedSignature = expectedPageIds.join('|');
    for (var round = 1; round <= Math.max(6, targetCount + 2); round++) {
      setPhase('第' + expectedPage + '页提交前复核审核状态与已选素材（第' + round + '次）');
      var bundle = await waitForLiveStatusPage(1800);
      if (pageNumber(bundle.drawer) !== expectedPage ||
          bundle.rows.map(function (item) { return item.id; }).join('|') !== expectedSignature) {
        var reordered = new Error('提交前素材页码或顺序变化，须重新选材');
        reordered.code = 'LIVE_PAGE_REORDERED';
        throw reordered;
      }
      var checked = bundle.rows.filter(function (item) { return item.check.checked; });
      if (selectedCount(bundle.drawer) !== checked.length ||
          checked.some(function (item) { return !attemptIds.has(item.id); })) {
        throw new Error('提交前勾选数量或素材 ID 与本组不一致，禁止提交');
      }
      var invalid = checked.filter(function (item) {
        return !eligibleForChase(item) || !item.source || !item.operation.includes('追投') ||
          (cfg.mode === 'roi' ? item.roi === null || item.roi < cfg.roiThreshold :
            item.date < cfg.startDate || item.date > cfg.endDate);
      });
      for (var i = 0; i < invalid.length; i++) {
        var bad = invalid[i];
        excluded.add(bad.id);
        await clickMaterialCheckbox(bad.id, false, checked.length - i);
        addLog('提交前复核：素材 ' + bad.id + ' 审核“' + bad.audit + '”、追投“' +
          bad.chasing + '”，已取消勾选并寻找后续达标素材');
      }
      var current = rowsNow();
      var chosen = current.rows.filter(function (item) { return item.check.checked; });
      if (selectedCount(current.drawer) !== chosen.length) {
        throw new Error('复核取消勾选后数量未同步，禁止提交');
      }
      var replacements = [];
      for (var j = cursor + 1; j < current.rows.length &&
          chosen.length + replacements.length < targetCount; j++) {
        var candidate = current.rows[j];
        cursor = j;
        if (submittedIds.has(candidate.id) || excluded.has(candidate.id) || candidate.check.checked ||
            !eligibleForChase(candidate)) continue;
        if (cfg.mode === 'roi') {
          if (candidate.roi === null || candidate.roi < cfg.roiThreshold) break;
        } else {
          if (candidate.date < cfg.startDate) break;
          if (candidate.date > cfg.endDate) continue;
        }
        if (!candidate.source || !candidate.operation.includes('追投')) continue;
        replacements.push(candidate);
      }
      if (replacements.length) {
        replacements.forEach(function (item) { attemptIds.add(item.id); });
        addLog('提交前复核：从后续素材补选' + replacements.length + '条，重新核对整组');
        await selectRows(current, replacements, chosen.length);
        continue;
      }
      if (invalid.length) continue;
      validateRows(chosen);
      return chosen;
    }
    var unstable = new Error('提交前素材审核或追投状态反复变化，已停止本组提交');
    unstable.code = 'LIVE_SELECTION_CHANGED';
    throw unstable;
  }

  async function runLivePages() {
    var cfg = state.config;
    var size = cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize;
    var pageSteps = 0;
    var submittedIds = new Set();
    state.currentRun.groups.forEach(function (group) {
      if (group.uiSuccess) {
        (group.ids || []).forEach(function (id) { submittedIds.add(id); });
        (group.platformSkippedIds || []).forEach(function (id) { submittedIds.add(id); });
      }
    });
    var pageRebases = 0;
    while (state.currentRun.groups.length < cfg.maxGroups) {
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      if (++pageSteps > 300) throw new Error('超过300次直播素材页扫描，已停止');
      var bundle = await waitForLiveStatusPage();
      var page = pageNumber(bundle.drawer);
      if (bundle.rows.length > 100) throw new Error('当前直播素材页超过100条');
      if (selectedCount(bundle.drawer) !== 0) throw new Error('当前页存在未清除的勾选，禁止继续');
      var pageIds = bundle.rows.map(function (item) { return item.id; });
      var eligibleIds = [];
      var boundary = '';
      for (var i = 0; i < bundle.rows.length; i++) {
        var item = bundle.rows[i];
        if (!eligibleForChase(item)) continue;
        if (cfg.mode === 'roi') {
          if (item.roi === null) { boundary = 'ROI 无效'; break; }
          if (item.roi < cfg.roiThreshold) { boundary = 'ROI＜' + cfg.roiThreshold; break; }
        } else {
          if (item.date < cfg.startDate) { boundary = '创建时间早于' + cfg.startDate; break; }
          if (item.date > cfg.endDate) continue;
        }
        if (!submittedIds.has(item.id)) eligibleIds.push(item.id);
      }
      var nextExists = hasNextPage(bundle.drawer);
      var offset = 0;
      var selectionRetries = 0;
      var restartPage = false;
      while (offset < eligibleIds.length && state.currentRun.groups.length < cfg.maxGroups) {
        var count = Math.min(size, eligibleIds.length - offset);
        var pageRemainder = count < size && !boundary && nextExists;
        if (count < cfg.tailMin && !pageRemainder) break;
        var ids = eligibleIds.slice(offset, offset + count);
        var ready;
        try {
          ready = await waitForLiveReadyGroup(ids, page, pageIds);
        } catch (error) {
          if (error.code !== 'LIVE_PAGE_REORDERED') throw error;
          if (selectedCount(context('creative').drawer) !== 0) {
            throw new Error('素材页顺序变化时存在未清除勾选，禁止重新选材');
          }
          if (++pageRebases > 5) throw new Error('第' + page + '页素材顺序反复变化，已停止以防重复追投');
          addLog('第' + page + '页素材顺序已更新；排除已提交素材后重新选材（' + pageRebases + '/5）');
          restartPage = true;
          break;
        }
        var fresh = ready.bundle;
        if (selectedCount(fresh.drawer) !== 0) throw new Error('上一组勾选未清除，禁止继续');
        var chosen = ready.chosen;
        var newlyBlocked;
        try {
          newlyBlocked = chosen.filter(function (item) { return !eligibleForChase(item); });
        } catch (error) {
          addLog('第' + page + '页审核状态短暂未显示，等待列表重新稳定后选材');
          await waitForLiveStatusPage();
          restartPage = true;
          break;
        }
        if (newlyBlocked.length) {
          var skipIds = new Set(newlyBlocked.map(function (item) { return item.id; }));
          eligibleIds = eligibleIds.filter(function (id) { return !skipIds.has(id); });
          addLog('第' + page + '页新出现调控中、已暂停或审核未通过素材' + newlyBlocked.length + '条，已跳过并重新凑组');
          continue;
        }
        chosen.forEach(function (item) {
          if (cfg.mode === 'roi' && (item.roi === null || item.roi < cfg.roiThreshold)) {
            throw new Error('待追投素材 ROI 已变化：' + item.id);
          }
          if (cfg.mode === 'date' && (item.date < cfg.startDate || item.date > cfg.endDate)) {
            throw new Error('待追投素材创建日期已变化：' + item.id);
          }
        });
        validateRows(chosen);
        var attemptIds = new Set(ids);
        try {
          await selectRows(fresh, chosen, 0);
          chosen = await auditAndRefillLiveGroup(ids, count, page, pageIds, submittedIds, attemptIds);
        } catch (error) {
          try {
            await clearAttemptSelection(Array.from(attemptIds), page);
          } catch (clearError) {
            throw new Error('提交前复核中断，且无法确认本组勾选已清除：' + clearError.message +
              '；原因为：' + error.message);
          }
          if (error.code === 'LIVE_PAGE_REORDERED') {
            if (++pageRebases > 5) throw new Error('第' + page + '页素材顺序反复变化，已停止以防重复追投');
            addLog('提交前素材页顺序变化；本组勾选已清除，重新读取当前页（' + pageRebases + '/5）');
            restartPage = true;
            break;
          }
          if (error.code !== 'LIVE_SELECTION_CHANGED') throw error;
          if (++selectionRetries > 5) throw new Error('第' + page + '页素材调控状态反复变化，已清除未提交勾选并停止');
          var refreshed = await waitForLiveStatusPage();
          if (pageNumber(refreshed.drawer) !== page) {
            throw new Error('重选时当前页码变化，已停止以防重复追投');
          }
          if (refreshed.rows.map(function (item) { return item.id; }).join('|') !== pageIds.join('|')) {
            if (selectedCount(refreshed.drawer) !== 0) {
              throw new Error('重选时素材顺序变化且仍有勾选，禁止继续');
            }
            if (++pageRebases > 5) {
              throw new Error('第' + page + '页重选时素材顺序反复变化，已停止以防重复追投');
            }
            addLog('第' + page + '页素材调控状态及顺序变化；未提交组勾选已清除，重新读取当前页（' + pageRebases + '/5）');
            restartPage = true;
            break;
          }
          var remaining = eligibleIds.slice(offset).filter(function (id) {
            var latest = refreshed.rows.find(function (item) { return item.id === id; });
            if (!latest) throw new Error('重选时素材已消失：' + id);
            if (cfg.mode === 'roi' && (latest.roi === null || latest.roi < cfg.roiThreshold)) {
              throw new Error('重选时素材 ROI 已变化：' + id);
            }
            if (cfg.mode === 'date' && (latest.date < cfg.startDate || latest.date > cfg.endDate)) {
              throw new Error('重选时素材创建日期已变化：' + id);
            }
            return eligibleForChase(latest);
          });
          eligibleIds = eligibleIds.slice(0, offset).concat(remaining);
          addLog('第' + page + '页勾选前状态变化；已清除未提交勾选并跳过不可选素材，重新凑组');
          continue;
        }
        selectionRetries = 0;
        if (chosen.length === 0 ||
            (chosen.length < cfg.tailMin && !(chosen.length < size && !boundary && nextExists))) {
          await clearAttemptSelection(Array.from(attemptIds), page);
          return '第' + page + '页提交前复核后仅剩' + chosen.length +
            '条达标素材，未达到本页提交条件，已清除勾选并停止';
        }
        var actualIds = chosen.map(function (item) { return item.id; });
        pageRemainder = chosen.length < size && !boundary && nextExists;
        await submitGroup(chosen);
        actualIds.forEach(function (id) { submittedIds.add(id); });
        offset += chosen.length;
        if (pageRemainder) addLog('第' + page + '页翻页前余量' + chosen.length + '条已单独提交；下一页恢复每组' + size + '条');
        await clearSubmittedSelection(chosen, page,
          state.currentRun.groups[state.currentRun.groups.length - 1].platformSkippedIds);
        addLog('第' + page + '页上一组提交成功；重新读取当前页并排除已提交的' + submittedIds.size + '条素材');
        restartPage = true;
        pageRebases = 0;
        break;
      }
      if (restartPage) continue;
      if (state.currentRun.groups.length >= cfg.maxGroups) return '第' + page + '页达到单计划' + cfg.maxGroups + '组上限';
      var pending = eligibleIds.length - offset;
      if (pending > 0) {
        var tail = '第' + page + '页剩余' + pending + '条合格素材，未提交';
        if (!boundary && nextExists) {
          state.currentRun.incomplete = true;
          return tail + '；千川翻页不保留勾选，无法与下一页合并凑满' + size + '条，已在翻页前暂停；未进入调控核查';
        }
        tail += '；低于尾组' + cfg.tailMin + '条下限';
        return tail + (boundary ? '；遇到' + boundary + '后停止' : '；已到最后一页');
      }
      if (boundary) return '第' + page + '页遇到' + boundary + '，已完成此前符合条件的素材';
      if (!nextExists) return '第' + page + '页已到素材列表末尾';
      if (!await nextPage()) return '第' + page + '页已到素材列表末尾';
    }
    return '达到单计划追投组数上限';
  }

  async function submitProductPageGroup(items) {
    var before = rowsNow();
    var page = pageNumber(before.drawer);
    var ids = items.map(function (item) { return item.id; });
    var checkedIds = before.rows.filter(function (item) { return item.check.checked; })
      .map(function (item) { return item.id; });
    if (selectedCount(before.drawer) !== ids.length || !sameIds(ids, checkedIds)) {
      throw new Error('提交前当前页勾选与本组素材ID不一致，禁止继续');
    }
    await submitGroup(items);
    var group = state.currentRun.groups[state.currentRun.groups.length - 1];
    await clearSubmittedSelection(items, page, group.platformSkippedIds);
  }

  async function runRoiStrict() {
    var cfg = state.config;
    var selected = [];
    var handled = new Set();
    var reason = '';
    var steps = 0;
    while (state.currentRun.groups.length < cfg.maxGroups) {
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      if (++steps > 300) throw new Error('超过300次素材页扫描，已停止');
      var bundle = await waitForProductRowsReady();
      if (bundle.rows.length > roiPageSize()) throw new Error('当前页素材数超过每页设置');
      if (selectedCount(bundle.drawer) !== selected.length) throw new Error('跨页选中数量未保留，禁止继续');
      var candidates = bundle.rows.filter(function (item) { return !handled.has(item.id); });
      var eligible = [];
      var boundary = '';
      for (var i = 0; i < candidates.length; i++) {
        var item = candidates[i];
        if (!eligibleForChase(item)) continue;
        if (item.roi === null) { boundary = 'ROI 为“—”'; break; }
        if (item.roi < cfg.roiThreshold) { boundary = 'ROI＜' + cfg.roiThreshold; break; }
        eligible.push(item);
      }
      var chosen = eligible.slice(0, cfg.roiGroupSize - selected.length);
      if (chosen.length) {
        await selectRows(bundle, chosen, selected.length);
        chosen.forEach(function (item) { handled.add(item.id); selected.push(item); });
      }
      if (selected.length === cfg.roiGroupSize) {
        await submitProductPageGroup(selected);
        selected = [];
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '达到单计划' + cfg.maxGroups + '组上限';
          break;
        }
        if (eligible.length > chosen.length) continue;
      }
      if (boundary) {
        reason = '第' + pageNumber(bundle.drawer) + '页首次出现' + boundary + '，仅追投此前达到阈值的素材';
        break;
      }
      if (selected.length && hasNextPage(bundle.drawer)) {
        if (selectedCount(bundle.drawer) !== selected.length) throw new Error('翻页前已选素材数量不匹配');
        await submitProductPageGroup(selected);
        addLog('本页剩余' + selected.length + '条达标素材已单独提交；下一页重新成组');
        selected = [];
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '达到单计划' + cfg.maxGroups + '组上限';
          break;
        }
      }
      if (!await nextPage()) { reason = '素材列表已到最后一页'; break; }
    }
    if (selected.length >= (cfg.planKind === 'live' ? cfg.tailMin : 1) && state.currentRun.groups.length < cfg.maxGroups) {
      if (selectedCount(context('creative').drawer) !== selected.length) throw new Error('尾组选中数量不匹配');
      await submitProductPageGroup(selected);
      reason += '；末组' + selected.length + '条达标素材已提交';
    } else if (selected.length) {
      reason += '；剩余' + selected.length + '条不足尾组' + cfg.tailMin + '条下限，未提交';
    }
    return reason || '达到单计划追投组数上限';
  }

  async function runRoiWholeGroup() {
    var cfg = state.config;
    var selected = [];
    var handled = new Set();
    var stopAfterGroup = false;
    var pausedForDash = false;
    var reason = '';
    var steps = 0;
    while (state.currentRun.groups.length < cfg.maxGroups) {
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      if (++steps > 300) throw new Error('超过300次素材页扫描，已停止');
      var bundle = await waitForProductRowsReady();
      if (bundle.rows.length > roiPageSize()) throw new Error('当前页素材数超过每页设置');
      if (selectedCount(bundle.drawer) !== selected.length) throw new Error('跨页选中数量未保留，禁止继续');
      var candidates = bundle.rows.filter(function (item) { return !handled.has(item.id) && eligibleForChase(item); });
      var pageHasBelow = candidates.some(function (item) {
        return item.roi !== null && item.roi < cfg.roiThreshold;
      });
      if (!stopAfterGroup && cfg.dashPolicy === 'pause' && !pageHasBelow &&
          candidates.some(function (item) { return item.roi === null; })) {
        pausedForDash = true;
        reason = '第' + pageNumber(bundle.drawer) + '页出现 ROI 为“—”的素材，按安全策略暂停';
        break;
      }
      var chosen = [];
      for (var i = 0; i < candidates.length && chosen.length < cfg.roiGroupSize - selected.length; i++) {
        var item = candidates[i];
        if (item.roi === null || item.roi < cfg.roiThreshold) stopAfterGroup = true;
        chosen.push(item);
      }
      if (chosen.length) {
        await selectRows(bundle, chosen, selected.length);
        chosen.forEach(function (item) { handled.add(item.id); selected.push(item); });
      }
      if (selected.length === cfg.roiGroupSize) {
        await submitProductPageGroup(selected);
        selected = [];
        if (stopAfterGroup) {
          reason = '第' + pageNumber(bundle.drawer) + '页首次跨过 ROI ' + cfg.roiThreshold + ' 阈值，整组提交后停止';
          break;
        }
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '达到单计划' + cfg.maxGroups + '组上限';
          break;
        }
        if (candidates.length > chosen.length) continue;
      }
      if (selected.length && hasNextPage(bundle.drawer)) {
        if (selectedCount(bundle.drawer) !== selected.length) throw new Error('翻页前已选素材数量不匹配');
        await submitProductPageGroup(selected);
        addLog('本页剩余' + selected.length + '条素材已单独提交；下一页重新成组');
        selected = [];
        if (stopAfterGroup) {
          reason = '第' + pageNumber(bundle.drawer) + '页已跨过 ROI ' + cfg.roiThreshold + ' 阈值，提交后停止';
          break;
        }
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '达到单计划' + cfg.maxGroups + '组上限';
          break;
        }
      }
      if (!await nextPage()) { reason = '素材列表已到最后一页'; break; }
    }
    if (pausedForDash && selected.length) {
      reason += '；已有' + selected.length + '条未满组素材保持勾选，未提交';
    } else if (selected.length && state.currentRun.groups.length < cfg.maxGroups) {
      if (selectedCount(context('creative').drawer) !== selected.length) throw new Error('尾组选中数量不匹配');
      await submitProductPageGroup(selected);
      reason += '；末组' + selected.length + '条已提交';
    }
    return reason || '达到单计划追投组数上限';
  }

  async function runRoi() {
    if (state.config.planKind === 'live') return runLivePages();
    return state.config.roiStrategy === 'strict' ? runRoiStrict() : runRoiWholeGroup();
  }

  async function runDate() {
    if (state.config.planKind === 'live') return runLivePages();
    var cfg = state.config;
    var selected = [];
    var handled = new Set();
    var reason = '';
    var pageSteps = 0;
    while (state.currentRun.groups.length < cfg.maxGroups) {
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      if (++pageSteps > 300) throw new Error('超过300次素材页扫描，已停止');
      var bundle = await waitForProductRowsReady();
      if (bundle.rows.length > 20) throw new Error('当前页超过20条');
      if (selectedCount(bundle.drawer) !== selected.length) {
        throw new Error('跨页选中数量未保留，禁止继续');
      }
      var eligible = bundle.rows.filter(function (item) {
        return item.date >= cfg.startDate && item.date <= cfg.endDate && !handled.has(item.id) && eligibleForChase(item);
      });
      var room = cfg.dateGroupSize - selected.length;
      var chosen = eligible.slice(0, room);
      if (chosen.length) {
        await selectRows(bundle, chosen, selected.length);
        chosen.forEach(function (item) { handled.add(item.id); selected.push(item); });
      }
      if (selected.length === cfg.dateGroupSize) {
        await submitProductPageGroup(selected);
        selected = [];
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '达到单计划' + cfg.maxGroups + '组上限';
          break;
        }
        if (eligible.length > chosen.length) continue;
      }
      var olderThanStart = bundle.rows.some(function (item) { return item.date < cfg.startDate; });
      if (olderThanStart) {
        reason = '第' + pageNumber(bundle.drawer) + '页出现早于起始日期' + cfg.startDate + '的素材';
        break;
      }
      if (selected.length && hasNextPage(bundle.drawer)) {
        if (selectedCount(bundle.drawer) !== selected.length) throw new Error('翻页前已选素材数量不匹配');
        await submitProductPageGroup(selected);
        addLog('本页剩余' + selected.length + '条符合日期的素材已单独提交；下一页重新成组');
        selected = [];
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '达到单计划' + cfg.maxGroups + '组上限';
          break;
        }
      }
      if (!await nextPage()) {
        reason = '素材列表已到最后一页';
        break;
      }
    }
    if (selected.length >= cfg.tailMin && selected.length < cfg.dateGroupSize && state.currentRun.groups.length < cfg.maxGroups) {
      if (selectedCount(context('creative').drawer) !== selected.length) throw new Error('尾组选中数量不匹配');
      await submitProductPageGroup(selected);
      reason += '；尾组' + selected.length + '条已提交';
    } else if (selected.length > 0 && selected.length < cfg.tailMin) {
      reason += '；剩余' + selected.length + '条不足' + cfg.tailMin + '条，未提交';
    }
    return reason;
  }

  function taskTable(drawer) {
    var heads = Array.from(drawer.querySelectorAll('.main-vmok-plugin-table__head-wrapper')).filter(visible);
    var head = heads.find(function (el) {
      return exactText(el).includes('任务名称') && exactText(el).includes('素材');
    });
    if (!head) throw new Error('无法定位素材追投任务表头');
    var wrapper = head.parentElement;
    var body = wrapper.querySelector('.main-vmok-plugin-table__body-wrapper');
    if (!body) throw new Error('无法定位素材追投任务表体');
    var headers = Array.from(head.querySelectorAll('thead tr:first-child th')).map(exactText);
    return { body: body, headers: headers };
  }

  async function openTaskCenter() {
    var drawer = context().drawer;
    var tab = unique(Array.from(drawer.querySelectorAll('[role="tab"]')).filter(function (el) {
      return el.id.endsWith('-tab-uni_task_center') && exactText(el) === '调控';
    }), '调控标签');
    if (tab.getAttribute('aria-selected') !== 'true') await safeClick(tab, '调控标签', true);
    await waitFor(function () {
      return !!context('uni_task_center').drawer;
    }, '调控任务页');
    drawer = context('uni_task_center').drawer;
    var radio = unique(Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(function (el) { return exactText(el) === '素材追投'; }), '素材追投任务标签');
    if (!radio.className.includes('--checked')) await safeClick(radio, '素材追投任务标签', true);
    await waitFor(function () { return taskTable(context('uni_task_center').drawer); }, '素材追投任务列表', 10000);
  }

  function taskRows() {
    var table = taskTable(context('uni_task_center').drawer);
    var h = table.headers;
    var nameIdx = h.findIndex(function (x) { return x.includes('任务名称'); });
    var countIdx = h.findIndex(function (x) { return x === '素材'; });
    var statusIdx = h.findIndex(function (x) { return x.includes('调控状态'); });
    var budgetIdx = h.findIndex(function (x) { return x.includes('调控预算'); });
    var hoursIdx = h.findIndex(function (x) { return x.includes('调控时长'); });
    if ([nameIdx, countIdx, statusIdx, budgetIdx].some(function (x) { return x < 0; }) ||
        (state.config.planKind !== 'live' && hoursIdx < 0)) {
      throw new Error('素材追投任务列表列名已改变');
    }
    return Array.from(table.body.querySelectorAll('tbody tr')).filter(visible).map(function (tr) {
      var cells = Array.from(tr.querySelectorAll(':scope > td')).map(exactText);
      var nameCell = cells[nameIdx] || '';
      var taskId = (nameCell.match(/ID[：:]\s*(\d+)/) || [])[1] || '';
      var materialCell = cells[countIdx] || '';
      var countMatch = materialCell.match(/共\s*(\d+)\s*条视频/);
      var singleMaterial = !countMatch && /素材ID[：:]\s*\d+/.test(materialCell);
      var budget = (cells[budgetIdx] || '').match(/[\d,.]+/);
      var hours = hoursIdx < 0 ? null : (cells[hoursIdx] || '').match(/[\d.]+/);
      return {
        name: nameCell.replace(/\s*ID[：:]\s*\d+[\s\S]*$/, '').trim(),
        taskId: taskId,
        count: countMatch ? Number(countMatch[1]) : (singleMaterial ? 1 : null),
        state: cells[statusIdx],
        budget: budget ? Number(budget[0].replace(/,/g, '')) : null,
        hours: hours ? Number(hours[0]) : null
      };
    });
  }

  async function verifyTasks(waitForRecent) {
    await openTaskCenter();
    await waitFor(function () { return taskRows().length > 0; }, '素材追投任务数据', 10000);
    var firstFooters = Array.from(context('uni_task_center').drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper')).filter(visible);
    if (firstFooters.length > 1) throw new Error('任务分页栏出现多个，无法安全核查');
    if (firstFooters.length === 1) {
      var firstFooter = firstFooters[0];
      var activePage = unique(firstFooter.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '任务当前页码');
      if (exactText(activePage) !== '1') {
        var beforeId = taskRows()[0] && taskRows()[0].taskId;
        var firstPage = unique(Array.from(firstFooter.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
          .filter(function (el) { return exactText(el) === '1'; }), '任务第1页');
        await safeClick(firstPage, '任务列表第1页', true);
        await waitFor(function () {
          var footer = unique(context('uni_task_center').drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '任务分页栏');
          var active = unique(footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '任务当前页码');
          var first = taskRows()[0];
          return exactText(active) === '1' && first && first.taskId !== beforeId;
        }, '任务列表回到第1页', 8000);
      }
    }
    var expected = state.currentRun.groups;
    if (waitForRecent) {
      await waitFor(function () {
        var listed = taskRows();
        return expected.some(function (g) {
          return listed.some(function (row) { return row.name === g.name; });
        });
      }, '新追投任务进入调控列表', 20000);
    }
    var hits = {};
    expected.forEach(function (g) { hits[g.name] = []; });
    var page = 0;
    var canContinue = true;
    while (page < 20 && canContinue) {
      page++;
      taskRows().forEach(function (row) {
        if (Object.prototype.hasOwnProperty.call(hits, row.name)) hits[row.name].push(row);
      });
      var drawer = context('uni_task_center').drawer;
      var footers = Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper')).filter(visible);
      if (footers.length > 1) throw new Error('任务分页栏出现多个，无法安全核查');
      if (footers.length === 0) break;
      var nexts = Array.from(footers[0].querySelectorAll('li.main-vmok-plugin-page-turner__item'))
        .filter(function (el) { return !!el.querySelector('.main-vmok-plugin-page-turner__next-icon'); });
      if (nexts.length !== 1 || nexts[0].className.includes('disabled') ||
          nexts[0].getAttribute('aria-disabled') === 'true') break;
      var firstBefore = taskRows()[0] && taskRows()[0].taskId;
      await safeClick(nexts[0], '任务列表下一页', true);
      await waitFor(function () {
        var first = taskRows()[0];
        return first && first.taskId !== firstBefore;
      }, '任务列表翻页', 8000);
      if (page === 20) canContinue = false;
    }
    var incompleteScan = !canContinue;
    expected.forEach(function (g) {
      var found = hits[g.name] || [];
      if (found.length !== 1) {
        g.status = found.length > 1 ? 'possible_duplicate' : 'not_found';
        g.taskId = found[0] ? found[0].taskId : '';
      } else {
        var row = found[0];
        g.taskId = row.taskId;
        g.status = row.count === g.count && row.budget === g.budget &&
          (state.config.planKind === 'live' || row.hours === g.hours) &&
          row.state.startsWith('调控中') ?
          'verified' : 'mismatch';
        g.actual = { count: row.count, budget: row.budget, hours: row.hours, state: row.state };
      }
    });
    saveJournal();
    if (incompleteScan) {
      state.currentRun.verifyIncomplete = true;
      state.currentRun.stopReason += '；任务列表扫描达到20页，重复任务检查不完整';
      addLog('任务列表扫描达到20页，重复任务检查不完整');
    }
    var verified = expected.filter(function (g) { return g.status === 'verified'; }).length;
    addLog('调控→素材追投核查：' + verified + '/' + expected.length + '组数据完全匹配');
    return !incompleteScan && verified === expected.length;
  }

  function validateConfig(overviewMode) {
    var cfg = state.config;
    var current = overviewMode ? null : context('creative');
    if (!cfg.accountId || (!overviewMode && !cfg.planId)) throw new Error('请先锁定当前计划');
    if (current && current.planKind !== cfg.planKind) throw new Error('锁定计划类型与页面不一致');
    if (!Number.isInteger(cfg.budget) || cfg.budget < MIN_BUDGET || cfg.budget > MAX_BUDGET) {
      throw new Error('单组预算须为100–500元整数');
    }
    if (cfg.planKind !== 'live' && (!Number.isFinite(cfg.hours) || cfg.hours < 0.5 || cfg.hours > MAX_HOURS)) {
      throw new Error('调控时长须为0.5–24小时');
    }
    var maxAllowedGroups = cfg.planKind === 'live' ? MAX_LIVE_GROUPS : MAX_PRODUCT_GROUPS;
    if (!Number.isInteger(cfg.maxGroups) || cfg.maxGroups < 1 || cfg.maxGroups > maxAllowedGroups) {
      throw new Error('本轮组数须为1–' + maxAllowedGroups + '组');
    }
    var groupSize = cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize;
    if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 20) {
      throw new Error('单组视频数量须为1–20条整数');
    }
    if (cfg.planKind === 'live' || cfg.mode === 'date') {
      if (!Number.isInteger(cfg.tailMin) || cfg.tailMin < 1 || cfg.tailMin > groupSize) {
        throw new Error('最终页/停止点尾组最低数量须为1–' + groupSize + '条整数，不得大于每组数量');
      }
    }
    if (cfg.planKind === 'live') {
      if (!['直播间成交', '综合营销ROI'].includes(cfg.liveGoal)) throw new Error('直播优化目标无法识别');
      if (!['不限', '男', '女'].includes(cfg.liveGender)) throw new Error('直播性别定向无法识别');
      if (cfg.liveGoal === '直播间成交' && (!Number.isFinite(cfg.bid) || cfg.bid <= 0 || cfg.bid > 1000)) {
        throw new Error('直播“我的出价”须为0–1000元之间的正数');
      }
      if (cfg.liveGoal === '综合营销ROI' &&
          (!Number.isFinite(Number(cfg.liveRoiTarget)) || Number(cfg.liveRoiTarget) <= 0 || Number(cfg.liveRoiTarget) > 1000)) {
        throw new Error('直播综合营销ROI目标须为0–1000之间的正数');
      }
      if (cfg.mode === 'roi' && cfg.roiStrategy !== 'strict') {
        throw new Error('直播 ROI 追投只支持严格筛选达标素材');
      }
    }
    if (cfg.mode === 'roi') {
      if (cfg.planKind === 'live') {
        var today = new Date();
        var localDay = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'),
          String(today.getDate()).padStart(2, '0')].join('-');
        if (new URL(location.href).searchParams.get('dateRange') !== localDay + ',' + localDay) {
          throw new Error('直播 ROI 模式须将千川数据日期设为系统当天：' + localDay);
        }
      }
      if (!Number.isFinite(cfg.roiThreshold) || cfg.roiThreshold < 0 || cfg.roiThreshold > 1000) {
        throw new Error('ROI 阈值须为0–1000之间的数值');
      }
      if (!['whole_group', 'strict'].includes(cfg.roiStrategy)) throw new Error('ROI 追投策略无法识别');
    }
    if (cfg.mode === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.endDate) ||
          cfg.startDate > cfg.endDate) {
        throw new Error('请填写有效的创建日期区间，起始日期不能晚于结束日期');
      }
    }
  }

  function readFormSnapshot() {
    var get = function (id) {
      var el = shadow.getElementById(id);
      if (!el) throw new Error('操作面板缺少输入项：' + id);
      return el;
    };
    var cfg = state.config;
    cfg.dryRun = get('dry-run').checked;
    cfg.budget = Number(get('budget').value);
    if (cfg.planKind === 'live' || cfg.mode === 'date') cfg.tailMin = Number(get('tail-min').value);
    if (cfg.planKind === 'live') {
      cfg.liveGoal = get('live-goal').value;
      cfg.liveGender = get('live-gender').value;
      if (cfg.liveGoal === '直播间成交') cfg.bid = Number(get('bid').value);
      else cfg.liveRoiTarget = get('live-roi-target').value.trim();
      cfg.skipControlling = get('skip-controlling').checked;
    } else cfg.hours = Number(get('hours').value);
    cfg.maxGroups = Number(get('max-groups').value);
    if (cfg.mode === 'roi') {
      cfg.roiGroupSize = Number(get('group-size').value);
      cfg.roiThreshold = get('roi-threshold').value.trim() === '' ? NaN : Number(get('roi-threshold').value);
      cfg.roiStrategy = cfg.planKind === 'live' ? 'strict' : get('roi-strategy').value;
      if (cfg.roiStrategy === 'whole_group') cfg.dashPolicy = get('dash-policy').value;
    }
    if (cfg.mode === 'date') {
      cfg.dateGroupSize = Number(get('group-size').value);
      cfg.startDate = get('start-date').value;
      cfg.endDate = get('end-date').value;
    }
  }

  function makeReport(run) {
    var groups = run.groups;
    var verified = groups.filter(function (g) { return g.status === 'verified'; });
    var abnormal = groups.filter(function (g) { return g.status !== 'verified'; });
    var uiSuccess = groups.filter(function (g, index) {
      return g.uiSuccess || ['ui_success', 'verified', 'mismatch', 'possible_duplicate'].includes(g.status) ||
        (run.logs || []).some(function (line) {
          return line.includes('第' + (index + 1) + '组：页面显示操作成功');
        });
    });
    return [
      run.accountName + ' → ' + run.planName,
      '模式：' + (run.mode === 'roi' ? '综合营销ROI降序' : '创建日期降序'),
      '计划类型：' + (run.planKind === 'live' ? '推直播间' : '商品自选') +
        (run.planKind === 'live' ? '；控成本追投；优化目标' + run.liveGoal + '；' +
          (run.liveGoal === '直播间成交' ? '我的出价' + run.bid + '元' : '综合营销ROI目标' + run.liveRoiTarget) +
          '；定向性别' + run.liveGender + '；' +
          (run.skipControlling ? '跳过调控中素材' : '不跳过调控中素材') : ''),
      '设置：每组' + (run.groupSize || (run.mode === 'roi' ? 10 : 20)) + '条' +
        (run.mode === 'roi' ? '；ROI≥' + (run.roiThreshold == null ? 1 : run.roiThreshold) +
          '；' + (run.roiStrategy === 'strict' ? '严格只追投达标素材' : '跨阈值整组提交后停止') :
          (run.startDate && run.endDate ? '；创建日期' + run.startDate + '至' + run.endDate + '（含两端）' : '')) +
        (run.tailMin != null ? '；最终页/停止点尾组至少' + run.tailMin + '条' : ''),
      '确认成功组数：' + verified.length + '；页面显示成功组数：' + uiSuccess.length,
      '任务核查状态：' + (run.verifyDeferred ? '追投中途停止，未自动离开素材页；可手动点击“只重新核查未核清任务（不提交）”' :
        (run.status === 'verified' ? '已统一核查' :
          (groups.length ? '已核查，仍有任务待确认' : '本轮未创建任务'))),
      '每组实际素材数量：' + groups.map(function (g) { return g.count + '条（' + g.status + '）'; }).join('、'),
      '平台过滤未追投素材：' + (groups.flatMap(function (g) { return g.platformSkippedIds || []; }).join('、') || '无'),
      '明确失败后自动重试的组数：' + groups.filter(function (g) { return g.submitAttempts === 2; }).length + '；每组最多重试一次',
      '确认追投素材总数：' + verified.reduce(function (n, g) { return n + g.count; }, 0),
      '确认调控日预算：' + verified.reduce(function (n, g) { return n + g.budget; }, 0) + '元',
      '停止位置和原因：' + run.stopReason,
      '未执行计划：无（本轮仅锁定一条计划）',
      '重复任务、提交异常或风控：' + (abnormal.length ?
        abnormal.map(function (g) {
          var actual = g.actual ? '，任务列表为' + g.actual.count + '条/' + g.actual.budget +
            '元/' + (run.planKind === 'live' ? '' : g.actual.hours + '小时/') + g.actual.state : '';
          return g.name + ' ' + g.status + actual + (g.error ? ' ' + g.error : '');
        }).join('；') :
        (run.verifyIncomplete ? '任务列表未扫描完，重复情况未能排除' : '本轮已扫描任务中未发现；未检测到平台风控')),
      '任务 ID：' + groups.map(function (g) { return g.taskId || '未读取'; }).join('、')
    ].join('\n');
  }

  function liveOverview() {
    var url = new URL(location.href);
    if (url.pathname !== '/overall-prom' || !url.hash.includes('marGoal=2') ||
        url.searchParams.get('campaignType') !== '1' || url.searchParams.get('uniTab') !== 'ad') {
      throw new Error('批量入口仅在“乘方→直播→在投计划”总览页使用');
    }
    var accountText = exactText(unique(document.querySelectorAll('.account-info-box'), '账户信息'));
    var match = accountText.match(/ID[：:]\s*(\d+)/);
    if (!match || url.searchParams.get('aavid') !== match[1]) throw new Error('直播总览账户 ID 无法核对');
    return { accountId: match[1], accountName: accountText.slice(0, accountText.indexOf('ID')).trim() };
  }

  async function scanLivePlans() {
    await dismissKnownPromo();
    var account = liveOverview();
    var plans = [];
    var skipped = [];
    var seen = new Set();
    for (var page = 1; page <= 300; page++) {
      var footer = unique(document.querySelectorAll('[class*="paginationContainer"]'), '直播计划分页栏');
      var active = unique(footer.querySelectorAll('.aurora-qc-pagination-item-active'), '直播计划页码');
      if (Number(exactText(active)) !== page) throw new Error('直播计划页码与扫描进度不一致');
      var rows = Array.from(document.querySelectorAll('tr[data-row-key]')).filter(visible).filter(function (tr) {
        return !!tr.querySelector('[id^="ad-name-"]');
      });
      if (!rows.length) throw new Error('直播计划列表没有可读取的计划行');
      rows.forEach(function (tr) {
        var id = tr.getAttribute('data-row-key');
        var cells = Array.from(tr.querySelectorAll(':scope > td'));
        if (!/^\d+$/.test(id || '') || cells.length < 3 || seen.has(id)) throw new Error('直播计划 ID 或行数据异常');
        seen.add(id);
        var heading = cells[1].querySelector('#ad-name-' + id);
        if (!heading || !exactText(heading).includes('直播大屏')) throw new Error('计划 ' + id + ' 不是直播大屏计划');
        var lines = (heading.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var name = lines[1] || '';
        if (!name || name === '素材') throw new Error('无法读取直播计划名称：' + id);
        var status = exactText(cells[2]);
        if (status.split(' ').includes('投放中')) plans.push({ id: id, name: name });
        else skipped.push({ id: id, name: name, reason: '状态不是投放中：' + status });
      });
      var next = unique(footer.querySelectorAll('li.aurora-qc-pagination-next'), '直播计划下一页');
      if (next.className.includes('disabled') || next.getAttribute('aria-disabled') === 'true') {
        return { account: account, plans: plans, skipped: skipped };
      }
      var button = unique(next.querySelectorAll('button'), '直播计划下一页按钮');
      await safeClick(button, '直播计划下一页');
      await waitFor(function () {
        var f = unique(document.querySelectorAll('[class*="paginationContainer"]'), '直播计划分页栏');
        var a = unique(f.querySelectorAll('.aurora-qc-pagination-item-active'), '直播计划页码');
        return Number(exactText(a)) === page + 1;
      }, '直播计划翻页', 10000);
    }
    throw new Error('直播计划列表超过300页，已停止');
  }

  function livePlanUrl(planId) {
    var url = new URL(location.href);
    url.pathname = '/overall-prom/detail';
    url.searchParams.set('adId', planId);
    url.hash = '?marGoal=2&page=1&pageSize=10&sortType=desc&uniVideoTab=2&adDetailTab=creative';
    return url.toString();
  }

  async function startLiveBatch() {
    if (state.busy) return;
    state.busy = true;
    state.stopRequested = false;
    state.report = '';
    render();
    try {
      readFormSnapshot();
      var result = await scanLivePlans();
      state.config.planKind = 'live';
      state.config.accountId = result.account.accountId;
      state.config.accountName = result.account.accountName;
      state.config.planId = '';
      state.config.planName = '';
      validateConfig(true);
      if (!result.plans.length) throw new Error('本账户没有投放中的直播计划');
      if (state.config.dryRun) {
        state.report = '直播在投计划扫描完成；演练未勾选或提交。\n' +
          '账户：' + result.account.accountName + '\n在投计划：' +
          result.plans.map(function (p) { return p.name + '（' + p.id + '）'; }).join('、') +
          '\n未执行计划：' + (result.skipped.length ? result.skipped.map(function (p) {
            return p.name + '（' + p.id + '）：' + p.reason;
          }).join('；') : '无');
        setPhase('账户计划扫描完成；未提交');
        return;
      }
      if (state.batch && ['navigating', 'running', 'needs_review'].includes(state.batch.status)) {
        throw new Error('已有未完成的直播批量任务，请先人工核对');
      }
      state.batch = {
        status: 'navigating', account: result.account, plans: result.plans,
        skipped: result.skipped, index: 0, reports: [], config: Object.assign({}, state.config),
        startedAt: new Date().toISOString()
      };
      saveBatch();
      location.assign(livePlanUrl(result.plans[0].id));
    } catch (error) { setPhase('直播批量开始失败：' + error.message); }
    finally { state.busy = false; render(); }
  }

  function advanceLiveBatch(run) {
    var batch = state.batch;
    if (!batch || batch.status !== 'running') return;
    var target = batch.plans[batch.index];
    if (!target || !run || run.planId !== target.id || run.accountId !== batch.account.accountId) {
      batch.status = 'needs_review';
      saveBatch();
      setPhase('批量中断：计划身份或提交记录不一致');
      return;
    }
    batch.reports.push(makeReport(run));
    if (!['verified', 'stopped_without_submit'].includes(run.status)) {
      batch.status = 'needs_review';
      saveBatch();
      state.report = batch.reports.join('\n\n') + '\n\n未执行计划：' +
        batch.plans.slice(batch.index + 1).map(function (p) { return p.name + '（' + p.id + '）：前一计划结果待核对'; }).concat(
          batch.skipped.map(function (p) { return p.name + '（' + p.id + '）：' + p.reason; })
        ).join('；');
      setPhase('批量中断：当前计划须人工核对，后续计划未执行');
      return;
    }
    batch.index++;
    if (batch.index >= batch.plans.length) {
      batch.status = 'complete';
      saveBatch();
      state.report = batch.reports.join('\n\n') + '\n\n账户批量完成。未执行计划：' +
        (batch.skipped.length ? batch.skipped.map(function (p) { return p.name + '：' + p.reason; }).join('；') : '无');
      setPhase('全部在投直播计划处理完毕');
      return;
    }
    batch.status = 'navigating';
    saveBatch();
    location.assign(livePlanUrl(batch.plans[batch.index].id));
  }

  async function resumeLiveBatch() {
    var batch = state.batch;
    if (!batch) return;
    if (batch.status === 'running') {
      setPhase('批量流程因页面刷新中断，请人工核对当前计划，禁止自动重提');
      return;
    }
    if (batch.status !== 'navigating') return;
    var target = batch.plans[batch.index];
    if (!target || new URL(location.href).searchParams.get('adId') !== target.id) return;
    try {
      await dismissKnownPromo();
      var current = await waitFor(function () {
        try { return context('creative', true); } catch (_) { return null; }
      }, '批量计划素材页', 15000);
      if (current.accountId !== batch.account.accountId || current.planId !== target.id ||
          current.planName !== target.name || current.planKind !== 'live') {
        throw new Error('批量计划账户、名称或 ID 不匹配');
      }
      state.config = Object.assign({}, batch.config, {
        accountId: current.accountId, accountName: current.accountName,
        planId: current.planId, planName: current.planName, planKind: 'live', dryRun: false
      });
      batch.status = 'running';
      saveBatch();
      render();
      state.batchRunActive = true;
      await start();
      state.batchRunActive = false;
    } catch (error) {
      state.batchRunActive = false;
      batch.status = 'needs_review';
      saveBatch();
      setPhase('批量中断：' + error.message);
    }
  }

  async function recheckPending() {
    if (state.busy) return;
    state.busy = true;
    state.stopRequested = false;
    state.report = '';
    render();
    try {
      await dismissKnownPromo();
      var current = context(null, true);
      var pending = journal.runs.filter(function (run) {
        return run.accountId === current.accountId && run.planId === current.planId &&
          run.groups.some(function (g) { return g.status !== 'verified'; });
      });
      if (!pending.length) throw new Error('当前计划没有待核查的脚本提交记录');
      state.config.accountId = current.accountId;
      state.config.accountName = current.accountName;
      state.config.planId = current.planId;
      state.config.planName = current.planName;
      state.config.planKind = current.planKind;
      var run = pending[pending.length - 1];
      state.currentRun = run;
      setPhase('只重新核查调控任务，不提交素材');
      var allGood = await verifyTasks(false);
      run.verifyDeferred = false;
      run.status = allGood ? 'verified' : 'needs_review';
      saveJournal();
      state.report = makeReport(run);
      setPhase(allGood ? '核查完成；未新增追投任务' : '核查未通过；未新增追投任务');
    } catch (error) {
      if (state.currentRun) state.report = makeReport(state.currentRun);
      setPhase('重新核查停止：' + error.message);
    } finally {
      state.busy = false;
      state.currentRun = null;
      render();
    }
  }

  function refreshUnreadyLivePage(run, error) {
    if (error.code !== 'LIVE_DATA_NOT_READY' || run.planKind !== 'live' || state.stopRequested) return false;
    if (run.groups.some(function (group) { return !group.uiSuccess; })) return false;
    var current = context('creative');
    var page = pageNumber(current.drawer);
    var checked = Array.from(current.drawer.querySelectorAll('tbody input[type="checkbox"]'))
      .some(function (input) { return input.checked; });
    if (selectedCount(current.drawer) !== 0 || checked) return false;
    var attempts = run.refreshAttemptsByPage || {};
    var total = Object.keys(attempts).reduce(function (sum, key) { return sum + attempts[key]; }, 0);
    if ((attempts[page] || 0) >= 1 || total >= 3) return false;
    if (state.batchRunActive && (!state.batch || state.batch.status !== 'running')) return false;
    var tabToken = run.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    try { sessionStorage.setItem(REFRESH_TAB_KEY, tabToken); }
    catch (_) { return false; }
    attempts[page] = (attempts[page] || 0) + 1;
    run.refreshAttemptsByPage = attempts;
    run.status = 'refreshing';
    run.stopReason = '第' + page + '页数据未就绪，正在刷新并返回原素材页';
    saveJournal();
    GM_setValue(REFRESH_KEY, {
      runId: run.id, accountId: run.accountId, planId: run.planId, planName: run.planName,
      page: page, url: location.href, config: Object.assign({}, state.config),
      viewport: Object.assign({}, state.viewportLock), tabToken: tabToken,
      batch: !!state.batchRunActive, createdAt: Date.now()
    });
    if (state.batchRunActive) {
      state.batch.status = 'refreshing';
      saveBatch();
    }
    state.refreshing = true;
    addLog('第' + page + '页 ROI/追投状态未就绪；已保存本轮' + run.groups.length +
      '组提交记录，刷新后返回该页自动继续（本页第' + attempts[page] + '次）');
    setPhase('刷新千川页面并恢复第' + page + '页');
    location.reload();
    return true;
  }

  async function resumeAfterDataRefresh(checkpoint) {
    var run = journal.runs.find(function (item) { return item.id === checkpoint.runId; });
    try {
      if (!run || run.status !== 'refreshing' || Date.now() - checkpoint.createdAt > 5 * 60 * 1000 ||
          !Number.isInteger(checkpoint.page) || checkpoint.page < 1 || checkpoint.page > 300) {
        throw new Error('刷新恢复记录已失效');
      }
      var savedUrl = new URL(checkpoint.url);
      var currentUrl = new URL(location.href);
      if (currentUrl.origin !== savedUrl.origin || currentUrl.pathname !== savedUrl.pathname ||
          currentUrl.searchParams.get('aavid') !== checkpoint.accountId ||
          currentUrl.searchParams.get('adId') !== checkpoint.planId ||
          currentUrl.searchParams.get('dateRange') !== savedUrl.searchParams.get('dateRange')) {
        throw new Error('刷新后网址的账户、计划或数据日期已改变');
      }
      if (!checkpoint.viewport) throw new Error('刷新前窗口尺寸记录缺失');
      state.viewportLock = checkpoint.viewport;
      if (viewportChanged()) throw new Error('刷新后浏览器窗口、屏幕分辨率或缩放比例已改变');
      state.config = Object.assign({}, checkpoint.config);
      state.config.dryRun = false;
      state.currentRun = run;
      state.logs = (run.logs || []).slice(-60);
      state.busy = true;
      state.stopRequested = false;
      setPhase('刷新后恢复原直播计划素材页');
      await dismissKnownPromo();
      var current = await waitFor(function () {
        try { return context(null, true); } catch (_) { return null; }
      }, '刷新后的直播计划详情', 30000);
      if (current.accountId !== checkpoint.accountId || current.planId !== checkpoint.planId ||
          current.planName !== checkpoint.planName || current.planKind !== 'live') {
        throw new Error('刷新后的账户或直播计划与原运行不一致');
      }
      var creativeTab = unique(current.drawer.querySelectorAll('[id$="-tab-creative"]'), '直播素材标签');
      if (creativeTab.getAttribute('aria-selected') !== 'true') await safeClick(creativeTab, '返回素材标签');
      current = context(null, true);
      var videoTab = unique(Array.from(current.drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .filter(function (el) { return exactText(el) === '视频'; }), '直播视频标签');
      if (!videoTab.className.includes('--checked')) await safeClick(videoTab, '返回视频素材');
      await waitFor(function () {
        try { return context('creative', true); } catch (_) { return null; }
      }, '刷新后的直播视频素材页', 15000);
      validateConfig();
      await ensureSourceFilter();
      await ensurePageSize(100);
      await ensureSort(state.config.mode === 'roi' ? '综合营销ROI' : '创建时间');
      var page = pageNumber(context('creative').drawer);
      if (page > checkpoint.page) {
        var footer = unique(context('creative').drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '素材分页栏');
        var first = unique(Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
          .filter(function (el) { return exactText(el) === '1'; }), '素材第1页');
        await safeClick(first, '返回素材第1页');
        await waitFor(function () { return pageNumber(context('creative').drawer) === 1; }, '返回素材第1页', 10000);
        page = 1;
      }
      while (page < checkpoint.page) {
        if (!await nextPage()) throw new Error('无法返回刷新前的第' + checkpoint.page + '页');
        page = pageNumber(context('creative').drawer);
      }
      if (page !== checkpoint.page) throw new Error('刷新后素材页码与原运行不一致');
      var ready = await waitForLiveStatusPage();
      if (selectedCount(ready.drawer) !== 0 || ready.rows.some(function (item) { return item.check.checked; })) {
        throw new Error('刷新后素材页存在勾选，禁止自动继续');
      }
      if (run.groups.some(function (group) { return !group.uiSuccess; })) {
        throw new Error('本轮有提交结果不明的组，禁止自动继续');
      }
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      GM_setValue(REFRESH_KEY, null);
      sessionStorage.removeItem(REFRESH_TAB_KEY);
      run.status = 'running';
      run.stopReason = '';
      saveJournal();
      if (checkpoint.batch) {
        if (!state.batch || state.batch.status !== 'refreshing') throw new Error('直播批量记录无法匹配刷新恢复');
        state.batch.status = 'running';
        saveBatch();
      }
      addLog('已返回第' + page + '页并确认数据就绪；沿用本轮已提交素材 ID 自动继续');
      state.busy = false;
      state.viewportLock = null;
      state.currentRun = null;
      state.resumeRun = run;
      state.batchRunActive = !!checkpoint.batch;
      render();
      await start();
      if (!state.refreshing && run.status === 'running') {
        throw new Error('刷新后自动继续未完成，已停止本轮');
      }
      state.batchRunActive = false;
    } catch (error) {
      GM_setValue(REFRESH_KEY, null);
      sessionStorage.removeItem(REFRESH_TAB_KEY);
      if (run) {
        run.status = 'needs_review';
        run.verifyDeferred = run.groups.length > 0;
        run.stopReason = '刷新后恢复失败：' + error.message;
        saveJournal();
        state.report = makeReport(run);
      }
      if (checkpoint.batch && state.batch) {
        state.batch.status = 'needs_review';
        saveBatch();
      }
      setPhase('刷新恢复停止：' + error.message);
    } finally {
      if (!state.refreshing) {
        state.busy = false;
        state.viewportLock = null;
        state.resumeRun = null;
        state.batchRunActive = false;
        render();
      }
    }
  }

  async function start() {
    if (state.busy) return;
    try { readFormSnapshot(); } catch (error) { setPhase('开始前检查失败：' + error.message); return; }
    state.busy = true;
    state.stopRequested = false;
    state.stopMessage = '用户已请求停止';
    state.viewportLock = {
      width: window.innerWidth,
      height: window.innerHeight,
      ratio: window.devicePixelRatio,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      availableWidth: window.screen.availWidth,
      availableHeight: window.screen.availHeight
    };
    state.currentRun = null;
    state.report = '';
    render();
    try {
      var live = !state.config.dryRun;
      await dismissKnownPromo();
      validateConfig();
      await clearPreviewSelection();
      if (!live) {
        await ensureSourceFilter();
        await ensurePageSize(state.config.mode === 'roi' ? roiPageSize() : (state.config.planKind === 'live' ? 100 : 20));
        await ensureSort(state.config.mode === 'roi' ? '综合营销ROI' : '创建时间');
        await previewCurrentPage();
        return;
      }
      var cfg = state.config;
      var run = state.resumeRun || {
        id: 'run-' + Date.now(),
        accountId: cfg.accountId,
        accountName: cfg.accountName,
        planId: cfg.planId,
        planName: cfg.planName,
        planKind: cfg.planKind,
        bid: cfg.planKind === 'live' && cfg.liveGoal === '直播间成交' ? cfg.bid : null,
        liveRoiTarget: cfg.planKind === 'live' && cfg.liveGoal === '综合营销ROI' ? Number(cfg.liveRoiTarget) : null,
        liveGoal: cfg.planKind === 'live' ? cfg.liveGoal : null,
        liveGender: cfg.planKind === 'live' ? cfg.liveGender : null,
        skipControlling: cfg.planKind === 'live' ? cfg.skipControlling : false,
        mode: cfg.mode,
        groupSize: cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize,
        tailMin: cfg.planKind === 'live' || cfg.mode === 'date' ? cfg.tailMin : null,
        roiThreshold: cfg.mode === 'roi' ? cfg.roiThreshold : null,
        roiStrategy: cfg.mode === 'roi' ? cfg.roiStrategy : '',
        startDate: cfg.mode === 'date' ? cfg.startDate : '',
        endDate: cfg.mode === 'date' ? cfg.endDate : '',
        status: 'running',
        startedAt: new Date().toISOString(),
        groups: [],
        logs: [],
        stopReason: ''
      };
      state.currentRun = run;
      if (state.resumeRun) {
        if (run.accountId !== cfg.accountId || run.planId !== cfg.planId || run.status !== 'running' ||
            run.groups.some(function (group) { return !group.uiSuccess; })) {
          throw new Error('刷新后的本轮追投记录无法安全续跑');
        }
        state.resumeRun = null;
        addLog('刷新后恢复同一轮追投；已排除先前成功的' +
          run.groups.reduce(function (sum, group) { return sum + group.count; }, 0) + '条素材');
      } else journal.runs.push(run);
      saveJournal();
      setPhase('设置素材筛选和排序');
      await ensureSourceFilter();
      await ensurePageSize(cfg.mode === 'roi' ? roiPageSize() : (cfg.planKind === 'live' ? 100 : 20));
      await ensureSort(cfg.mode === 'roi' ? '综合营销ROI' : '创建时间');
      rowsNow();
      setPhase('逐页追投');
      try {
        run.stopReason = cfg.mode === 'roi' ? await runRoi() : await runDate();
      } catch (error) {
        if (refreshUnreadyLivePage(run, error)) return;
        run.executionError = true;
        run.stopReason = error.message;
        addLog('执行停止：' + error.message);
      }
      if (run.executionError || run.incomplete) {
        run.status = 'needs_review';
        run.verifyDeferred = run.groups.length > 0;
        if (run.verifyDeferred) addLog('追投未正常结束；保留当前素材页，不自动进入调控核查。可手动只重新核查未核清任务');
      } else if (run.groups.length) {
        setPhase('统一核查调控→素材追投');
        try {
          var allGood = await verifyTasks(true);
          run.status = allGood ? 'verified' : 'needs_review';
        } catch (verifyError) {
          run.status = 'needs_review';
          run.stopReason += '；任务核查失败：' + verifyError.message;
          addLog('任务核查失败：' + verifyError.message);
        }
      } else {
        run.status = 'stopped_without_submit';
      }
      saveJournal();
      state.report = makeReport(run);
      setPhase(run.verifyDeferred ? '已停止；未自动核查，请查看报告' :
        (run.status === 'verified' ? '已完成并核查' : '已停止，请查看报告'));
    } catch (error) {
      if (state.currentRun) {
        state.currentRun.status = 'needs_review';
        state.currentRun.stopReason = error.message;
        saveJournal();
        state.report = makeReport(state.currentRun);
      }
      setPhase('已停止：' + error.message);
      addLog('安全停止：' + error.message);
    } finally {
      state.busy = false;
      state.viewportLock = null;
      render();
      if (state.batchRunActive && !state.refreshing) advanceLiveBatch(state.currentRun);
    }
  }

  function bindInput(id, key, parser) {
    var el = shadow.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      state.config[key] = parser ? parser(el.value) : el.value;
    });
  }

  var host = document.createElement('div');
  host.id = 'qc-chase-helper-root';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  function render() {
    var cfg = state.config;
    var status = state.phase;
    var oldBody = shadow.querySelector('.body');
    var bodyScrollTop = oldBody && oldBody.getClientRects().length ? oldBody.scrollTop : state.panelScrollTop;
    state.panelScrollTop = bodyScrollTop;
    var logs = state.logs.slice(-12).map(function (line) {
      return '<div class="logline">' + esc(line) + '</div>';
    }).join('');
    var html = [
      '<style>',
      ':host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}',
      '*{box-sizing:border-box}',
      '.launcher{position:fixed;right:0;z-index:2147483645;width:34px;min-height:116px;writing-mode:vertical-rl;letter-spacing:2px;background:rgba(0,122,255,.95);color:#fff;border:1px solid rgba(255,255,255,.38);border-right:0;border-radius:13px 0 0 13px;padding:11px 7px;box-shadow:0 6px 20px rgba(0,72,158,.22);font-size:12px;font-weight:600;cursor:grab;touch-action:none;user-select:none;backdrop-filter:blur(12px)}',
      '.launcher:hover{background:#0066d6;width:38px}',
      '.panel{position:fixed;right:12px;top:12px;width:min(380px,calc(100vw - 24px));height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:hidden;flex-direction:column;z-index:2147483646;background:rgba(250,251,253,.97);border:1px solid rgba(200,208,220,.7);border-radius:18px;box-shadow:0 18px 48px rgba(28,41,62,.2),0 2px 8px rgba(28,41,62,.08);backdrop-filter:blur(18px);font-size:13px}',
      '.head{flex:none;display:flex;align-items:center;justify-content:space-between;min-height:58px;padding:12px 14px 12px 18px;color:#1d1d1f;background:rgba(255,255,255,.92);border-bottom:1px solid #e5e9ef}',
      '.head strong{font-size:15px;letter-spacing:.2px;font-weight:700}.head strong:before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:50%;background:#007aff;box-shadow:0 0 0 4px #eaf3ff;vertical-align:1px}',
      '.head button{width:30px;height:30px;display:grid;place-items:center;color:#596272;background:#f0f2f5;border:0;border-radius:50%;font-size:21px;line-height:1;cursor:pointer}.head button:hover{background:#e3e7ed;color:#1d1d1f}',
      '.body{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 16px 18px;scrollbar-color:#c8d0db transparent;scrollbar-width:thin}',
      '.muted{color:#7c8595}.card{background:#fff;border:1px solid #e5e9ef;border-radius:13px;padding:11px 12px;margin-bottom:12px;line-height:1.55;overflow-wrap:anywhere;box-shadow:0 1px 3px rgba(24,44,72,.035)}',
      '.section{font-size:12px;font-weight:700;letter-spacing:.4px;color:#596273;margin:16px 0 8px}.tabs{display:flex;gap:3px;padding:3px;background:#ebeff4;border-radius:12px}.tabs button{flex:1}',
      'button{font-family:inherit;cursor:pointer;transition:background .16s,border-color .16s,box-shadow .16s}button:disabled{opacity:.5;cursor:not-allowed}',
      '.tab{border:0;background:transparent;border-radius:9px;padding:9px 7px;color:#687284}.tab.on{background:#fff;color:#0066d6;font-weight:700;box-shadow:0 1px 4px rgba(28,41,62,.12)}',
      '.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.field{display:block;min-width:0;margin:7px 0;color:#505b6d;font-size:12px}',
      '.field input,.field select{display:block;width:100%;min-height:37px;margin-top:5px;border:1px solid #d6dde7;border-radius:10px;padding:8px 10px;background:#fff;color:#1d1d1f;font-size:13px;outline:none}.field input:focus,.field select:focus{border-color:#007aff;box-shadow:0 0 0 3px rgba(0,122,255,.12)}',
      '.row{display:flex;align-items:flex-start;gap:8px;margin:10px 0;line-height:1.45}.row input{margin:2px 0 0;accent-color:#007aff}',
      '.btn{border:1px solid #cbdcff;border-radius:10px;padding:9px 11px;color:#0066d6;background:#fff;font-weight:600}.btn:hover:not(:disabled){background:#edf5ff}.primary{background:#007aff;border-color:#007aff;color:#fff;flex:1}.primary:hover:not(:disabled){background:#0069df}.danger{border-color:#ffd4d1;color:#d33b32}.danger:hover:not(:disabled){background:#fff2f0}',
      '.buttons{display:flex;gap:8px;margin-top:12px}.status{padding:10px 11px;background:#eaf3ff;border:1px solid #d9eaff;border-radius:10px;color:#175aaf;font-weight:700;line-height:1.45}',
      '.log{height:110px;overflow:auto;background:#17202f;color:#dbe8fa;border-radius:11px;padding:9px 10px;font-family:Consolas,monospace;font-size:11px;line-height:1.55}',
      '.report{white-space:pre-wrap;background:#fff;border:1px solid #e5e9ef;border-radius:11px;padding:10px;max-height:190px;overflow:auto;line-height:1.5}',
      '.small{font-size:11px;line-height:1.48;color:#697386}.warn{color:#a14b0c}',
      '</style>',
      '<button class="launcher" id="launch" title="点击展开，拖动可调整位置" aria-label="展开千川追投助手" style="display:', state.open === false ? 'block' : 'none', ';top:', esc(state.launcherTop), '%">追投助手</button>',
      '<div class="panel" style="display:', state.open === false ? 'none' : 'flex', '">',
      '<div class="head"><strong>千川素材追投助手 v0.4.31</strong><button id="close" title="最小化" aria-label="最小化助手">−</button></div>',
      '<div class="body">',
      '<div class="card"><div class="muted">锁定账户 / ', cfg.planKind === 'live' ? '推直播间计划' : '商品自选计划', '</div>',
      '<strong>', esc(cfg.accountName || '尚未锁定'), '</strong><br>',
      esc(cfg.accountId || '账户 ID 待读取'), '<br>',
      '<strong>', esc(cfg.planName || '计划待读取'), '</strong><br>',
      esc(cfg.planId || '计划 ID 待读取'), '<br>',
      '<button class="btn" id="capture" style="margin-top:7px">锁定当前素材页计划</button></div>',
      cfg.planKind === 'live' && location.pathname === '/overall-prom' ?
        '<div class="card"><strong>账户内全部在投直播计划</strong><div class="small">演练只扫描计划列表；关闭演练后逐条处理全部在投直播计划。每计划独立计组数；异常时停止批量流程。</div><button class="btn primary" id="batch-start" style="width:100%;margin-top:7px">' +
        (cfg.dryRun ? '扫描全部在投直播计划（不提交）' : '开始全部在投直播计划追投') + '</button></div>' : '',
      state.batch && state.batch.status !== 'complete' ?
        '<div class="card"><strong>直播批量进度：</strong>' + esc(state.batch.status) + '，第' +
        esc((state.batch.index || 0) + 1) + '/' + esc(state.batch.plans.length) + '条计划。' +
        '<div class="small warn">中断后请先核对调控任务。结束记录仅停止自动续跑。</div>' +
        '<button class="btn danger" id="batch-reset">结束未完成批量流程</button></div>' : '',
      '<div class="section">执行逻辑</div><div class="tabs">',
      '<button class="tab ', cfg.mode === 'roi' ? 'on' : '', '" id="mode-roi">按 ROI 追投</button>',
      '<button class="tab ', cfg.mode === 'date' ? 'on' : '', '" id="mode-date">按创建日期追投</button></div>',
      '<div class="card" style="margin-top:9px">',
      cfg.mode === 'roi' ?
        ((cfg.planKind === 'live' ? '直播视频' : '自选投放素材') + ' · 综合营销 ROI 降序 · ' + roiPageSize() + ' 条/页。' +
          (cfg.roiStrategy === 'strict' ? '只选 ROI≥' + cfg.roiThreshold + ' 的素材；尾组达到' + (cfg.planKind === 'live' ? cfg.tailMin : 1) + '条才提交。' :
            '首次遇到 ROI＜' + cfg.roiThreshold + ' 时，凑满当前组提交后停止；该组可能包含低于阈值的素材。')) :
        ((cfg.planKind === 'live' ? '直播视频' : '自选投放素材') + ' · 创建时间降序 · ' + (cfg.planKind === 'live' ? 100 : 20) + ' 条/页。只选起始日至结束日（含两端）内创建的素材；每 ' + cfg.dateGroupSize + ' 条一组，尾组至少 ' + cfg.tailMin + ' 条才提交。'),
      '</div>',
      cfg.mode === 'date' ? [
        '<div class="grid"><label class="field">创建日期从（含）<input id="start-date" type="date" value="', esc(cfg.startDate), '"></label>',
        '<label class="field">创建日期到（含）<input id="end-date" type="date" value="', esc(cfg.endDate), '"></label></div>',
        '<div class="small">按创建时间降序扫描；遇到早于“从”日期的素材即停止。只追投一天时，两个日期填同一天。</div>'
      ].join('') : [
        '<div class="grid"><label class="field">ROI 阈值（含等于）<input id="roi-threshold" type="number" min="0" max="1000" step="0.01" value="', esc(cfg.roiThreshold), '"></label>',
        cfg.planKind === 'live' ? '<div class="field">追投策略<br><strong>严格只追投达标素材</strong></div>' :
          '<label class="field">追投策略<select id="roi-strategy">' +
          '<option value="whole_group" ' + (cfg.roiStrategy === 'whole_group' ? 'selected' : '') + '>跨阈值整组后停止</option>' +
          '<option value="strict" ' + (cfg.roiStrategy === 'strict' ? 'selected' : '') + '>严格只追投达标素材</option></select></label>', '</div>',
        cfg.planKind !== 'live' && cfg.roiStrategy === 'whole_group' ? [
          '<label class="field">遇到 ROI “—”且本组尚未跨阈值时',
          '<select id="dash-policy"><option value="pause" ', cfg.dashPolicy === 'pause' ? 'selected' : '', '>暂停并反馈（默认）</option>',
          '<option value="below" ', cfg.dashPolicy === 'below' ? 'selected' : '', '>视为低于阈值，整组提交后停止</option></select></label>'
        ].join('') : '<div class="small">严格模式遇到 ROI “—”会停止，不会追投该条及后续素材。</div>'
      ].join(''),
      '<div class="section">追投参数</div><div class="grid">',
      '<label class="field">', cfg.planKind === 'live' ? '调控日预算' : '单组预算', '（元）<input id="budget" type="number" min="100" max="500" step="1" value="', esc(cfg.budget), '"></label>',
      cfg.planKind === 'live' ? (cfg.liveGoal === '直播间成交' ?
        '<label class="field">我的出价（元/成交）<input id="bid" type="number" min="0.01" max="1000" step="0.01" value="' + esc(cfg.bid) + '"></label>' :
        '<label class="field">综合营销ROI目标<input id="live-roi-target" type="number" min="0.01" max="1000" step="0.01" value="' + esc(cfg.liveRoiTarget) + '"></label>') :
        '<label class="field">时长（小时）<input id="hours" type="number" min="0.5" max="24" step="0.5" value="' + esc(cfg.hours) + '"></label>',
      '<label class="field">本轮最多创建组数<input id="max-groups" type="number" min="1" max="', cfg.planKind === 'live' ? MAX_LIVE_GROUPS : MAX_PRODUCT_GROUPS, '" step="1" value="', esc(cfg.maxGroups), '"></label>',
      '<label class="field">每组视频数量（条）<input id="group-size" type="number" min="1" max="20" step="1" value="', esc(cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize), '"></label>',
      cfg.planKind === 'live' || cfg.mode === 'date' ? '<label class="field">最终页/停止点尾组最低数量<input id="tail-min" type="number" min="1" max="20" step="1" value="' + esc(cfg.tailMin) + '"></label>' : '',
      '<div class="field">允许已追投素材<br><strong>是</strong></div></div>',
      cfg.planKind !== 'live' && cfg.mode === 'date' ?
        '<div class="small">尾组最低数量仅用于最后一页或遇到早于起始日期的停止点；达到最低数量才提交尾组，不足则不提交。有下一页且尚未到日期停止点时，本页余组会先提交再翻页。</div>' : '',
      cfg.planKind === 'live' ?
        '<div class="small">直播 ROI 追投只选审核通过的素材；按创建日期追投也允许日期范围内的“未审核”素材。跳过已暂停和审核不通过；整组勾选后再次等待列表稳定，取消不符合当前模式规则的素材并从后面补选，复核通过才提交。</div>' :
        '<div class="small">推商品按 ROI 或创建日期选自选投放素材，不按审核状态取消勾选。翻页前会先提交本页余组；千川追投弹窗若过滤素材，只按弹窗实际接收的素材提交。</div>',
      cfg.planKind === 'live' ? [
        '<div class="card">追投方式：控成本追投。<div class="grid">',
        '<label class="field">优化目标<select id="live-goal">',
        '<option value="直播间成交" ', cfg.liveGoal === '直播间成交' ? 'selected' : '', '>直播间成交</option>',
        '<option value="综合营销ROI" ', cfg.liveGoal === '综合营销ROI' ? 'selected' : '', '>综合营销ROI</option></select></label>',
        '<label class="field">定向性别<select id="live-gender">',
        '<option value="不限" ', cfg.liveGender === '不限' ? 'selected' : '', '>不限</option>',
        '<option value="男" ', cfg.liveGender === '男' ? 'selected' : '', '>男</option>',
        '<option value="女" ', cfg.liveGender === '女' ? 'selected' : '', '>女</option></select></label></div>',
        '<label class="row"><input id="skip-controlling" type="checkbox" ', cfg.skipControlling ? 'checked' : '', '> 跳过“素材追投”列显示调控中的素材</label>',
        '<div class="small">直播每页100条；同页凑组并提交，翻页不携带勾选。有下一页时，本页剩余合格素材会单独提交一组（即使低于尾组最低数量），再翻页继续。数据等待30秒仍未就绪时，每页最多自动刷新一次，返回原页并沿用本轮素材ID继续。</div></div>'
      ].join('') : '',
      '<div class="card" id="quantity-preview">本轮最多 ', esc(cfg.maxGroups), ' 组 × 每组 ',
      esc(cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize), ' 条 = 最多 ',
      esc(cfg.maxGroups * (cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize)), ' 条素材。</div>',
      '<div class="small">可再次执行同一计划；本地历史提交记录仅用于核查，不阻止新一轮创建。千川明确提示“操作失败”且原弹窗、素材和参数不变时，只重试提交一次；结果不明或超时仍会停止。</div>',
      '<div class="small">正常追投结束后统一进入调控页核查；中途异常或手动停止时留在素材页，待手动核查，不自动重提。</div>',
      '<div class="hint">推商品翻页前先提交本页余量，再清空勾选并翻页；不足设定条数也会单独成组，预算仍按单组设置，并计入组数上限。</div>',
      '<label class="row"><input id="dry-run" type="checkbox" ', cfg.dryRun ? 'checked' : '', '> 演练模式：只检查当前页，勾选最多一组，不提交</label>',
      '<div class="small warn">正式执行仅限当前锁定计划。演练勾选会在正式开始前核对并清除；运行中不操作原计划预算、ROI 目标和投放状态。</div>',
      '<div class="buttons"><button class="btn primary" id="start" ', state.busy ? 'disabled' : '', '>',
      cfg.dryRun ? '检查并勾选一组（不提交）' : '开始追投并提交', '</button>',
      '<button class="btn danger" id="stop" ', state.busy ? '' : 'disabled', '>停止</button></div>',
      '<button class="btn" id="recheck" style="width:100%;margin-top:8px" ', state.busy ? 'disabled' : '', '>只重新核查未核清任务（不提交）</button>',
      '<div class="section">执行状态</div><div class="status">', esc(status), '</div>',
      '<div class="section">执行记录</div><div class="log">', logs || '暂无记录', '</div>',
      state.report ? '<div class="section">结果报告</div><div class="report">' + esc(state.report) + '</div><button class="btn" id="copy" style="margin-top:7px">复制报告</button>' : '',
      '</div></div>'
    ].join('');
    shadow.innerHTML = html;
    var newBody = shadow.querySelector('.body');
    if (newBody) newBody.scrollTop = bodyScrollTop;
    var launcher = shadow.getElementById('launch');
    var dragStart = null;
    var suppressLaunchClick = false;
    launcher.onpointerdown = function (event) {
      dragStart = { y: event.clientY, top: launcher.getBoundingClientRect().top };
      launcher.setPointerCapture(event.pointerId);
    };
    launcher.onpointermove = function (event) {
      if (!dragStart) return;
      if (Math.abs(event.clientY - dragStart.y) > 5) suppressLaunchClick = true;
      if (!suppressLaunchClick) return;
      var top = Math.max(12, Math.min(window.innerHeight - launcher.offsetHeight - 12,
        dragStart.top + event.clientY - dragStart.y));
      launcher.style.top = top + 'px';
      state.launcherTop = top / window.innerHeight * 100;
    };
    launcher.onpointerup = function () {
      if (suppressLaunchClick) GM_setValue(LAUNCHER_TOP_KEY, state.launcherTop);
      dragStart = null;
      setTimeout(function () { suppressLaunchClick = false; }, 0);
    };
    launcher.onpointercancel = function () { dragStart = null; suppressLaunchClick = false; };
    launcher.onclick = function () {
      if (suppressLaunchClick) return;
      state.open = true;
      render();
    };
    shadow.getElementById('close').onclick = function () { state.open = false; render(); };
    shadow.getElementById('capture').onclick = captureCurrent;
    var batchButton = shadow.getElementById('batch-start');
    if (batchButton) batchButton.onclick = startLiveBatch;
    var batchReset = shadow.getElementById('batch-reset');
    if (batchReset) batchReset.onclick = function () {
      if (state.busy) return;
      state.batch.status = 'cancelled';
      saveBatch();
      state.batch = null;
      setPhase('已结束批量自动续跑；未提交新任务');
    };
    shadow.getElementById('mode-roi').onclick = function () {
      if (state.busy) return;
      cfg.mode = 'roi'; render();
    };
    shadow.getElementById('mode-date').onclick = function () {
      if (state.busy) return;
      cfg.mode = 'date'; render();
    };
    bindInput('budget', 'budget', Number);
    bindInput('hours', 'hours', Number);
    bindInput('bid', 'bid', Number);
    bindInput('live-roi-target', 'liveRoiTarget');
    var liveGoal = shadow.getElementById('live-goal');
    if (liveGoal) liveGoal.onchange = function () { cfg.liveGoal = liveGoal.value; render(); };
    var liveGender = shadow.getElementById('live-gender');
    if (liveGender) liveGender.onchange = function () { cfg.liveGender = liveGender.value; };
    bindInput('tail-min', 'tailMin', Number);
    var skip = shadow.getElementById('skip-controlling');
    if (skip) skip.onchange = function () { cfg.skipControlling = skip.checked; };
    bindInput('max-groups', 'maxGroups', Number);
    bindInput('group-size', cfg.mode === 'roi' ? 'roiGroupSize' : 'dateGroupSize', Number);
    function updateQuantityPreview() {
      var groups = Number(shadow.getElementById('max-groups').value);
      var size = Number(shadow.getElementById('group-size').value);
      var maxAllowed = cfg.planKind === 'live' ? MAX_LIVE_GROUPS : MAX_PRODUCT_GROUPS;
      shadow.getElementById('quantity-preview').textContent =
        Number.isInteger(groups) && groups >= 1 && groups <= maxAllowed &&
        Number.isInteger(size) && size >= 1 && size <= 20 ?
          '本轮最多 ' + groups + ' 组 × 每组 ' + size + ' 条 = 最多 ' + (groups * size) + ' 条素材。' :
          '请填写有效组数（1–' + maxAllowed + '）和每组视频数量（1–20）。';
    }
    shadow.getElementById('max-groups').addEventListener('input', updateQuantityPreview);
    shadow.getElementById('group-size').addEventListener('input', updateQuantityPreview);
    bindInput('roi-threshold', 'roiThreshold', function (value) {
      return value.trim() === '' ? NaN : Number(value);
    });
    shadow.getElementById('group-size').addEventListener('change', function () { if (!state.busy) render(); });
    var roiThresholdInput = shadow.getElementById('roi-threshold');
    if (roiThresholdInput) roiThresholdInput.addEventListener('change', function () { if (!state.busy) render(); });
    bindInput('start-date', 'startDate');
    bindInput('end-date', 'endDate');
    var dash = shadow.getElementById('dash-policy');
    if (dash) dash.onchange = function () { cfg.dashPolicy = dash.value; };
    var strategy = shadow.getElementById('roi-strategy');
    if (strategy) strategy.onchange = function () { cfg.roiStrategy = strategy.value; render(); };
    shadow.getElementById('dry-run').onchange = function (event) {
      cfg.dryRun = event.target.checked;
      render();
    };
    shadow.getElementById('start').onclick = start;
    shadow.getElementById('recheck').onclick = recheckPending;
    shadow.getElementById('stop').onclick = function () {
      state.stopRequested = true;
      state.stopMessage = '用户已请求停止';
      addLog('用户请求停止；当前提交若已点击，会先等待结果再停止');
    };
    var copy = shadow.getElementById('copy');
    if (copy) copy.onclick = function () { GM_setClipboard(state.report, 'text'); addLog('报告已复制'); };
    if (state.busy) {
      ['capture', 'budget', 'hours', 'bid', 'live-roi-target', 'live-goal', 'live-gender', 'tail-min', 'skip-controlling', 'max-groups', 'group-size', 'roi-threshold', 'roi-strategy', 'start-date', 'end-date', 'dash-policy', 'dry-run']
        .forEach(function (id) {
          var el = shadow.getElementById(id);
          if (el) el.disabled = true;
        });
    }
  }

  render();
  var savedRefresh = GM_getValue(REFRESH_KEY, null);
  if (savedRefresh) {
    var currentTabToken = '';
    try { currentTabToken = sessionStorage.getItem(REFRESH_TAB_KEY) || ''; } catch (_) { /* 不跨标签页自动恢复 */ }
    if (currentTabToken && currentTabToken === savedRefresh.tabToken) resumeAfterDataRefresh(savedRefresh);
    else setPhase('另一千川标签页正在恢复素材数据；本标签页不自动续跑');
  }
  else if (state.batch && state.batch.status === 'refreshing') {
    state.batch.status = 'needs_review';
    saveBatch();
    setPhase('直播批量刷新恢复记录缺失，已停止自动续跑');
  } else if (state.batch) resumeLiveBatch();
})();
