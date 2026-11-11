// ==UserScript==
// @name         Qianchuan Material Chase Assistant (Android)
// @namespace    local.qianchuan.chase
// @version      0.4.38
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-android.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-android.user.js
// @description  Android old/new material status headers; product/live eligibility, semantic tables and pagination compatibility.
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
  var SOURCE_LABEL = '\u81EA\u9009\u6295\u653E\u7D20\u6750';
  var FILTER_LABEL = '\u81EA\u9009\u6295\u653E';
  var SUCCESS_RE = /\u64CD\u4F5C\u6210\u529F|\u521B\u5EFA\u6210\u529F|\u63D0\u4EA4\u6210\u529F/;
  var FAILURE_RE = /\u64CD\u4F5C\u5931\u8D25|\u521B\u5EFA\u5931\u8D25|\u63D0\u4EA4\u5931\u8D25|\u8BF7\u6C42\u5931\u8D25|\u7CFB\u7EDF\u7E41\u5FD9|\u7A0D\u540E\u91CD\u8BD5/;
  var RETRYABLE_FAILURE_RE = /\u64CD\u4F5C\u5931\u8D25|\u521B\u5EFA\u5931\u8D25|\u63D0\u4EA4\u5931\u8D25/;
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
      liveGoal: '\u76F4\u64AD\u95F4\u6210\u4EA4',
      liveRoiTarget: '',
      liveGender: '\u4E0D\u9650',
      tailMin: 5
    },
    busy: false,
    stopRequested: false,
    stopMessage: '\u7528\u6237\u5DF2\u8BF7\u6C42\u505C\u6B62',
    viewportLock: null,
    phase: '\u7B49\u5F85\u9501\u5B9A\u5F53\u524D\u8BA1\u5212',
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
    if (found.length !== 1) throw new Error(label + '\u5E94\u6070\u597D\u51FA\u73B0\u4E00\u6B21\uFF0C\u5B9E\u9645\u4E3A' + found.length + '\u6B21');
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
          if (Date.now() > limit) return reject(new Error('\u7B49\u5F85\u8D85\u65F6\uFF1A' + label));
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
      return visible(el) && exactText(el).includes('\u5F00\u542F\u8054\u76DF\u5408\u4F5C\u8FBE\u4EBA\u81EA\u52A8\u6295') &&
        exactText(el).includes('\u65B0\u5EFA\u81EA\u52A8\u6295\u653E\u8BA1\u5212');
    });
    if (!matches.length) return;
    var promo = unique(matches, '\u8054\u76DF\u5408\u4F5C\u8FBE\u4EBA\u81EA\u52A8\u6295\u63A8\u5E7F\u5F39\u7A97');
    var close = unique(promo.querySelectorAll('.tools-vmok-plugin-modal__close-icon'), '\u63A8\u5E7F\u5F39\u7A97\u5173\u95ED\u6309\u94AE');
    setPhase('\u5173\u95ED\u8054\u76DF\u5408\u4F5C\u8FBE\u4EBA\u81EA\u52A8\u6295\u63A8\u5E7F\u5F39\u7A97');
    await sleep(CLICK_PREVIEW_MS);
    if (!visible(promo) || !visible(close)) throw new Error('\u63A8\u5E7F\u5F39\u7A97\u5173\u95ED\u6309\u94AE\u5DF2\u53D8\u5316');
    close.click();
    await waitFor(function () { return !visible(promo); }, '\u63A8\u5E7F\u5F39\u7A97\u5173\u95ED', 5000);
    await sleep(CLICK_SETTLE_MS);
    addLog('\u5DF2\u5173\u95ED\u8054\u76DF\u5408\u4F5C\u8FBE\u4EBA\u81EA\u52A8\u6295\u63A8\u5E7F\u5F39\u7A97');
  }

  async function safeClick(el, label, allowDuringStop, onBeforeClick) {
    await dismissKnownPromo();
    if (!visible(el)) throw new Error(label + '\u4E0D\u53EF\u89C1');
    if (!allowDuringStop) assertViewport();
    if (state.stopRequested && !allowDuringStop) throw new Error(state.stopMessage);
    setPhase('\u5373\u5C06\u70B9\u51FB\uFF1A' + label);
    await sleep(CLICK_PREVIEW_MS);
    if (!visible(el)) throw new Error(label + '\u5728\u70B9\u51FB\u524D\u5DF2\u6D88\u5931');
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
    if (!inAllowedSurface) throw new Error(label + '\u4E0D\u5728\u5141\u8BB8\u64CD\u4F5C\u7684\u7D20\u6750\u6216\u8FFD\u6295\u754C\u9762\u5185');
    if (typeof onBeforeClick === 'function') onBeforeClick();
    el.click();
    setPhase('\u5DF2\u70B9\u51FB\uFF1A' + label);
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
      state.stopMessage = '\u6D4F\u89C8\u5668\u7A97\u53E3\u3001\u5C4F\u5E55\u5206\u8FA8\u7387\u6216\u7F29\u653E\u6BD4\u4F8B\u6539\u53D8\uFF0C\u5DF2\u505C\u6B62\u540E\u7EED\u64CD\u4F5C';
    }
  }

  window.addEventListener('resize', function () {
    if (state.busy && viewportChanged() && !state.stopRequested) {
      state.stopRequested = true;
      state.stopMessage = '\u6D4F\u89C8\u5668\u7A97\u53E3\u3001\u5C4F\u5E55\u5206\u8FA8\u7387\u6216\u7F29\u653E\u6BD4\u4F8B\u6539\u53D8\uFF0C\u5DF2\u505C\u6B62\u540E\u7EED\u64CD\u4F5C';
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
      return !exactText(el).includes('\u5F00\u542F\u8054\u76DF\u5408\u4F5C\u8FBE\u4EBA\u81EA\u52A8\u6295') ||
        !exactText(el).includes('\u65B0\u5EFA\u81EA\u52A8\u6295\u653E\u8BA1\u5212');
    })) throw new Error('\u51FA\u73B0\u4E86\u672A\u77E5\u63A8\u5E7F\u5F39\u7A97\uFF0C\u5DF2\u505C\u6B62');
    var siteModals = Array.from(document.querySelectorAll('.main-vmok-plugin-modal__wrap')).filter(visible);
    if (siteModals.some(function (el) { return !el.classList.contains('assist-task-modal'); })) {
      throw new Error('\u51FA\u73B0\u4E86\u975E\u8FFD\u6295\u5F39\u7A97\uFF0C\u5DF2\u505C\u6B62');
    }
    var dialogs = Array.from(document.querySelectorAll('[role="dialog"], .main-vmok-plugin-modal__wrap'))
      .filter(visible).map(exactText).join(' ');
    if (/\u8BF7\u8F93\u5165\u9A8C\u8BC1\u7801|\u6ED1\u5757\u9A8C\u8BC1|\u767B\u5F55\u5DF2\u5931\u6548|\u767B\u5F55\u5931\u6548|\u6743\u9650\u4E0D\u8DB3|\u8BBF\u95EE\u53D7\u9650|\u5E73\u53F0\u98CE\u63A7/.test(dialogs)) {
      throw new Error('\u68C0\u6D4B\u5230\u767B\u5F55\u3001\u9A8C\u8BC1\u3001\u6743\u9650\u6216\u5E73\u53F0\u98CE\u63A7\u63D0\u793A');
    }
  }

  function readAccountIdentity(url) {
    var accountId = url.searchParams.get('aavid') || '';
    if (!/^\d+$/.test(accountId)) throw new Error('\u7F51\u5740\u4E2D\u7684\u8D26\u6237 ID \u65E0\u6548');
    // Tablet layouts can hide the account header under the plan drawer.
    // Only use visible headers as page evidence; never select a stale hidden header.
    var headers = Array.from(document.querySelectorAll('.account-info-box')).filter(visible);
    var names = [];
    headers.forEach(function (el) {
      var text = exactText(el);
      var match = text.match(/ID[\uFF1A:]\s*(\d+)/);
      if (!match) throw new Error('\u9875\u9762\u8D26\u6237 ID \u5C1A\u672A\u52A0\u8F7D\u5B8C\u6574');
      if (match[1] !== accountId) throw new Error('\u7F51\u5740\u4E0E\u9875\u9762\u8D26\u6237 ID \u4E0D\u4E00\u81F4');
      var name = text.slice(0, match.index).trim();
      if (name && names.indexOf(name) < 0) names.push(name);
    });
    if (names.length > 1) throw new Error('\u9875\u9762\u8D26\u6237\u540D\u79F0\u5B58\u5728\u51B2\u7A81');
    var lockedName = state.config.accountId === accountId ? state.config.accountName : '';
    return { accountId: accountId, accountName: names[0] || lockedName ||
      '\u8D26\u6237 ' + accountId };
  }

  function context(requiredTab, ignoreLock) {
    checkPlatformBlock();
    var url = new URL(location.href);
    var livePlan = url.pathname === '/overall-prom/detail' && url.hash.includes('marGoal=2');
    var productPlan = url.pathname === '/overall-prom' && url.hash.includes('marGoal=1');
    if (url.origin !== 'https://qianchuan.jinritemai.com' || (!livePlan && !productPlan)) {
      throw new Error('\u4E0D\u662F\u5343\u5DDD\u4E58\u65B9\u5546\u54C1\u6216\u76F4\u64AD\u8BA1\u5212\u7D20\u6750\u9875');
    }
    if (url.searchParams.get('campaignType') !== '1' || url.searchParams.get('uniTab') !== 'ad') {
      throw new Error('\u5F53\u524D\u4E0D\u662F\u4E58\u65B9\u5728\u6295\u8BA1\u5212\u8DEF\u5F84');
    }
    var account = readAccountIdentity(url);
    var accountId = account.accountId;
    var accountName = account.accountName;
    var drawer = unique(document.querySelectorAll('.ad-detail-wrapper'), '\u8BA1\u5212\u8BE6\u60C5\u62BD\u5C49');
    var topLines = (drawer.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 12);
    var planName = livePlan ? topLines[2] : topLines[0] || '';
    var planIdMatch = topLines.join('\n').match(livePlan ? /\u8BA1\u5212ID[\uFF1A:]\s*(\d+)/ : /ID[\uFF1A:]\s*(\d+)/);
    if (!planIdMatch) throw new Error('\u65E0\u6CD5\u8BFB\u53D6\u5F53\u524D\u8BA1\u5212 ID');
    var planId = planIdMatch[1];
    if (url.searchParams.get('aavid') !== accountId || url.searchParams.get('adId') !== planId) {
      throw new Error('\u7F51\u5740\u4E0E\u9875\u9762\u5C55\u793A\u7684\u8D26\u6237\u6216\u8BA1\u5212 ID \u4E0D\u4E00\u81F4');
    }
    if (!topLines.includes('\u6295\u653E\u4E2D')) throw new Error('\u5F53\u524D\u8BA1\u5212\u4E0D\u662F\u201C\u6295\u653E\u4E2D\u201D');
    if (livePlan) {
      if (topLines[0] !== '\u63A8\u76F4\u64AD\u95F4' || !planName || !topLines.includes('\u76F4\u64AD\u5927\u5C4F')) {
        throw new Error('\u5F53\u524D\u8BA1\u5212\u4E0D\u662F\u63A8\u76F4\u64AD\u95F4\u8BA1\u5212');
      }
      if (requiredTab === 'creative' && !Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .some(function (el) { return exactText(el) === '\u89C6\u9891' && el.className.includes('--checked'); })) {
        throw new Error('\u76F4\u64AD\u8BA1\u5212\u5FC5\u987B\u5728\u201C\u7D20\u6750\u2192\u89C6\u9891\u201D\u9875');
      }
    } else {
      var goods = document.querySelector('[id$="-tab-1"][aria-selected="true"]');
      var activeTabs = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map(exactText);
      var oldSelfSelect = activeTabs.includes('\u5546\u54C1\u81EA\u9009');
      var newSelfSelect = activeTabs.includes('\u8BA1\u5212\u89C6\u56FE') &&
        Array.from(document.querySelectorAll('label')).some(function (label) {
          var radio = label.querySelector('input[type="radio"]');
          return visible(label) && exactText(label) === '\u5546\u54C1\u81EA\u9009' && radio && radio.checked;
        });
      if (!goods || !activeTabs.includes('\u5546\u54C1') || !(oldSelfSelect || newSelfSelect)) {
        throw new Error('\u5FC5\u987B\u5728\u5546\u54C1\u81EA\u9009\u7684\u5728\u6295\u8BA1\u5212\u4E2D\uFF08\u517C\u5BB9\u8BA1\u5212\u89C6\u56FE\u65B0\u7248\u5165\u53E3\uFF09');
      }
    }
    if (requiredTab) {
      var tab = drawer.querySelector('[id$="-tab-' + requiredTab + '"][aria-selected="true"]');
      if (!tab) throw new Error('\u5F53\u524D\u8BA1\u5212\u62BD\u5C49\u672A\u5904\u4E8E\u6307\u5B9A\u6807\u7B7E\uFF1A' + requiredTab);
    }
    if (!ignoreLock && state.config.accountId && (
      accountId !== state.config.accountId ||
      planId !== state.config.planId ||
      planName !== state.config.planName ||
      (livePlan ? 'live' : 'product') !== state.config.planKind
    )) throw new Error('\u8D26\u6237\u6216\u8BA1\u5212\u5DF2\u6539\u53D8\uFF0C\u5DF2\u505C\u6B62');
    return { drawer: drawer, accountId: accountId, accountName: accountName, planId: planId,
      planName: planName, planKind: livePlan ? 'live' : 'product' };
  }

  async function captureCurrent() {
    try {
      if (state.busy) throw new Error('\u6267\u884C\u8FC7\u7A0B\u4E2D\u4E0D\u80FD\u5207\u6362\u8BA1\u5212');
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
        state.config.liveGoal = '\u76F4\u64AD\u95F4\u6210\u4EA4';
        state.config.liveRoiTarget = '';
        state.config.liveGender = '\u4E0D\u9650';
        state.config.tailMin = 5;
      }
      state.config.dryRun = true;
      state.currentRun = null;
      state.report = '';
      state.phase = '\u5DF2\u9501\u5B9A\u5F53\u524D' + (current.planKind === 'live' ? '\u76F4\u64AD' : '\u5546\u54C1\u81EA\u9009') + '\u8BA1\u5212\uFF1B\u53EF\u4E3B\u52A8\u518D\u6B21\u521B\u5EFA\u8FFD\u6295\u4EFB\u52A1';
      addLog('\u9501\u5B9A ' + current.accountName + ' \u2192 ' + current.planName + '\uFF08' + current.planId + '\uFF09');
    } catch (error) { setPhase('\u9501\u5B9A\u5931\u8D25\uFF1A' + error.message); }
    render();
  }

  function filterChip(drawer, text) {
    return Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-filter-echo-item'))
      .some(function (el) { return exactText(el).replace(/\s+/g, '').includes(text.replace(/\s+/g, '')); });
  }

  async function ensureSourceFilter() {
    if (state.config.planKind === 'live') {
      context('creative');
      addLog('\u5DF2\u786E\u8BA4\u76F4\u64AD\u7D20\u6750\u2192\u89C6\u9891\u9875');
      return;
    }
    var drawer = context('creative').drawer;
    if (filterChip(drawer, '\u7D20\u6750\u7C7B\u578B\uFF1A' + FILTER_LABEL)) return;
    var button = unique(drawer.querySelectorAll('.main-vmok-plugin-more-filter-btn button'), '\u7D20\u6750\u9875\u201C\u66F4\u591A\u7B5B\u9009\u201D\u6309\u94AE');
    if (!/^\u66F4\u591A\u7B5B\u9009(?:\s*\d+)?$/.test(exactText(button))) {
      throw new Error('\u201C\u66F4\u591A\u7B5B\u9009\u201D\u6309\u94AE\u6587\u5B57\u65E0\u6CD5\u8BC6\u522B\uFF1A' + exactText(button));
    }
    await safeClick(button, '\u66F4\u591A\u7B5B\u9009');
    var item = await waitFor(function () {
      return Array.from(document.querySelectorAll('.main-vmok-plugin-body-title-item'))
        .filter(visible).find(function (el) { return exactText(el).includes('\u7D20\u6750\u7C7B\u578B'); });
    }, '\u7D20\u6750\u7C7B\u578B\u7B5B\u9009');
    var popup = item.closest('.main-vmok-plugin-oc-popover-text__content');
    if (!popup || !visible(popup)) throw new Error('\u65E0\u6CD5\u786E\u8BA4\u7D20\u6750\u7B5B\u9009\u9762\u677F');
    var selectInput = unique(
      item.querySelectorAll('.main-vmok-plugin-oc-filter-select-filter input.main-vmok-plugin-input[readonly][placeholder="\u8BF7\u9009\u62E9"]'),
      '\u7D20\u6750\u7C7B\u578B\u201C\u8BF7\u9009\u62E9\u201D\u8F93\u5165\u6846'
    );
    await safeClick(selectInput, '\u7D20\u6750\u7C7B\u578B\u201C\u8BF7\u9009\u62E9\u201D\u8F93\u5165\u6846');
    var option = await waitFor(function () {
      return Array.from(document.querySelectorAll('li.main-vmok-plugin-cascader-panel__selection-item'))
        .filter(visible).find(function (el) { return exactText(el) === FILTER_LABEL; });
    }, FILTER_LABEL + '\u9009\u9879');
    await safeClick(option, FILTER_LABEL + '\u9009\u9879');
    var confirm = textMatch(popup, 'button', '\u786E\u5B9A', '\u7B5B\u9009\u201C\u786E\u5B9A\u201D\u6309\u94AE');
    await safeClick(confirm, '\u7B5B\u9009\u786E\u5B9A');
    await waitFor(function () {
      return filterChip(context('creative').drawer, '\u7D20\u6750\u7C7B\u578B\uFF1A' + FILTER_LABEL);
    }, '\u81EA\u9009\u7D20\u6750\u7B5B\u9009\u751F\u6548', 8000);
    addLog('\u7D20\u6750\u7C7B\u578B\u5DF2\u7B5B\u9009\u4E3A\u201C' + FILTER_LABEL + '\u201D');
  }

  function tableLayoutVisible(el) {
    if (!el || !el.isConnected) return false;
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || node.hidden ||
          node.getAttribute('aria-hidden') === 'true') return false;
    }
    // Some Android table wrappers have a zero-sized box although their cells are laid out.
    return visible(el) || Array.from(el.querySelectorAll('th, td, input, button')).some(visible);
  }

  function materialHeaderCells(head) {
    return Array.from(head.querySelectorAll('thead tr')).map(function (tr) {
      return Array.from(tr.querySelectorAll(':scope > th'));
    }).sort(function (a, b) { return b.length - a.length; })[0] || [];
  }

  function materialHeaderCheckbox(table) {
    // Android may render the header and all material rows inside the same table.
    // Scope to the actual first header cell; never include tbody checkboxes.
    var cells = materialHeaderCells(table.head);
    if (!cells.length) throw new Error('\u7D20\u6750\u8868\u5934\u7B2C\u4E00\u5217\u5C1A\u672A\u52A0\u8F7D');
    return unique(cells[0].querySelectorAll('input[type="checkbox"]'), '\u7D20\u6750\u8868\u5934\u5168\u9009');
  }

  function materialHeaderText(th) {
    var label = exactText(th).replace(/\s+/g, '');
    // New live UI renamed the audit column. Keep the cell index and all status checks.
    return label === '\u7D20\u6750\u72B6\u6001' ? '\u5BA1\u6838\u72B6\u6001' : label;
  }

  function materialTable(drawer) {
    var required = state.config.planKind === 'live' ? ['\u89C6\u9891\u7C7B\u578B', '\u7D20\u6750\u8FFD\u6295', '\u89C6\u9891'] : [];
    required.push('\u521B\u5EFA\u65F6\u95F4');
    if (state.config.mode === 'roi') required.push('\u7EFC\u5408\u8425\u9500ROI');
    required.push('\u64CD\u4F5C', '\u5BA1\u6838\u72B6\u6001');
    var tables = Array.from(drawer.querySelectorAll('table')).filter(tableLayoutVisible);
    var candidates = tables.map(function (head) {
      return { head: head, headers: materialHeaderCells(head).map(materialHeaderText) };
    }).filter(function (table) {
      return required.every(function (label) { return table.headers.includes(label); }) &&
        (table.headers.includes('\u89C6\u9891') || table.headers.includes('\u7D20\u6750\u7C7B\u578B'));
    });
    if (!candidates.length) {
      var observed = tables.map(function (table) {
        return materialHeaderCells(table).map(materialHeaderText).join('|');
      }).filter(Boolean).join(' / ');
      throw new Error('\u672A\u8BC6\u522B\u5B8C\u6574\u7D20\u6750\u8868\u5934\uFF1Btable=' + tables.length +
        '\uFF1B\u5217=' + (observed.slice(0, 700) || '\u65E0') +
        '\uFF1B\u9700\u8981=' + required.join('|'));
    }
    var pairs = [];
    candidates.forEach(function (candidate) {
      // Prefer the nearest table container, so the background plan list or a fixed-column
      // clone can never be paired with an unrelated material header.
      for (var root = candidate.head; root && drawer.contains(root); root = root.parentElement) {
        var nearby = root === candidate.head ? [root] : Array.from(root.querySelectorAll('table'));
        var bodies = nearby.filter(function (body) {
          if (!tableLayoutVisible(body)) return false;
          var rows = Array.from(body.querySelectorAll('tbody tr')).filter(visible);
          return rows.length && rows.every(function (row) {
            var cells = Array.from(row.querySelectorAll(':scope > td'));
            return cells.length === candidate.headers.length &&
              /\u7D20\u6750\s*ID[\uFF1A:]\s*\d+/.test(exactText(row));
          });
        });
        if (bodies.length) {
          bodies.forEach(function (body) {
            pairs.push({ head: candidate.head, body: body, headers: candidate.headers });
          });
          break;
        }
        if (root === drawer) break;
      }
    });
    if (!pairs.length) throw new Error('\u7D20\u6750\u8868\u5934\u5DF2\u8BC6\u522B\uFF0C\u7B49\u5F85\u5217\u6570\u5339\u914D\u7684\u7D20\u6750\u884C');
    var signatures = new Set(pairs.map(function (pair) {
      return pair.headers.join('|') + ':' + Array.from(pair.body.querySelectorAll('tbody tr')).filter(visible)
        .map(function (row) { return (exactText(row).match(/\u7D20\u6750\s*ID[\uFF1A:]\s*(\d+)/) || [])[1]; }).join('|');
    }));
    if (signatures.size !== 1) throw new Error('\u627E\u5230\u591A\u4E2A\u4E0D\u4E00\u81F4\u7684\u7D20\u6750\u8868\uFF0C\u7B49\u5F85\u9875\u9762\u5237\u65B0');
    var head = pairs[0].head;
    var body = pairs[0].body;
    var headers = pairs[0].headers;
    var missing = required.filter(function (label) { return !headers.includes(label); });
    if (state.config.planKind !== 'live' && !headers.includes('\u89C6\u9891') && !headers.includes('\u7D20\u6750\u7C7B\u578B')) {
      missing.push('\u89C6\u9891\u6216\u7D20\u6750\u7C7B\u578B');
    }
    if (missing.length) throw new Error('\u7D20\u6750\u8868\u7F3A\u5C11\u5217\u201C' + missing.join('\u3001') + '\u201D\uFF1B\u5F53\u524D\u8868\u5934\uFF1A' + headers.join('\u3001'));
    return { head: head, body: body, headers: headers };
  }

  function materialPageSizeInput(footer) {
    var inputs = Array.from(footer.querySelectorAll('input[readonly]')).filter(function (input) {
      return tableLayoutVisible(input) && /^\d+\s*\u6761\s*\/\s*\u9875$/.test((input.value || '').trim());
    });
    return unique(inputs, '\u6BCF\u9875\u6761\u6570');
  }

  function materialPagination(drawer) {
    var legacy = Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'))
      .filter(tableLayoutVisible);
    if (legacy.length === 1) return legacy[0];
    if (legacy.length > 1) throw new Error('\u5F53\u524D\u62BD\u5C49\u5185\u6709\u591A\u4E2A\u7D20\u6750\u5206\u9875\u680F');
    var candidates = Array.from(drawer.querySelectorAll('[class*="pagination"], [class*="Pagination"]'))
      .filter(function (el) {
        if (!tableLayoutVisible(el) || !/\u5171\s*\d+\s*\u6761\u8BB0\u5F55/.test(exactText(el))) return false;
        try { return !!materialPageSizeInput(el); } catch (_) { return false; }
      });
    var innermost = candidates.filter(function (el) {
      return !candidates.some(function (other) { return other !== el && el.contains(other); });
    });
    return unique(innermost, '\u7D20\u6750\u5206\u9875\u680F');
  }

  function activeSort(table, label) {
    var candidates = materialHeaderCells(table.head).filter(function (th) {
      return materialHeaderText(th) === label;
    });
    var th = unique(candidates, label + '\u5217');
    return th.getAttribute('aria-sort') === 'descending' ||
      !!th.querySelector('[class*="sorter-down--active"]');
  }

  function sortedPageSignature(label) {
    var drawer = context('creative').drawer;
    var table = materialTable(drawer);
    if (!activeSort(table, label)) return '';
    var column = table.headers.indexOf(label);
    if (column < 0) return '';
    var footer = materialPagination(drawer);
    var countMatch = exactText(footer).match(/\u5171\s*(\d+)\s*\u6761\u8BB0\u5F55/);
    var sizeInput = materialPageSizeInput(footer);
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
      var id = (exactText(cells[1]).match(/\u7D20\u6750ID[\uFF1A:]\s*(\d+)/) || [])[1];
      if (!id) return '';
      signature.push(id + ':' + raw);
      var value;
      if (label === '\u7EFC\u5408\u8425\u9500ROI') {
        if (/^[-\u2014\u2013\/]*$/.test(raw) || raw === '\u6682\u65E0\u6570\u636E') continue;
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
      try { signature = sortedPageSignature(label); } catch (_) { /* \u9875\u9762\u5207\u6362\u4E2D\u7684\u77ED\u6682\u7A7A\u8868 */ }
      if (!signature) { lastSignature = ''; return false; }
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
        return false;
      }
       return Date.now() - stableSince >= 1500;
    }, label + '\u964D\u5E8F\u53CA\u6574\u9875\u6570\u636E\u7A33\u5B9A', 12000);
  }

  async function ensureSort(label) {
    var drawer = context('creative').drawer;
    var table = materialTable(drawer);
    if (!activeSort(table, label)) {
      var th = unique(materialHeaderCells(table.head).filter(function (el) {
        return materialHeaderText(el) === label;
      }), label + '\u6392\u5E8F\u5217');
      var down = unique(th.querySelectorAll('[class*="sorter-down"]'), label + '\u964D\u5E8F\u7BAD\u5934');
      await safeClick(down, label + '\u964D\u5E8F\u7BAD\u5934');
    }
    await waitForStableSort(label);
    addLog('\u5DF2\u786E\u8BA4\u201C' + label + '\u964D\u5E8F\u201D\u53CA\u6574\u9875\u6570\u636E\u7A33\u5B9A');
  }

  async function ensurePageSize(size) {
    var lastIssue = '\u7D20\u6750\u8868\u683C\u4ECD\u5728\u52A0\u8F7D';
    var ready = await waitFor(function () {
      try {
        var drawer = context('creative').drawer;
        materialTable(drawer);
        var footer = materialPagination(drawer);
        var input = materialPageSizeInput(footer);
        return { footer: footer, input: input };
      } catch (error) { lastIssue = error.message; return false; }
    }, '\u7D20\u6750\u8868\u683C\u548C\u5206\u9875\u680F\u52A0\u8F7D', 30000).catch(function (error) {
      if (error.message.startsWith('\u7B49\u5F85\u8D85\u65F6\uFF1A')) {
        throw new Error('\u7D20\u6750\u8868\u683C\u548C\u5206\u9875\u680F30\u79D2\u540E\u4ECD\u672A\u5C31\u7EEA\uFF1A' + lastIssue + '\uFF1B\u672A\u52FE\u9009\u6216\u63D0\u4EA4\u7D20\u6750');
      }
      throw error;
    });
    var footer = ready.footer;
    var input = ready.input;
    if (input.value !== size + '\u6761/\u9875') {
      await safeClick(input, '\u6BCF\u9875\u6761\u6570');
      var option = await waitFor(function () {
        return Array.from(document.querySelectorAll('.main-vmok-plugin-select__options .main-vmok-plugin-option__content'))
          .filter(visible).find(function (el) { return exactText(el) === size + '\u6761/\u9875'; });
      }, size + '\u6761/\u9875\u9009\u9879');
      await safeClick(option, size + '\u6761/\u9875\u9009\u9879');
    }
    await waitFor(function () {
      try {
        var drawer = context('creative').drawer;
        var f = materialPagination(drawer);
        var i = materialPageSizeInput(f);
        if (i.value !== size + '\u6761/\u9875') return false;
        var countMatch = exactText(f).match(/\u5171\s*(\d+)\s*\u6761\u8BB0\u5F55/);
        if (!countMatch) return false;
        var currentPage = pageNumber(drawer);
        var expected = Math.min(size, Number(countMatch[1]) - (currentPage - 1) * size);
        var count = materialTable(drawer).body.querySelectorAll('tbody tr').length;
        return expected > 0 && count === expected;
      } catch (_) { return false; }
    }, '\u6BCF\u9875' + size + '\u6761\u53CA\u5BF9\u5E94\u7D20\u6750\u884C\u751F\u6548', 30000);
    addLog('\u6BCF\u9875\u6761\u6570\u5DF2\u8BBE\u7F6E\u4E3A' + size);
  }

  function rowsNow() {
    var drawer = context('creative').drawer;
    if (state.config.planKind !== 'live' && !filterChip(drawer, '\u7D20\u6750\u7C7B\u578B\uFF1A' + FILTER_LABEL)) {
      throw new Error('\u81EA\u9009\u7D20\u6750\u7B5B\u9009\u5DF2\u5931\u6548');
    }
    var table = materialTable(drawer);
    var sortLabel = state.config.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4';
    if (!activeSort(table, sortLabel)) throw new Error('\u7FFB\u9875\u540E\u65E0\u6CD5\u786E\u8BA4' + sortLabel + '\u964D\u5E8F');
    var hi = {
      op: table.headers.indexOf('\u64CD\u4F5C'),
      audit: table.headers.indexOf('\u5BA1\u6838\u72B6\u6001'),
      source: table.headers.indexOf(state.config.planKind === 'live' ? '\u89C6\u9891\u7C7B\u578B' : '\u7D20\u6750\u7C7B\u578B'),
      chasing: table.headers.indexOf('\u7D20\u6750\u8FFD\u6295'),
      date: table.headers.indexOf('\u521B\u5EFA\u65F6\u95F4'),
      roi: table.headers.indexOf('\u7EFC\u5408\u8425\u9500ROI')
    };
    var missingColumns = [];
    if (hi.op < 0) missingColumns.push('\u64CD\u4F5C');
    if (hi.audit < 0) missingColumns.push('\u5BA1\u6838\u72B6\u6001');
    if (hi.date < 0) missingColumns.push('\u521B\u5EFA\u65F6\u95F4');
    if (state.config.planKind === 'live' && hi.source < 0) missingColumns.push('\u89C6\u9891\u7C7B\u578B');
    if (state.config.mode === 'roi' && hi.roi < 0) missingColumns.push('\u7EFC\u5408\u8425\u9500ROI');
    if (missingColumns.length) throw new Error('\u7D20\u6750\u8868\u7F3A\u5C11\u5FC5\u9700\u5217\u201C' + missingColumns.join('\u3001') +
      '\u201D\uFF1B\u5F53\u524D\u8868\u5934\uFF1A' + table.headers.join('\u3001'));
    var seen = new Set();
    var rows = Array.from(table.body.querySelectorAll('tbody tr')).filter(visible).map(function (tr) {
      var cells = Array.from(tr.querySelectorAll(':scope > td'));
      if (cells.length !== table.headers.length) throw new Error('\u7D20\u6750\u884C\u5217\u6570\u4E0E\u8868\u5934\u4E0D\u4E00\u81F4');
      var idMatches = Array.from(exactText(cells[1]).matchAll(/\u7D20\u6750ID[\uFF1A:]\s*(\d+)/g));
      if (!idMatches.length) throw new Error('\u65E0\u6CD5\u8BFB\u53D6\u7D20\u6750 ID');
      var id = idMatches[idMatches.length - 1][1];
      if (seen.has(id)) throw new Error('\u540C\u9875\u51FA\u73B0\u91CD\u590D\u7D20\u6750 ID\uFF1A' + id);
      seen.add(id);
      var roiRaw = hi.roi >= 0 ? exactText(cells[hi.roi]) : '';
      var roi = null;
      if (state.config.mode === 'roi') {
        roi = /^[-\u2014\u2013\/]*$/.test(roiRaw) || roiRaw === '\u6682\u65E0\u6570\u636E' ? null : Number(roiRaw.replace(/,/g, ''));
        if (roi !== null && !Number.isFinite(roi)) roi = null;
      }
      var dateRaw = exactText(cells[hi.date]);
      var dateMatch = dateRaw.match(/\d{4}-\d{2}-\d{2}/);
      if (!dateMatch) throw new Error('\u65E0\u6CD5\u89E3\u6790\u7D20\u6750\u521B\u5EFA\u65E5\u671F\uFF1A' + id);
      var check = cells[0].querySelector('input[type="checkbox"]');
      if (!check) throw new Error('\u627E\u4E0D\u5230\u7D20\u6750\u52FE\u9009\u6846\uFF1A' + id);
      return {
        id: id,
        row: tr,
        check: check,
        source: hi.source < 0 ? SOURCE_LABEL : exactText(cells[hi.source]),
        audit: exactText(cells[hi.audit]),
        chasing: hi.chasing < 0 ? '' : exactText(cells[hi.chasing]),
        operation: exactText(cells[hi.op]),
        date: dateMatch[0],
        roi: roi,
        roiRaw: roiRaw
      };
    });
    if (!rows.length) throw new Error('\u5F53\u524D\u7D20\u6750\u9875\u6CA1\u6709\u53EF\u8BFB\u53D6\u7684\u884C');
    for (var i = 1; i < rows.length; i++) {
      if (state.config.mode === 'date' && rows[i].date > rows[i - 1].date) {
        throw new Error('\u5F53\u524D\u9875\u521B\u5EFA\u65E5\u671F\u4E0D\u662F\u964D\u5E8F');
      }
      if (state.config.mode === 'roi' && rows[i].roi !== null && rows[i - 1].roi !== null &&
          rows[i].roi > rows[i - 1].roi) {
        throw new Error('\u5F53\u524D\u9875\u7EFC\u5408\u8425\u9500 ROI \u4E0D\u662F\u964D\u5E8F');
      }
    }
    return { drawer: drawer, table: table, rows: rows };
  }

  function validateRows(rows) {
    rows.forEach(function (item) {
      if (!eligibleForChase(item)) throw new Error('\u7D20\u6750 ' + item.id + ' \u5F53\u524D\u72B6\u6001\u4E0D\u53EF\u8FFD\u6295\uFF1A\u5BA1\u6838\u201C' +
        item.audit + '\u201D\u3001\u7D20\u6750\u8FFD\u6295\u201C' + item.chasing + '\u201D');
      if (state.config.planKind === 'live') {
        if (!item.source) throw new Error('\u7D20\u6750 ' + item.id + ' \u7684\u89C6\u9891\u7C7B\u578B\u4E3A\u7A7A');
        if (!item.operation.includes('\u8FFD\u6295')) throw new Error('\u7D20\u6750 ' + item.id + ' \u6CA1\u6709\u8FFD\u6295\u5165\u53E3');
      } else if (item.source !== SOURCE_LABEL) throw new Error('\u7D20\u6750 ' + item.id + ' \u4E0D\u662F\u81EA\u9009\u6295\u653E\u7D20\u6750');
    });
  }

  async function waitForProductRowsReady() {
    var lastIssue = '\u7D20\u6750\u884C\u6216\u8FFD\u6295\u5165\u53E3\u4ECD\u5728\u52A0\u8F7D';
    var waitingShown = false;
    function waiting() {
      if (!waitingShown) {
        setPhase('\u7B49\u5F85\u5546\u54C1\u7D20\u6750\u884C\u548C\u8FFD\u6295\u5165\u53E3\u52A0\u8F7D\uFF08\u6700\u591A25\u79D2\uFF09');
        waitingShown = true;
      }
    }
    try {
      return await waitFor(function () {
        assertViewport();
        if (state.stopRequested) throw new Error(state.stopMessage);
        try {
          var bundle = rowsNow();
          var label = state.config.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4';
          if (!sortedPageSignature(label)) {
            lastIssue = label + '\u6392\u5E8F\u6216\u6574\u9875\u7D20\u6750\u5C1A\u672A\u52A0\u8F7D\u5B8C\u6210';
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
      }, '\u5546\u54C1\u7D20\u6750\u884C\u53CA\u8FFD\u6295\u5165\u53E3\u52A0\u8F7D', 25000);
    } catch (error) {
      if (error.message.startsWith('\u7B49\u5F85\u8D85\u65F6\uFF1A')) {
        throw new Error('\u5546\u54C1\u7D20\u6750\u5217\u886825\u79D2\u540E\u4ECD\u672A\u5C31\u7EEA\uFF1A' + lastIssue + '\uFF1B\u672A\u52FE\u9009\u4E0B\u4E00\u7EC4');
      }
      throw error;
    }
  }

  function chaseStatusKnown(item) {
    return /\u672A\u8FFD\u6295|\u8C03\u63A7\u4E2D|\u8C03\u63A7\u7ED3\u675F|\u8FFD\u6295\u7ED3\u675F|\u5DF2\u7ED3\u675F|\u5DF2\u5B8C\u6210|\u5DF2\u8FFD\u6295|\u5DF2\u6682\u505C/.test(item.chasing.replace(/\s+/g, ''));
  }

  async function waitForLiveStatusPage(minStableMs) {
    var stableSignature = '';
    var stableSince = 0;
    var dataLabel = state.config.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4';
    var lastIssue = dataLabel + '\u6216\u7D20\u6750\u8FFD\u6295\u72B6\u6001\u4ECD\u5728\u5237\u65B0';
    setPhase('\u7B49\u5F85\u76F4\u64AD\u7D20\u6750' + dataLabel + '\u4E0E\u201C\u7D20\u6750\u8FFD\u6295\u201D\u72B6\u6001\u5237\u65B0\uFF08\u6700\u591A30\u79D2\uFF09');
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
          lastIssue = '\u5F53\u524D\u9875\u9996\u6761\u53EF\u9009\u7D20\u6750\u7684\u7EFC\u5408\u8425\u9500ROI\u5C1A\u672A\u663E\u793A\u6709\u6548\u6570\u5B57';
          return false;
        }
        var invalidRoiSeen = false;
        for (var i = 0; i < bundle.rows.length; i++) {
          var item = bundle.rows[i];
          if (materialBlocked(item)) continue;
          if (!item.audit || item.audit === '-') {
            stableSignature = '';
            lastIssue = '\u7D20\u6750 ' + item.id + ' \u7684\u5BA1\u6838\u72B6\u6001\u5C1A\u672A\u663E\u793A';
            return false;
          }
          if (state.config.mode === 'roi') {
            if (item.roi === null) invalidRoiSeen = true;
            else if (invalidRoiSeen) {
              stableSignature = '';
              lastIssue = '\u5F53\u524D\u9875 ROI \u6570\u503C\u4E0E\u65E0\u6548\u503C\u4ECD\u5728\u91CD\u65B0\u6392\u5E8F';
              return false;
            }
          }
          if (!chaseStatusKnown(item)) {
            stableSignature = '';
            lastIssue = '\u7D20\u6750 ' + item.id + ' \u7684\u201C\u7D20\u6750\u8FFD\u6295\u201D\u72B6\u6001' +
              (item.chasing ? '\u672A\u8BC6\u522B\uFF1A' + item.chasing : '\u5C1A\u672A\u663E\u793A');
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
      }, '\u76F4\u64AD\u7D20\u6750' + dataLabel + '\u4E0E\u8FFD\u6295\u72B6\u6001\u5237\u65B0\u5B8C\u6210', 30000);
    } catch (error) {
      if (error.message.startsWith('\u7B49\u5F85\u8D85\u65F6\uFF1A')) {
        var notReady = new Error('\u7B49\u5F85\u76F4\u64AD\u7D20\u6750' + dataLabel + '\u4E0E\u8FFD\u6295\u72B6\u600130\u79D2\u540E\u4ECD\u672A\u5C31\u7EEA\uFF1A' + lastIssue + '\uFF1B\u672A\u52FE\u9009\u6216\u63D0\u4EA4\u5F53\u524D\u7EC4');
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
    var lastIssue = '\u7D20\u6750\u884C\u4ECD\u5728\u5237\u65B0';
    setPhase('\u7B49\u5F85\u7B2C' + expectedPage + '\u9875\u7D20\u6750\u8FFD\u6295\u5165\u53E3\u5237\u65B0\uFF08\u6700\u591A15\u79D2\uFF09');
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
          lastIssue = '\u5F53\u524D\u9875\u7801\u5DF2\u53D8\u5316';
          return false;
        }
        var currentPageSignature = bundle.rows.map(function (row) { return row.id; }).join('|');
        if (currentPageSignature !== expectedPageIds.join('|')) {
          stableSignature = '';
          lastIssue = '\u5F53\u524D\u9875\u7D20\u6750\u6216\u987A\u5E8F\u4ECD\u5728\u53D8\u5316';
          if (currentPageSignature !== changedPageSignature) {
            changedPageSignature = currentPageSignature;
            changedPageSince = Date.now();
            return false;
          }
          if (Date.now() - changedPageSince >= 1200) {
            var changed = new Error('\u7B2C' + expectedPage + '\u9875\u7D20\u6750\u987A\u5E8F\u5DF2\u66F4\u65B0\uFF0C\u987B\u91CD\u65B0\u9009\u6750');
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
                !row.operation.includes('\u8FFD\u6295') || !chaseStatusKnown(row)))) {
            stableSignature = '';
            lastIssue = '\u7D20\u6750 ' + ids[i] + ' \u7684\u89C6\u9891\u7C7B\u578B\u3001\u8FFD\u6295\u72B6\u6001\u6216\u8FFD\u6295\u5165\u53E3\u5C1A\u672A\u663E\u793A';
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
      }, '\u76F4\u64AD\u7D20\u6750\u8FFD\u6295\u5165\u53E3\u5237\u65B0\u5B8C\u6210', 15000);
    } catch (error) {
      if (error.message.startsWith('\u7B49\u5F85\u8D85\u65F6\uFF1A')) {
        throw new Error('\u7B2C' + expectedPage + '\u9875\u7B49\u5F85\u8FFD\u6295\u5165\u53E315\u79D2\u540E\u4ECD\u672A\u5C31\u7EEA\uFF1A' + lastIssue + '\uFF1B\u672A\u52FE\u9009\u6216\u63D0\u4EA4\u5F53\u524D\u7EC4');
      }
      throw error;
    }
  }

  function materialBlocked(item) {
    return /\u5BA1\u6838(?:\u4E0D|\u672A)\u901A\u8FC7/.test(item.audit || '') ||
      /\u5DF2\u6682\u505C/.test((item.audit || '') + ' ' + (item.chasing || ''));
  }

  function eligibleForChase(item) {
    // Product eligibility follows ROI/date and source, not the asynchronously refreshed audit cell.
    // The platform modal still verifies exactly which material IDs it accepts.
    if (state.config.planKind !== 'live') return true;
    if (materialBlocked(item)) return false;
    if (!item.audit || item.audit === '-') throw new Error('\u7D20\u6750 ' + item.id + ' \u7684\u5BA1\u6838\u72B6\u6001\u65E0\u6CD5\u786E\u8BA4');
    if (!/\u5BA1\u6838\u901A\u8FC7/.test(item.audit)) return false;
    if (!chaseStatusKnown(item)) throw new Error('\u7D20\u6750 ' + item.id + ' \u7684\u8FFD\u6295\u72B6\u6001\u65E0\u6CD5\u786E\u8BA4');
    return !state.config.skipControlling || !/\u8C03\u63A7\u4E2D|\u6B63\u5728\u8C03\u63A7/.test(item.chasing.replace(/\s+/g, ''));
  }

  function selectedCount(drawer) {
    var match = (drawer.innerText || '').match(/\u5DF2\u9009\s*(\d+)\s*\u4E2A/);
    return match ? Number(match[1]) : 0;
  }

  function assertRowsStillEligible(ids) {
    var latest = rowsNow().rows;
    ids.forEach(function (id) {
      var item = latest.find(function (row) { return row.id === id; });
      var eligible = false;
      try { eligible = !!item && eligibleForChase(item); } catch (_) { /* \u5217\u5237\u65B0\u4E2D\uFF0C\u6309\u72B6\u6001\u53D8\u5316\u91CD\u8BFB */ }
      if (!item || (state.config.planKind === 'live' && !item.operation.includes('\u8FFD\u6295')) ||
          (state.config.planKind === 'live' ? !item.source : item.source !== SOURCE_LABEL) ||
          !eligible) {
        var error = new Error('\u7D20\u6750 ' + id + ' \u7684\u8FFD\u6295\u5165\u53E3\u3001\u5BA1\u6838\u72B6\u6001\u6216\u8C03\u63A7\u72B6\u6001\u5728\u52FE\u9009\u524D\u53D8\u5316');
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
    }, '\u8FD4\u56DE\u672A\u63D0\u4EA4\u7EC4\u7684\u7D20\u6750\u9875', 10000);
    var checked = bundle.rows.filter(function (item) { return item.check.checked; });
    var allowed = new Set(ids);
    if (checked.some(function (item) { return !allowed.has(item.id); })) {
      throw new Error('\u9009\u6750\u65F6\u51FA\u73B0\u672C\u7EC4\u4EE5\u5916\u7684\u52FE\u9009\uFF0C\u7981\u6B62\u7EE7\u7EED');
    }
    if (!checked.length) {
      if (selectedCount(bundle.drawer) !== 0) throw new Error('\u9009\u6750\u6570\u91CF\u4E0E\u52FE\u9009\u6846\u4E0D\u4E00\u81F4\uFF0C\u7981\u6B62\u7EE7\u7EED');
      return;
    }
    for (var i = 0; i < checked.length; i++) {
      await clickMaterialCheckbox(checked[i].id, false, checked.length - i);
    }
    await waitFor(function () {
      var current = rowsNow();
      return selectedCount(current.drawer) === 0 &&
        current.rows.every(function (item) { return !item.check.checked; });
    }, '\u672A\u63D0\u4EA4\u7EC4\u7684\u52FE\u9009\u6E05\u96F6', 10000);
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
          (!item.source || !item.operation.includes('\u8FFD\u6295') || !chaseStatusKnown(item))) return false;
      return { bundle: bundle, item: item };
    }, '\u7D20\u6750 ' + id + ' \u7684\u52FE\u9009\u6846\u3001\u5BA1\u6838\u72B6\u6001\u53CA\u8FFD\u6295\u5165\u53E3\u5C31\u7EEA', shouldCheck && state.config.planKind === 'live' ? 30000 : 10000).catch(function (error) {
      if (shouldCheck && state.config.planKind === 'live' && error.message.startsWith('\u7B49\u5F85\u8D85\u65F6\uFF1A')) {
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
    }, '\u7D20\u6750 ' + id + (shouldCheck ? '\u52FE\u9009' : '\u53D6\u6D88\u52FE\u9009') + '\u751F\u6548', 5000);
  }

  async function selectRows(bundle, chosen, alreadySelected) {
    var rows = bundle.rows;
    validateRows(chosen);
    if (selectedCount(bundle.drawer) !== alreadySelected) {
      throw new Error('\u9009\u4E2D\u7D20\u6750\u6570\u91CF\u4E0E\u811A\u672C\u8BB0\u5F55\u4E0D\u4E00\u81F4');
    }
    if (chosen.length === rows.length && alreadySelected === 0) {
      var headerCheck = materialHeaderCheckbox(bundle.table);
      if (headerCheck.checked) throw new Error('\u8868\u5934\u6B64\u524D\u5DF2\u7ECF\u52FE\u9009');
      await safeClick(headerCheck, '\u7D20\u6750\u8868\u5934\u5168\u9009', false, function () {
        assertRowsStillEligible(chosen.map(function (item) { return item.id; }));
      });
    } else {
      for (var i = 0; i < chosen.length; i++) {
        if (i === 0 || (i + 1) % 5 === 0) {
          setPhase('\u6B63\u5728\u52FE\u9009\u7D20\u6750 ' + (i + 1) + '/' + chosen.length);
        }
        await clickMaterialCheckbox(chosen[i].id, true, alreadySelected + i);
      }
    }
    var wanted = alreadySelected + chosen.length;
    await waitFor(function () {
      return selectedCount(context('creative').drawer) === wanted;
    }, '\u5DF2\u9009' + wanted + '\u6761\u7D20\u6750');
    if (chosen.length === rows.length && alreadySelected === 0) {
      if (rows.some(function (item) { return !item.check.checked; })) {
        throw new Error('\u8868\u5934\u5168\u9009\u540E\u6709\u7D20\u6750\u672A\u52FE\u9009');
      }
    } else {
      var latest = rowsNow().rows;
      if (chosen.some(function (item) {
        var current = latest.find(function (row) { return row.id === item.id; });
        return !current || !current.check.checked;
      })) throw new Error('\u6574\u7EC4\u7D20\u6750\u52FE\u9009\u72B6\u6001\u4E0E\u76EE\u6807 ID \u4E0D\u4E00\u81F4');
    }
  }

  async function clearPreviewSelection() {
    var current = context('creative');
    var drawer = current.drawer;
    var saved = state.previewSelection;
    var count = selectedCount(drawer);
    if (!saved) {
      if (count !== 0) throw new Error('\u9875\u9762\u5B58\u5728\u975E\u672C\u6B21\u6F14\u7EC3\u7684\u9057\u7559\u52FE\u9009\uFF0C\u8BF7\u5148\u624B\u52A8\u53D6\u6D88');
      return;
    }
    if (saved.accountId !== current.accountId || saved.planId !== current.planId) {
      throw new Error('\u6F14\u7EC3\u540E\u8D26\u6237\u6216\u8BA1\u5212\u5DF2\u53D8\u5316\uFF0C\u65E0\u6CD5\u5B89\u5168\u6E05\u9664\u52FE\u9009');
    }
    if (count === 0) {
      state.previewSelection = null;
      return;
    }
    if (pageNumber(drawer) !== saved.page || count !== saved.ids.length) {
      throw new Error('\u6F14\u7EC3\u52FE\u9009\u7684\u9875\u7801\u6216\u6570\u91CF\u5DF2\u53D8\u5316\uFF0C\u8BF7\u624B\u52A8\u6838\u5BF9\u5E76\u53D6\u6D88\u52FE\u9009');
    }
    var table = materialTable(drawer);
    var rows = Array.from(table.body.querySelectorAll('tbody tr')).filter(visible).map(function (tr) {
      var cells = Array.from(tr.querySelectorAll(':scope > td'));
      var match = (exactText(cells[1]).match(/\u7D20\u6750ID[\uFF1A:]\s*(\d+)/g) || []);
      var id = match.length ? (match[match.length - 1].match(/\d+/) || [])[0] : '';
      var check = cells[0] && cells[0].querySelector('input[type="checkbox"]');
      if (!id || !check) throw new Error('\u65E0\u6CD5\u6838\u5BF9\u6F14\u7EC3\u52FE\u9009\u7684\u7D20\u6750\u884C');
      return { id: id, check: check };
    });
    var checked = rows.filter(function (item) { return item.check.checked; });
    if (!sameIds(checked.map(function (item) { return item.id; }), saved.ids)) {
      throw new Error('\u5F53\u524D\u52FE\u9009\u7D20\u6750\u4E0E\u6F14\u7EC3\u8BB0\u5F55\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u624B\u52A8\u6838\u5BF9\u5E76\u53D6\u6D88\u52FE\u9009');
    }
    if (checked.length === rows.length) {
      var headerCheck = materialHeaderCheckbox(table);
      if (!headerCheck.checked) throw new Error('\u8868\u5934\u5168\u9009\u72B6\u6001\u4E0D\u4E00\u81F4\uFF0C\u672A\u6E05\u9664\u6F14\u7EC3\u52FE\u9009');
      await safeClick(headerCheck, '\u53D6\u6D88\u6F14\u7EC3\u8868\u5934\u5168\u9009');
    } else {
      for (var i = 0; i < checked.length; i++) {
        await clickMaterialCheckbox(checked[i].id, false, checked.length - i);
      }
    }
    await waitFor(function () {
      return selectedCount(context('creative').drawer) === 0;
    }, '\u6F14\u7EC3\u52FE\u9009\u5168\u90E8\u6E05\u9664');
    state.previewSelection = null;
    addLog('\u5DF2\u6838\u5BF9\u5E76\u6E05\u9664\u4E0A\u4E00\u8F6E\u6F14\u7EC3\u7684' + saved.ids.length + '\u6761\u52FE\u9009');
  }

  async function previewCurrentPage(retries) {
    var cfg = state.config;
    var bundle = cfg.planKind === 'live' ? await waitForLiveStatusPage() : await waitForProductRowsReady();
    if (selectedCount(bundle.drawer) !== 0) throw new Error('\u5F53\u524D\u9875\u5B58\u5728\u9057\u7559\u52FE\u9009\uFF0C\u6F14\u7EC3\u672A\u7EE7\u7EED');
    var size = cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize;
    var chosen = [];
    var detail = '';
    if (cfg.mode === 'date') {
      var dateRows = bundle.rows.filter(function (item) {
        return item.date >= cfg.startDate && item.date <= cfg.endDate && eligibleForChase(item);
      });
      chosen = dateRows.slice(0, size);
      if (chosen.length < size && chosen.length < cfg.tailMin) {
        detail = '\u672C\u9875\u4EC5\u6709' + chosen.length + '\u6761\u533A\u95F4\u5185\u7D20\u6750\uFF0C\u4E0D\u8DB3\u4E00\u7EC4\u4E14\u4F4E\u4E8E\u5C3E\u7EC4' + cfg.tailMin + '\u6761\u4E0B\u9650\uFF1B\u672A\u52FE\u9009';
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
        detail = '\u672C\u9875 ROI \u51FA\u73B0\u201C\u2014\u201D\uFF0C\u6309\u5F53\u524D\u7B56\u7565\u6682\u505C\uFF1B\u672A\u52FE\u9009';
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
        if ((retries || 0) >= 2) throw new Error('\u6F14\u7EC3\u9009\u6750\u65F6\u8FFD\u6295\u72B6\u6001\u6301\u7EED\u53D8\u5316\uFF0C\u672A\u52FE\u9009\uFF1B\u8BF7\u7A0D\u540E\u91CD\u8BD5');
        addLog('\u6F14\u7EC3\u9009\u6750\u65F6\u6709\u7D20\u6750\u53D8\u4E3A\u8C03\u63A7\u4E2D\u3001\u5DF2\u6682\u505C\u6216\u5BA1\u6838\u4E0D\u901A\u8FC7\uFF0C\u91CD\u65B0\u7B5B\u9009\u5F53\u524D\u9875');
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
      '\u6F14\u7EC3\u5B8C\u6210\uFF1A\u53EA\u68C0\u67E5\u5F53\u524D\u9875\uFF1B\u672A\u6253\u5F00\u8FFD\u6295\u5F39\u7A97\uFF0C\u672A\u63D0\u4EA4\u4EFB\u52A1\u3002',
      '\u8D26\u6237\uFF1A' + cfg.accountName,
      '\u8BA1\u5212\uFF1A' + cfg.planName,
      cfg.mode === 'date' ? '\u521B\u5EFA\u65E5\u671F\u533A\u95F4\uFF1A' + cfg.startDate + ' \u81F3 ' + cfg.endDate + '\uFF08\u542B\u4E24\u7AEF\uFF09' :
        'ROI \u9608\u503C\uFF1A\u2265' + cfg.roiThreshold,
      '\u5F53\u524D\u9875\uFF1A\u7B2C' + pageNumber(bundle.drawer) + '\u9875\uFF1B\u672C\u9875\u7D20\u6750\uFF1A' + bundle.rows.length + '\u6761',
      '\u672C\u9875\u52FE\u9009\uFF1A' + chosen.length + '/' + size + '\u6761' + (chosen.length && chosen.length < size ? '\uFF08\u5F53\u524D\u9875\u4E0D\u8DB3\u8BBE\u5B9A\u7EC4\u6570\uFF09' : ''),
      detail || (chosen.length ? '\u7D20\u6750 ID\uFF1A' + chosen.map(function (item) { return item.id; }).join('\u3001') : '\u5F53\u524D\u9875\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u7D20\u6750'),
      '\u5982\u5F00\u59CB\u6B63\u5F0F\u6267\u884C\uFF0C\u811A\u672C\u4F1A\u5148\u6838\u5BF9\u5E76\u6E05\u9664\u672C\u6B21\u6F14\u7EC3\u52FE\u9009\uFF0C\u7136\u540E\u91CD\u65B0\u9009\u6750\u3002'
    ].join('\n');
    setPhase(chosen.length ? '\u6F14\u7EC3\u5B8C\u6210\uFF1B\u5DF2\u52FE\u9009\u4E00\u7EC4\u793A\u8303\u7D20\u6750\uFF0C\u672A\u63D0\u4EA4' : '\u6F14\u7EC3\u5B8C\u6210\uFF1B\u672C\u9875\u672A\u52FE\u9009\uFF0C\u672A\u63D0\u4EA4');
    addLog('\u6F14\u7EC3\u5F53\u524D\u9875\u52FE\u9009' + chosen.length + '\u6761\uFF1B\u672A\u63D0\u4EA4');
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
      throw new Error('\u8FFD\u6295\u524D\u52FE\u9009\u7D20\u6750\u5DF2\u53D8\u5316\uFF0C\u7981\u6B62\u7EE7\u7EED\u70B9\u51FB');
    }
    validateRows(checked);
  }

  async function openChaseModal(ids) {
    for (var attempt = 1; attempt <= 2; attempt++) {
      var opened = Array.from(document.querySelectorAll('.assist-task-modal')).filter(visible);
      if (opened.length) return unique(opened, '\u8FFD\u6295\u7D20\u6750\u5F39\u7A97');
      assertSelectedGroup(ids);
      var button = await waitFor(function () {
        try { return textMatch(context('creative').drawer, 'button', '\u8FFD\u6295', '\u5DF2\u9009\u7D20\u6750\u5DE5\u5177\u680F\u8FFD\u6295\u6309\u94AE'); }
        catch (_) { return false; }
      }, '\u5DF2\u9009\u7D20\u6750\u5DE5\u5177\u680F\u8FFD\u6295\u6309\u94AE\u52A0\u8F7D', 10000);
      var clicked = false;
      try {
        await safeClick(button, '\u7D20\u6750\u5DE5\u5177\u680F\u8FFD\u6295', false, function () {
          assertSelectedGroup(ids);
          clicked = true;
        });
      } catch (clickError) {
        if (clicked || attempt === 2 || state.stopRequested) throw clickError;
        assertSelectedGroup(ids);
        addLog('\u8FFD\u6295\u5165\u53E3\u5728\u70B9\u51FB\u524D\u53D8\u5316\uFF1B\u5DF2\u590D\u6838\u5F53\u524D\u7EC4\u9009\u6750\uFF0C\u91CD\u8BD5\u6253\u5F00\u4E00\u6B21');
        await sleep(350);
        continue;
      }
      try {
        return await waitFor(function () {
          return Array.from(document.querySelectorAll('.assist-task-modal')).filter(visible)[0];
        }, '\u8FFD\u6295\u7D20\u6750\u5F39\u7A97', 5000);
      } catch (error) {
        if (Array.from(document.querySelectorAll('.assist-task-modal')).some(visible)) throw error;
        if (attempt === 2 || state.stopRequested) throw error;
        assertSelectedGroup(ids);
        addLog('\u8FFD\u6295\u5F39\u7A97\u672A\u6253\u5F00\uFF1B\u5DF2\u590D\u6838\u5F53\u524D\u7EC4\u9009\u6750\uFF0C\u91CD\u8BD5\u6253\u5F00\u4E00\u6B21');
        await sleep(350);
      }
    }
    throw new Error('\u8FFD\u6295\u5F39\u7A97\u672A\u6253\u5F00');
  }

  async function waitForPostSubmitRefresh(before) {
    var started = Date.now();
    var lastSignature = '';
    var stableSince = 0;
    var refreshObserved = false;
    var label = state.config.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4';
    var kind = state.config.planKind === 'live' ? '\u76F4\u64AD' : '\u5546\u54C1';
    setPhase('\u5DF2\u89C1\u64CD\u4F5C\u6210\u529F\uFF1B\u7B49\u5F85' + kind + '\u7D20\u6750\u5217\u8868\u5237\u65B0\u5C31\u7EEA\uFF08\u6700\u591A25\u79D2\uFF09');
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
        throw new Error('\u63D0\u4EA4\u540E\u5343\u5DDD\u81EA\u52A8\u5237\u65B0\u6539\u53D8\u4E86\u7D20\u6750\u9875\u7801\uFF0C\u5DF2\u505C\u6B62\u4EE5\u9632\u6F0F\u9009\u6216\u91CD\u590D\u8FFD\u6295');
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
        addLog(kind + '\u7D20\u6750\u5217\u8868\u5DF2\u91CD\u65B0\u52A0\u8F7D\u4E14\u6570\u636E\u5C31\u7EEA\uFF1B\u7EE7\u7EED\u4E0B\u4E00\u7EC4');
        return;
      }
      await sleep(250);
    }
    throw new Error(kind + '\u8BA1\u5212\u63D0\u4EA4\u6210\u529F\uFF0C\u4F4625\u79D2\u5185\u65E0\u6CD5\u786E\u8BA4\u7D20\u6750\u5217\u8868\u5DF2\u5237\u65B0\u5C31\u7EEA\uFF1B\u5DF2\u505C\u6B62\uFF0C\u7981\u6B62\u76F4\u63A5\u91CD\u63D0\u4E0A\u4E00\u7EC4');
  }

  function taskName(groupNo) {
    var d = new Date();
    var day = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
    return (state.config.planKind === 'live' ? 'QCL_' : 'QC_') + day + '_' + state.config.mode.toUpperCase() + '_' + state.config.planId + '_' +
      String(groupNo).padStart(2, '0') + '_' + Date.now().toString(36);
  }

  function selectedRadio(modal, label) {
    return unique(Array.from(modal.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(function (el) { return exactText(el) === label && visible(el); }), label + '\u9009\u9879');
  }

  async function fillLiveModal(modal, name) {
    var cfg = state.config;
    var cost = selectedRadio(modal, '\u63A7\u6210\u672C\u8FFD\u6295');
    if (!cost.className.includes('--checked')) await safeClick(cost, '\u63A7\u6210\u672C\u8FFD\u6295');
    var goal = selectedRadio(modal, cfg.liveGoal);
    if (!goal.className.includes('--checked')) await safeClick(goal, cfg.liveGoal);
    if (!selectedRadio(modal, '\u63A7\u6210\u672C\u8FFD\u6295').className.includes('--checked') ||
        !selectedRadio(modal, cfg.liveGoal).className.includes('--checked')) {
      throw new Error('\u76F4\u64AD\u8FFD\u6295\u65B9\u5F0F\u6216\u4F18\u5316\u76EE\u6807\u672A\u9009\u4E2D');
    }
    var budget = unique(Array.from(modal.querySelectorAll('input.main-vmok-plugin-input[placeholder="\u8BF7\u8F93\u5165"]')).filter(visible), '\u76F4\u64AD\u8C03\u63A7\u65E5\u9884\u7B97\u8F93\u5165\u6846');
    var bid = cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' ?
      unique(Array.from(modal.querySelectorAll('input.main-vmok-plugin-input[placeholder="\u8BF7\u8F93\u5165\u671F\u671B\u7684\u6210\u4EA4\u6210\u672C"]')).filter(visible), '\u76F4\u64AD\u6211\u7684\u51FA\u4EF7\u8F93\u5165\u6846') :
      unique(Array.from(modal.querySelectorAll('input')).filter(function (el) {
        return visible(el) && /\u7EFC\u5408\u8425\u9500\s*ROI/.test(el.getAttribute('placeholder') || '');
      }), '\u76F4\u64AD\u7EFC\u5408\u8425\u9500ROI\u76EE\u6807\u8F93\u5165\u6846');
    var nameInput = unique(modal.querySelectorAll('input.main-vmok-plugin-input[placeholder="\u8BF7\u8F93\u5165\u4EFB\u52A1\u540D\u79F0\uFF0C1-50\u4E2A\u5B57\u7B26"]'), '\u76F4\u64AD\u4EFB\u52A1\u540D\u79F0\u8F93\u5165\u6846');
    var target = cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' ? cfg.bid : Number(cfg.liveRoiTarget);
    setInputValue(budget, cfg.budget);
    setInputValue(bid, target);
    setInputValue(nameInput, name);
    if (Number(budget.value) !== cfg.budget || Number(bid.value) !== target || nameInput.value !== name) {
      throw new Error('\u76F4\u64AD\u9884\u7B97\u3001\u51FA\u4EF7\u6216\u4EFB\u52A1\u540D\u79F0\u672A\u5199\u5165');
    }
    var audienceButton = textMatch(modal, 'button', '+ \u8BBE\u7F6E\u5B9A\u5411', '\u8BBE\u7F6E\u5B9A\u5411\u6309\u94AE');
    await safeClick(audienceButton, '\u8BBE\u7F6E\u5B9A\u5411');
    var panel = await waitFor(function () {
      return Array.from(modal.querySelectorAll('.panel.drill-content')).filter(visible)[0];
    }, '\u8BBE\u7F6E\u5B9A\u5411\u9762\u677F');
    var genderRow = unique(Array.from(panel.querySelectorAll('.main-vmok-plugin-oc-row-radio'))
      .filter(function (el) { return exactText(el).startsWith('\u6027\u522B '); }), '\u6027\u522B\u5B9A\u5411\u884C');
    var gender = selectedRadio(genderRow, cfg.liveGender);
    if (!gender.className.includes('--checked')) await safeClick(gender, '\u5B9A\u5411\u6027\u522B' + cfg.liveGender);
    if (!selectedRadio(genderRow, cfg.liveGender).className.includes('--checked')) throw new Error('\u6027\u522B' + cfg.liveGender + '\u672A\u9009\u4E2D');
    var confirm = textMatch(panel, 'button', '\u786E\u5B9A', '\u5B9A\u5411\u786E\u5B9A\u6309\u94AE');
    await safeClick(confirm, '\u786E\u5B9A\u6027\u522B' + cfg.liveGender + '\u5B9A\u5411');
    await waitFor(function () { return !visible(panel); }, '\u5B9A\u5411\u9762\u677F\u5173\u95ED');
    return { budgetInput: budget, bidInput: bid, nameInput: nameInput, target: target, goal: cfg.liveGoal, gender: cfg.liveGender,
      genderVerified: true };
  }

  async function submitGroup(items) {
    var cfg = state.config;
    var drawer = context('creative').drawer;
    if (items.length < 1 || items.length > 20) throw new Error('\u5355\u7EC4\u7D20\u6750\u6570\u91CF\u8D8A\u754C');
    if (selectedCount(drawer) !== items.length) throw new Error('\u63D0\u4EA4\u524D\u5DF2\u9009\u6570\u91CF\u4E0D\u5339\u914D');
    var selectedIds = items.map(function (x) { return x.id; });
    var submittedThisRun = new Set();
    state.currentRun.groups.forEach(function (group) {
      if (group.uiSuccess) {
        (group.ids || []).forEach(function (id) { submittedThisRun.add(id); });
        (group.platformSkippedIds || []).forEach(function (id) { submittedThisRun.add(id); });
      }
    });
    var repeated = selectedIds.find(function (id) { return submittedThisRun.has(id); });
    if (repeated) throw new Error('\u7D20\u6750 ' + repeated + ' \u5728\u672C\u8F6E\u5DF2\u663E\u793A\u8FFD\u6295\u6210\u529F\uFF0C\u7981\u6B62\u518D\u6B21\u63D0\u4EA4');
    var modal = await openChaseModal(selectedIds);
    if (!exactText(modal).includes('\u8FFD\u6295\u7D20\u6750')) throw new Error('\u6253\u5F00\u7684\u4E0D\u662F\u8FFD\u6295\u7D20\u6750\u5F39\u7A97');
    var modalSignature = '';
    var modalStableSince = 0;
    var modalAudit = await waitFor(function () {
      var content = exactText(modal);
      var countMatch = content.match(/\u5DF2\u6DFB\u52A0[\uFF1A:]\s*(\d+)\s*\/\s*20/);
      var modalIds = Array.from(content.matchAll(/\u7D20\u6750ID[\uFF1A:]\s*(\d+)/g)).map(function (m) { return m[1]; });
      var filterMatch = content.match(/\u5DF2\u4E3A\u60A8\u8FC7\u6EE4\s*(\d+)\s*\u4E2A\s*\u4E0D\u7B26\u5408\u6761\u4EF6\u7684\u89C6\u9891/);
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
    }, '\u5343\u5DDD\u5F39\u7A97\u5DF2\u63A5\u6536\u7D20\u6750\u6E05\u5355\u7A33\u5B9A', 10000).catch(function (error) {
      var content = exactText(modal);
      var count = (content.match(/\u5DF2\u6DFB\u52A0[\uFF1A:]\s*(\d+)\s*\/\s*20/) || [])[1] || '\u672A\u8BFB\u5230';
      throw new Error('\u52FE\u9009' + selectedIds.length + '\u6761\uFF0C\u5F39\u7A97\u5DF2\u6DFB\u52A0' + count + '\u6761\uFF1B\u672A\u80FD\u6838\u5BF9\u5E73\u53F0\u8FC7\u6EE4\u63D0\u793A\u548C\u7D20\u6750 ID\uFF0C\u672A\u63D0\u4EA4\uFF1A' + error.message);
    });
    var acceptedIds = modalAudit.acceptedIds;
    var skippedIds = modalAudit.skippedIds;
    if (skippedIds.length) addLog('\u5343\u5DDD\u660E\u786E\u8FC7\u6EE4' + skippedIds.length + '\u6761\u4E0D\u7B26\u5408\u6761\u4EF6\u7D20\u6750\uFF1A' + skippedIds.join('\u3001') + '\uFF1B\u672C\u7EC4\u6309\u5F39\u7A97\u5B9E\u9645\u63A5\u6536\u7684' + acceptedIds.length + '\u6761\u63D0\u4EA4');
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
      throw new Error('\u5343\u5DDD\u8FC7\u6EE4\u540E\u7D20\u6750\u8868\u52FE\u9009\u4E0E\u8FFD\u6295\u5F39\u7A97\u4E0D\u4E00\u81F4\uFF0C\u7981\u6B62\u63D0\u4EA4');
    }
    var name = taskName(state.currentRun.groups.length + 1);
    var budgetInput, hoursInput, nameInput, liveFields;
    if (cfg.planKind === 'live') {
      liveFields = await fillLiveModal(modal, name);
      budgetInput = liveFields.budgetInput;
      nameInput = liveFields.nameInput;
    } else {
      budgetInput = unique(Array.from(modal.querySelectorAll('input[placeholder="\u8BF7\u8F93\u5165"]'))
        .filter(function (el) { return !el.hasAttribute('min'); }), '\u8C03\u63A7\u9884\u7B97\u8F93\u5165\u6846');
      hoursInput = unique(modal.querySelectorAll('input[min="0.5"][max="24"]'), '\u8C03\u63A7\u65F6\u957F\u8F93\u5165\u6846');
      nameInput = unique(modal.querySelectorAll('input[placeholder="\u8BF7\u8F93\u5165\u4EFB\u52A1\u540D\u79F0\uFF0C1-50\u4E2A\u5B57\u7B26"]'), '\u4EFB\u52A1\u540D\u79F0\u8F93\u5165\u6846');
      setInputValue(budgetInput, cfg.budget);
      setInputValue(hoursInput, cfg.hours);
      setInputValue(nameInput, name);
    }
    if (!Number.isInteger(cfg.budget) || cfg.budget < MIN_BUDGET || cfg.budget > MAX_BUDGET || (hoursInput && cfg.hours > MAX_HOURS)) throw new Error('\u53C2\u6570\u8D85\u8FC7\u811A\u672C\u5B89\u5168\u4E0A\u9650');
    context('creative');
    var submit = cfg.planKind === 'live' ?
      unique(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
        .filter(function (el) { return exactText(el) === '\u63D0\u4EA4'; }), '\u76F4\u64AD\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4\u6309\u94AE') :
      textMatch(modal, 'button', '\u63D0\u4EA4', '\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4\u6309\u94AE');
    function formReady(button) {
      if (!visible(modal) || !visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      if (!budgetInput.isConnected || !nameInput.isConnected || (hoursInput && !hoursInput.isConnected)) return false;
      if (Number(budgetInput.value) !== cfg.budget ||
          (hoursInput && Number(hoursInput.value) !== cfg.hours) || nameInput.value !== name) return false;
      var currentIds = Array.from(exactText(modal).matchAll(/\u7D20\u6750ID[\uFF1A:]\s*(\d+)/g))
        .map(function (match) { return match[1]; });
      if (!sameIds(currentIds, acceptedIds)) return false;
      if (cfg.planKind === 'live' && (Number(liveFields.bidInput.value) !== liveFields.target ||
          !selectedRadio(modal, '\u63A7\u6210\u672C\u8FFD\u6295').className.includes('--checked') ||
          !selectedRadio(modal, cfg.liveGoal).className.includes('--checked') ||
          liveFields.gender !== cfg.liveGender || !liveFields.genderVerified)) return false;
      return true;
    }
    var stableSince = 0;
    await waitFor(function () {
      if (!formReady(submit)) { stableSince = 0; return false; }
      if (!stableSince) stableSince = Date.now();
      return Date.now() - stableSince >= 700;
    }, '\u8FFD\u6295\u5F39\u7A97\u53C2\u6570\u548C\u63D0\u4EA4\u6309\u94AE\u7A33\u5B9A', 6000);
    assertModalSelection();
    var record = {
      name: name,
      ids: acceptedIds,
      count: acceptedIds.length,
      platformSkippedIds: skippedIds,
      budget: cfg.budget,
      hours: cfg.planKind === 'live' ? null : cfg.hours,
      bid: cfg.planKind === 'live' && cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' ? cfg.bid : null,
      liveRoiTarget: cfg.planKind === 'live' && cfg.liveGoal === '\u7EFC\u5408\u8425\u9500ROI' ? Number(cfg.liveRoiTarget) : null,
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
    if (!materialBefore.firstRow) throw new Error('\u63D0\u4EA4\u524D\u7D20\u6750\u5217\u8868\u672A\u5C31\u7EEA');
    state.currentRun.groups.push(record);
    saveJournal();
    addLog('\u7B2C' + state.currentRun.groups.length + '\u7EC4\uFF1A\u52FE\u9009' + items.length + '\u6761\uFF0C\u5F39\u7A97\u63A5\u6536' + acceptedIds.length + '\u6761\uFF0C\u4EFB\u52A1\u540D ' + name);
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
      }, '\u201C\u64CD\u4F5C\u6210\u529F\u201D\u63D0\u793A\u53CA\u5F39\u7A97\u5173\u95ED', 30000);
    }
    var clicked = false;
    try {
      if (state.stopRequested) {
        state.currentRun.groups.pop();
        saveJournal();
        throw new Error(state.stopMessage + '\uFF0C\u5F53\u524D\u7EC4\u672A\u63D0\u4EA4');
      }
      if (cfg.planKind === 'live' && (Number(liveFields.bidInput.value) !== liveFields.target ||
          !selectedRadio(modal, '\u63A7\u6210\u672C\u8FFD\u6295').className.includes('--checked') ||
          !selectedRadio(modal, cfg.liveGoal).className.includes('--checked') ||
          liveFields.gender !== cfg.liveGender || !liveFields.genderVerified)) {
        throw new Error('\u76F4\u64AD\u8FFD\u6295\u53C2\u6570\u63D0\u4EA4\u524D\u590D\u6838\u5931\u8D25');
      }
      try {
        await safeClick(submit, '\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4', false, function () {
          if (!formReady(submit)) throw new Error('\u63D0\u4EA4\u524D\u5F39\u7A97\u53C2\u6570\u6216\u6309\u94AE\u5DF2\u53D8\u5316');
          clicked = true;
        });
      } catch (clickError) {
        if (clicked || state.stopRequested) throw clickError;
        assertModalSelection();
        var freshSubmit = cfg.planKind === 'live' ?
          unique(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
            .filter(function (el) { return exactText(el) === '\u63D0\u4EA4'; }), '\u76F4\u64AD\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4\u6309\u94AE') :
          textMatch(modal, 'button', '\u63D0\u4EA4', '\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4\u6309\u94AE');
        if (!formReady(freshSubmit)) throw clickError;
        addLog('\u63D0\u4EA4\u6309\u94AE\u5728\u70B9\u51FB\u524D\u53D8\u5316\uFF1B\u5DF2\u590D\u6838\u53C2\u6570\u4E14\u9996\u6B21\u672A\u70B9\u51FB\uFF0C\u91CD\u8BD5\u70B9\u51FB\u4E00\u6B21');
        await safeClick(freshSubmit, '\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4', false, function () {
          if (!formReady(freshSubmit)) throw new Error('\u91CD\u8BD5\u524D\u5F39\u7A97\u53C2\u6570\u6216\u6309\u94AE\u5DF2\u53D8\u5316');
          clicked = true;
        });
      }
      var outcome = await waitSubmitOutcome(0);
      if (outcome.kind === 'failure') {
        if (!RETRYABLE_FAILURE_RE.test(outcome.output)) {
          throw new Error('\u5343\u5DDD\u63D0\u793A\u8BF7\u6C42\u5F02\u5E38\uFF0C\u4F46\u672A\u660E\u786E\u63D0\u4EA4\u5931\u8D25\uFF1B\u7981\u6B62\u81EA\u52A8\u91CD\u8BD5');
        }
        var retryStableSince = 0;
        var retryState = await waitFor(function () {
          assertViewport();
          if (state.stopRequested) throw new Error(state.stopMessage);
          if (SUCCESS_RE.test(messages.join(' ')) && !visible(modal)) return { lateSuccess: true };
          if (SUCCESS_RE.test(messages.join(' '))) throw new Error('\u66FE\u51FA\u73B0\u6210\u529F\u63D0\u793A\uFF0C\u7981\u6B62\u518D\u6B21\u63D0\u4EA4');
          if (!visible(modal)) throw new Error('\u8FFD\u6295\u5F39\u7A97\u5DF2\u5173\u95ED\uFF0C\u4E0D\u80FD\u786E\u8BA4\u9996\u6B21\u63D0\u4EA4\u5931\u8D25');
          assertModalSelection();
          var fresh = cfg.planKind === 'live' ?
            unique(Array.from(modal.querySelectorAll('button.main-vmok-plugin-button'))
              .filter(function (el) { return exactText(el) === '\u63D0\u4EA4'; }), '\u76F4\u64AD\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4\u6309\u94AE') :
            textMatch(modal, 'button', '\u63D0\u4EA4', '\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4\u6309\u94AE');
          if (!formReady(fresh)) { retryStableSince = 0; return false; }
          if (!retryStableSince) retryStableSince = Date.now();
          return Date.now() - retryStableSince >= 700 ? { button: fresh } : false;
        }, '\u660E\u786E\u5931\u8D25\u540E\u7684\u540C\u4E00\u8FFD\u6295\u5F39\u7A97\u548C\u53C2\u6570\u7A33\u5B9A', 6000);
        if (retryState.lateSuccess) {
          addLog('\u7B2C' + state.currentRun.groups.length + '\u7EC4\uFF1A\u5931\u8D25\u63D0\u793A\u540E\u9875\u9762\u53C8\u663E\u793A\u6210\u529F\uFF0C\u672A\u518D\u6B21\u63D0\u4EA4');
        } else {
          var retryFrom = messages.length;
          record.retryReason = '\u5343\u5DDD\u660E\u786E\u63D0\u793A\u63D0\u4EA4\u5931\u8D25\u4E14\u5F39\u7A97\u3001\u7D20\u6750\u548C\u53C2\u6570\u672A\u53D8\u5316';
          addLog('\u7B2C' + state.currentRun.groups.length + '\u7EC4\uFF1A\u5343\u5DDD\u660E\u786E\u63D0\u793A\u5931\u8D25\uFF1B\u5DF2\u590D\u6838\u539F\u5F39\u7A97\u548C\u53C2\u6570\uFF0C\u4EC5\u91CD\u8BD5\u63D0\u4EA4\u4E00\u6B21');
          await safeClick(retryState.button, '\u8FFD\u6295\u5F39\u7A97\u63D0\u4EA4\uFF08\u5931\u8D25\u540E\u552F\u4E00\u4E00\u6B21\u91CD\u8BD5\uFF09', false, function () {
            if (SUCCESS_RE.test(messages.join(' '))) throw new Error('\u91CD\u8BD5\u524D\u51FA\u73B0\u6210\u529F\u63D0\u793A\uFF0C\u7981\u6B62\u518D\u6B21\u63D0\u4EA4');
            if (!formReady(retryState.button)) throw new Error('\u91CD\u8BD5\u524D\u5F39\u7A97\u53C2\u6570\u6216\u6309\u94AE\u5DF2\u53D8\u5316');
            assertModalSelection();
            record.submitAttempts = 2;
            saveJournal();
          });
          outcome = await waitSubmitOutcome(retryFrom);
          if (outcome.kind !== 'success') throw new Error('\u5343\u5DDD\u518D\u6B21\u63D0\u793A\u63D0\u4EA4\u5931\u8D25\uFF1B\u5DF2\u7528\u5B8C\u4E00\u6B21\u81EA\u52A8\u91CD\u8BD5');
        }
      }
      record.uiSuccess = true;
      record.status = 'ui_success';
      saveJournal();
      addLog('\u7B2C' + state.currentRun.groups.length + '\u7EC4\uFF1A\u9875\u9762\u663E\u793A\u64CD\u4F5C\u6210\u529F');
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
      throw new Error('\u7B2C' + state.currentRun.groups.length + '\u7EC4\u63D0\u4EA4\u7ED3\u679C\u4E0D\u660E\u786E\uFF0C\u7981\u6B62\u91CD\u8BD5\uFF1A' + error.message);
    } finally { observer.disconnect(); }
    if (record.uiSuccess) await waitForPostSubmitRefresh(materialBefore);
  }

  async function clearSubmittedSelection(items, expectedPage, platformSkippedIds) {
    var bundle = await waitFor(function () {
      try {
        var current = rowsNow();
        return pageNumber(current.drawer) === expectedPage ? current : false;
      } catch (_) { return false; }
    }, '\u63D0\u4EA4\u540E\u8FD4\u56DE\u539F\u7D20\u6750\u9875', 10000);
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
      throw new Error('\u63D0\u4EA4\u540E\u9057\u7559\u52FE\u9009\u4E0E\u4E0A\u4E00\u7EC4\u7D20\u6750\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u505C\u6B62\u540E\u7EED\u8FFD\u6295');
    }
    if (checked.length === bundle.rows.length) {
      var headerCheck = materialHeaderCheckbox(bundle.table);
      if (!headerCheck.checked) throw new Error('\u63D0\u4EA4\u540E\u8868\u5934\u52FE\u9009\u72B6\u6001\u4E0D\u4E00\u81F4');
      await safeClick(headerCheck, '\u53D6\u6D88\u4E0A\u4E00\u7EC4\u8868\u5934\u5168\u9009');
    } else {
      for (var i = 0; i < checked.length; i++) {
        await clickMaterialCheckbox(checked[i].id, false, checked.length - i);
      }
    }
    await waitFor(function () {
      var current = rowsNow();
      return selectedCount(current.drawer) === 0 &&
        current.rows.every(function (item) { return !item.check.checked; });
    }, '\u4E0A\u4E00\u7EC4\u7D20\u6750\u52FE\u9009\u5168\u90E8\u6E05\u9664', 10000);
    addLog('\u5DF2\u6838\u5BF9\u5E76\u53D6\u6D88\u4E0A\u4E00\u7EC4\u6B8B\u7559\u52FE\u9009\uFF0C\u7EE7\u7EED\u4E0B\u4E00\u7EC4');
  }

  function pageNumber(drawer) {
    var footer = materialPagination(drawer);
    var active = unique(footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '\u5F53\u524D\u9875\u7801');
    var number = Number(exactText(active));
    if (!Number.isInteger(number) || number < 1) throw new Error('\u65E0\u6CD5\u8BFB\u53D6\u5F53\u524D\u9875\u7801');
    return number;
  }

  async function nextPage() {
    var drawer = context('creative').drawer;
    var footer = materialPagination(drawer);
    var oldPage = pageNumber(drawer);
    var oldRows = rowsNow().rows;
    var oldIds = oldRows.map(function (item) { return item.id; }).join('|');
    var boundary = oldRows[oldRows.length - 1];
    var next = unique(Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
      .filter(function (el) { return !!el.querySelector('.main-vmok-plugin-page-turner__next-icon'); }), '\u4E0B\u4E00\u9875\u6309\u94AE');
    if (next.className.includes('disabled') || next.getAttribute('aria-disabled') === 'true') return false;
    if (selectedCount(context('creative').drawer) !== 0) throw new Error('\u7FFB\u9875\u524D\u4ECD\u6709\u672A\u63D0\u4EA4\u52FE\u9009\uFF0C\u5DF2\u963B\u6B62\u7FFB\u9875\u4EE5\u514D\u4E22\u5931\u7D20\u6750');
    await safeClick(next, '\u4E0B\u4E00\u9875');
    await waitFor(function () {
      return pageNumber(context('creative').drawer) === oldPage + 1;
    }, '\u7FFB\u5230\u7B2C' + (oldPage + 1) + '\u9875', 10000);
    await waitFor(function () {
      var table = materialTable(context('creative').drawer);
      var ids = Array.from(table.body.querySelectorAll('tbody tr')).map(function (tr) {
        return (exactText(tr).match(/\u7D20\u6750ID[\uFF1A:]\s*(\d+)/) || [])[1] || '';
      }).join('|');
      return ids && ids !== oldIds;
    }, '\u4E0B\u4E00\u9875\u7D20\u6750\u6570\u636E\u66F4\u65B0', 10000);
    var label = state.config.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4';
    if (state.config.planKind === 'live') await waitForLiveStatusPage();
    await waitForStableSort(label);
    var first = rowsNow().rows[0];
    if (state.config.mode === 'date' && first.date > boundary.date) {
      throw new Error('\u7FFB\u9875\u540E\u521B\u5EFA\u65E5\u671F\u6B21\u5E8F\u5012\u9000');
    }
    if (state.config.mode === 'roi' && first.roi !== null && boundary.roi !== null && first.roi > boundary.roi) {
      throw new Error('\u7FFB\u9875\u540E ROI \u6B21\u5E8F\u5012\u9000');
    }
    addLog('\u5DF2\u7FFB\u5230\u7B2C' + (oldPage + 1) + '\u9875\uFF0C\u5E76\u786E\u8BA4' + label +
      (state.config.planKind === 'live' ? '\u3001\u7D20\u6750\u8FFD\u6295\u72B6\u6001' : '') + '\u53CA\u964D\u5E8F\u6570\u636E\u5DF2\u5237\u65B0');
    return true;
  }

  function roiPageSize() {
    if (state.config.planKind === 'live') return 100;
    return state.config.roiGroupSize <= 10 ? 10 : 20;
  }

  function hasNextPage(drawer) {
    var footer = materialPagination(drawer);
    var next = unique(Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
      .filter(function (el) { return !!el.querySelector('.main-vmok-plugin-page-turner__next-icon'); }), '\u4E0B\u4E00\u9875\u6309\u94AE');
    return !next.className.includes('disabled') && next.getAttribute('aria-disabled') !== 'true';
  }

  async function auditAndRefillLiveGroup(initialIds, targetCount, expectedPage, expectedPageIds,
    submittedIds, attemptIds) {
    var cfg = state.config;
    var excluded = new Set();
    var cursor = Math.max.apply(null, initialIds.map(function (id) { return expectedPageIds.indexOf(id); }));
    var expectedSignature = expectedPageIds.join('|');
    for (var round = 1; round <= Math.max(6, targetCount + 2); round++) {
      setPhase('\u7B2C' + expectedPage + '\u9875\u63D0\u4EA4\u524D\u590D\u6838\u5BA1\u6838\u72B6\u6001\u4E0E\u5DF2\u9009\u7D20\u6750\uFF08\u7B2C' + round + '\u6B21\uFF09');
      var bundle = await waitForLiveStatusPage(1800);
      if (pageNumber(bundle.drawer) !== expectedPage ||
          bundle.rows.map(function (item) { return item.id; }).join('|') !== expectedSignature) {
        var reordered = new Error('\u63D0\u4EA4\u524D\u7D20\u6750\u9875\u7801\u6216\u987A\u5E8F\u53D8\u5316\uFF0C\u987B\u91CD\u65B0\u9009\u6750');
        reordered.code = 'LIVE_PAGE_REORDERED';
        throw reordered;
      }
      var checked = bundle.rows.filter(function (item) { return item.check.checked; });
      if (selectedCount(bundle.drawer) !== checked.length ||
          checked.some(function (item) { return !attemptIds.has(item.id); })) {
        throw new Error('\u63D0\u4EA4\u524D\u52FE\u9009\u6570\u91CF\u6216\u7D20\u6750 ID \u4E0E\u672C\u7EC4\u4E0D\u4E00\u81F4\uFF0C\u7981\u6B62\u63D0\u4EA4');
      }
      var invalid = checked.filter(function (item) {
        return !eligibleForChase(item) || !item.source || !item.operation.includes('\u8FFD\u6295') ||
          (cfg.mode === 'roi' ? item.roi === null || item.roi < cfg.roiThreshold :
            item.date < cfg.startDate || item.date > cfg.endDate);
      });
      for (var i = 0; i < invalid.length; i++) {
        var bad = invalid[i];
        excluded.add(bad.id);
        await clickMaterialCheckbox(bad.id, false, checked.length - i);
        addLog('\u63D0\u4EA4\u524D\u590D\u6838\uFF1A\u7D20\u6750 ' + bad.id + ' \u5BA1\u6838\u201C' + bad.audit + '\u201D\u3001\u8FFD\u6295\u201C' +
          bad.chasing + '\u201D\uFF0C\u5DF2\u53D6\u6D88\u52FE\u9009\u5E76\u5BFB\u627E\u540E\u7EED\u8FBE\u6807\u7D20\u6750');
      }
      var current = rowsNow();
      var chosen = current.rows.filter(function (item) { return item.check.checked; });
      if (selectedCount(current.drawer) !== chosen.length) {
        throw new Error('\u590D\u6838\u53D6\u6D88\u52FE\u9009\u540E\u6570\u91CF\u672A\u540C\u6B65\uFF0C\u7981\u6B62\u63D0\u4EA4');
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
        if (!candidate.source || !candidate.operation.includes('\u8FFD\u6295')) continue;
        replacements.push(candidate);
      }
      if (replacements.length) {
        replacements.forEach(function (item) { attemptIds.add(item.id); });
        addLog('\u63D0\u4EA4\u524D\u590D\u6838\uFF1A\u4ECE\u540E\u7EED\u7D20\u6750\u8865\u9009' + replacements.length + '\u6761\uFF0C\u91CD\u65B0\u6838\u5BF9\u6574\u7EC4');
        await selectRows(current, replacements, chosen.length);
        continue;
      }
      if (invalid.length) continue;
      validateRows(chosen);
      return chosen;
    }
    var unstable = new Error('\u63D0\u4EA4\u524D\u7D20\u6750\u5BA1\u6838\u6216\u8FFD\u6295\u72B6\u6001\u53CD\u590D\u53D8\u5316\uFF0C\u5DF2\u505C\u6B62\u672C\u7EC4\u63D0\u4EA4');
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
      if (++pageSteps > 300) throw new Error('\u8D85\u8FC7300\u6B21\u76F4\u64AD\u7D20\u6750\u9875\u626B\u63CF\uFF0C\u5DF2\u505C\u6B62');
      var bundle = await waitForLiveStatusPage();
      var page = pageNumber(bundle.drawer);
      if (bundle.rows.length > 100) throw new Error('\u5F53\u524D\u76F4\u64AD\u7D20\u6750\u9875\u8D85\u8FC7100\u6761');
      if (selectedCount(bundle.drawer) !== 0) throw new Error('\u5F53\u524D\u9875\u5B58\u5728\u672A\u6E05\u9664\u7684\u52FE\u9009\uFF0C\u7981\u6B62\u7EE7\u7EED');
      var pageIds = bundle.rows.map(function (item) { return item.id; });
      var eligibleIds = [];
      var boundary = '';
      for (var i = 0; i < bundle.rows.length; i++) {
        var item = bundle.rows[i];
        if (!eligibleForChase(item)) continue;
        if (cfg.mode === 'roi') {
          if (item.roi === null) { boundary = 'ROI \u65E0\u6548'; break; }
          if (item.roi < cfg.roiThreshold) { boundary = 'ROI\uFF1C' + cfg.roiThreshold; break; }
        } else {
          if (item.date < cfg.startDate) { boundary = '\u521B\u5EFA\u65F6\u95F4\u65E9\u4E8E' + cfg.startDate; break; }
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
            throw new Error('\u7D20\u6750\u9875\u987A\u5E8F\u53D8\u5316\u65F6\u5B58\u5728\u672A\u6E05\u9664\u52FE\u9009\uFF0C\u7981\u6B62\u91CD\u65B0\u9009\u6750');
          }
          if (++pageRebases > 5) throw new Error('\u7B2C' + page + '\u9875\u7D20\u6750\u987A\u5E8F\u53CD\u590D\u53D8\u5316\uFF0C\u5DF2\u505C\u6B62\u4EE5\u9632\u91CD\u590D\u8FFD\u6295');
          addLog('\u7B2C' + page + '\u9875\u7D20\u6750\u987A\u5E8F\u5DF2\u66F4\u65B0\uFF1B\u6392\u9664\u5DF2\u63D0\u4EA4\u7D20\u6750\u540E\u91CD\u65B0\u9009\u6750\uFF08' + pageRebases + '/5\uFF09');
          restartPage = true;
          break;
        }
        var fresh = ready.bundle;
        if (selectedCount(fresh.drawer) !== 0) throw new Error('\u4E0A\u4E00\u7EC4\u52FE\u9009\u672A\u6E05\u9664\uFF0C\u7981\u6B62\u7EE7\u7EED');
        var chosen = ready.chosen;
        var newlyBlocked;
        try {
          newlyBlocked = chosen.filter(function (item) { return !eligibleForChase(item); });
        } catch (error) {
          addLog('\u7B2C' + page + '\u9875\u5BA1\u6838\u72B6\u6001\u77ED\u6682\u672A\u663E\u793A\uFF0C\u7B49\u5F85\u5217\u8868\u91CD\u65B0\u7A33\u5B9A\u540E\u9009\u6750');
          await waitForLiveStatusPage();
          restartPage = true;
          break;
        }
        if (newlyBlocked.length) {
          var skipIds = new Set(newlyBlocked.map(function (item) { return item.id; }));
          eligibleIds = eligibleIds.filter(function (id) { return !skipIds.has(id); });
          addLog('\u7B2C' + page + '\u9875\u65B0\u51FA\u73B0\u8C03\u63A7\u4E2D\u3001\u5DF2\u6682\u505C\u6216\u5BA1\u6838\u672A\u901A\u8FC7\u7D20\u6750' + newlyBlocked.length + '\u6761\uFF0C\u5DF2\u8DF3\u8FC7\u5E76\u91CD\u65B0\u51D1\u7EC4');
          continue;
        }
        chosen.forEach(function (item) {
          if (cfg.mode === 'roi' && (item.roi === null || item.roi < cfg.roiThreshold)) {
            throw new Error('\u5F85\u8FFD\u6295\u7D20\u6750 ROI \u5DF2\u53D8\u5316\uFF1A' + item.id);
          }
          if (cfg.mode === 'date' && (item.date < cfg.startDate || item.date > cfg.endDate)) {
            throw new Error('\u5F85\u8FFD\u6295\u7D20\u6750\u521B\u5EFA\u65E5\u671F\u5DF2\u53D8\u5316\uFF1A' + item.id);
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
            throw new Error('\u63D0\u4EA4\u524D\u590D\u6838\u4E2D\u65AD\uFF0C\u4E14\u65E0\u6CD5\u786E\u8BA4\u672C\u7EC4\u52FE\u9009\u5DF2\u6E05\u9664\uFF1A' + clearError.message +
              '\uFF1B\u539F\u56E0\u4E3A\uFF1A' + error.message);
          }
          if (error.code === 'LIVE_PAGE_REORDERED') {
            if (++pageRebases > 5) throw new Error('\u7B2C' + page + '\u9875\u7D20\u6750\u987A\u5E8F\u53CD\u590D\u53D8\u5316\uFF0C\u5DF2\u505C\u6B62\u4EE5\u9632\u91CD\u590D\u8FFD\u6295');
            addLog('\u63D0\u4EA4\u524D\u7D20\u6750\u9875\u987A\u5E8F\u53D8\u5316\uFF1B\u672C\u7EC4\u52FE\u9009\u5DF2\u6E05\u9664\uFF0C\u91CD\u65B0\u8BFB\u53D6\u5F53\u524D\u9875\uFF08' + pageRebases + '/5\uFF09');
            restartPage = true;
            break;
          }
          if (error.code !== 'LIVE_SELECTION_CHANGED') throw error;
          if (++selectionRetries > 5) throw new Error('\u7B2C' + page + '\u9875\u7D20\u6750\u8C03\u63A7\u72B6\u6001\u53CD\u590D\u53D8\u5316\uFF0C\u5DF2\u6E05\u9664\u672A\u63D0\u4EA4\u52FE\u9009\u5E76\u505C\u6B62');
          var refreshed = await waitForLiveStatusPage();
          if (pageNumber(refreshed.drawer) !== page) {
            throw new Error('\u91CD\u9009\u65F6\u5F53\u524D\u9875\u7801\u53D8\u5316\uFF0C\u5DF2\u505C\u6B62\u4EE5\u9632\u91CD\u590D\u8FFD\u6295');
          }
          if (refreshed.rows.map(function (item) { return item.id; }).join('|') !== pageIds.join('|')) {
            if (selectedCount(refreshed.drawer) !== 0) {
              throw new Error('\u91CD\u9009\u65F6\u7D20\u6750\u987A\u5E8F\u53D8\u5316\u4E14\u4ECD\u6709\u52FE\u9009\uFF0C\u7981\u6B62\u7EE7\u7EED');
            }
            if (++pageRebases > 5) {
              throw new Error('\u7B2C' + page + '\u9875\u91CD\u9009\u65F6\u7D20\u6750\u987A\u5E8F\u53CD\u590D\u53D8\u5316\uFF0C\u5DF2\u505C\u6B62\u4EE5\u9632\u91CD\u590D\u8FFD\u6295');
            }
            addLog('\u7B2C' + page + '\u9875\u7D20\u6750\u8C03\u63A7\u72B6\u6001\u53CA\u987A\u5E8F\u53D8\u5316\uFF1B\u672A\u63D0\u4EA4\u7EC4\u52FE\u9009\u5DF2\u6E05\u9664\uFF0C\u91CD\u65B0\u8BFB\u53D6\u5F53\u524D\u9875\uFF08' + pageRebases + '/5\uFF09');
            restartPage = true;
            break;
          }
          var remaining = eligibleIds.slice(offset).filter(function (id) {
            var latest = refreshed.rows.find(function (item) { return item.id === id; });
            if (!latest) throw new Error('\u91CD\u9009\u65F6\u7D20\u6750\u5DF2\u6D88\u5931\uFF1A' + id);
            if (cfg.mode === 'roi' && (latest.roi === null || latest.roi < cfg.roiThreshold)) {
              throw new Error('\u91CD\u9009\u65F6\u7D20\u6750 ROI \u5DF2\u53D8\u5316\uFF1A' + id);
            }
            if (cfg.mode === 'date' && (latest.date < cfg.startDate || latest.date > cfg.endDate)) {
              throw new Error('\u91CD\u9009\u65F6\u7D20\u6750\u521B\u5EFA\u65E5\u671F\u5DF2\u53D8\u5316\uFF1A' + id);
            }
            return eligibleForChase(latest);
          });
          eligibleIds = eligibleIds.slice(0, offset).concat(remaining);
          addLog('\u7B2C' + page + '\u9875\u52FE\u9009\u524D\u72B6\u6001\u53D8\u5316\uFF1B\u5DF2\u6E05\u9664\u672A\u63D0\u4EA4\u52FE\u9009\u5E76\u8DF3\u8FC7\u4E0D\u53EF\u9009\u7D20\u6750\uFF0C\u91CD\u65B0\u51D1\u7EC4');
          continue;
        }
        selectionRetries = 0;
        if (chosen.length === 0 ||
            (chosen.length < cfg.tailMin && !(chosen.length < size && !boundary && nextExists))) {
          await clearAttemptSelection(Array.from(attemptIds), page);
          return '\u7B2C' + page + '\u9875\u63D0\u4EA4\u524D\u590D\u6838\u540E\u4EC5\u5269' + chosen.length +
            '\u6761\u8FBE\u6807\u7D20\u6750\uFF0C\u672A\u8FBE\u5230\u672C\u9875\u63D0\u4EA4\u6761\u4EF6\uFF0C\u5DF2\u6E05\u9664\u52FE\u9009\u5E76\u505C\u6B62';
        }
        var actualIds = chosen.map(function (item) { return item.id; });
        pageRemainder = chosen.length < size && !boundary && nextExists;
        await submitGroup(chosen);
        actualIds.forEach(function (id) { submittedIds.add(id); });
        offset += chosen.length;
        if (pageRemainder) addLog('\u7B2C' + page + '\u9875\u7FFB\u9875\u524D\u4F59\u91CF' + chosen.length + '\u6761\u5DF2\u5355\u72EC\u63D0\u4EA4\uFF1B\u4E0B\u4E00\u9875\u6062\u590D\u6BCF\u7EC4' + size + '\u6761');
        await clearSubmittedSelection(chosen, page,
          state.currentRun.groups[state.currentRun.groups.length - 1].platformSkippedIds);
        addLog('\u7B2C' + page + '\u9875\u4E0A\u4E00\u7EC4\u63D0\u4EA4\u6210\u529F\uFF1B\u91CD\u65B0\u8BFB\u53D6\u5F53\u524D\u9875\u5E76\u6392\u9664\u5DF2\u63D0\u4EA4\u7684' + submittedIds.size + '\u6761\u7D20\u6750');
        restartPage = true;
        pageRebases = 0;
        break;
      }
      if (restartPage) continue;
      if (state.currentRun.groups.length >= cfg.maxGroups) return '\u7B2C' + page + '\u9875\u8FBE\u5230\u5355\u8BA1\u5212' + cfg.maxGroups + '\u7EC4\u4E0A\u9650';
      var pending = eligibleIds.length - offset;
      if (pending > 0) {
        var tail = '\u7B2C' + page + '\u9875\u5269\u4F59' + pending + '\u6761\u5408\u683C\u7D20\u6750\uFF0C\u672A\u63D0\u4EA4';
        if (!boundary && nextExists) {
          state.currentRun.incomplete = true;
          return tail + '\uFF1B\u5343\u5DDD\u7FFB\u9875\u4E0D\u4FDD\u7559\u52FE\u9009\uFF0C\u65E0\u6CD5\u4E0E\u4E0B\u4E00\u9875\u5408\u5E76\u51D1\u6EE1' + size + '\u6761\uFF0C\u5DF2\u5728\u7FFB\u9875\u524D\u6682\u505C\uFF1B\u672A\u8FDB\u5165\u8C03\u63A7\u6838\u67E5';
        }
        tail += '\uFF1B\u4F4E\u4E8E\u5C3E\u7EC4' + cfg.tailMin + '\u6761\u4E0B\u9650';
        return tail + (boundary ? '\uFF1B\u9047\u5230' + boundary + '\u540E\u505C\u6B62' : '\uFF1B\u5DF2\u5230\u6700\u540E\u4E00\u9875');
      }
      if (boundary) return '\u7B2C' + page + '\u9875\u9047\u5230' + boundary + '\uFF0C\u5DF2\u5B8C\u6210\u6B64\u524D\u7B26\u5408\u6761\u4EF6\u7684\u7D20\u6750';
      if (!nextExists) return '\u7B2C' + page + '\u9875\u5DF2\u5230\u7D20\u6750\u5217\u8868\u672B\u5C3E';
      if (!await nextPage()) return '\u7B2C' + page + '\u9875\u5DF2\u5230\u7D20\u6750\u5217\u8868\u672B\u5C3E';
    }
    return '\u8FBE\u5230\u5355\u8BA1\u5212\u8FFD\u6295\u7EC4\u6570\u4E0A\u9650';
  }

  async function submitProductPageGroup(items) {
    var before = rowsNow();
    var page = pageNumber(before.drawer);
    var ids = items.map(function (item) { return item.id; });
    var checkedIds = before.rows.filter(function (item) { return item.check.checked; })
      .map(function (item) { return item.id; });
    if (selectedCount(before.drawer) !== ids.length || !sameIds(ids, checkedIds)) {
      throw new Error('\u63D0\u4EA4\u524D\u5F53\u524D\u9875\u52FE\u9009\u4E0E\u672C\u7EC4\u7D20\u6750ID\u4E0D\u4E00\u81F4\uFF0C\u7981\u6B62\u7EE7\u7EED');
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
      if (++steps > 300) throw new Error('\u8D85\u8FC7300\u6B21\u7D20\u6750\u9875\u626B\u63CF\uFF0C\u5DF2\u505C\u6B62');
      var bundle = await waitForProductRowsReady();
      if (bundle.rows.length > roiPageSize()) throw new Error('\u5F53\u524D\u9875\u7D20\u6750\u6570\u8D85\u8FC7\u6BCF\u9875\u8BBE\u7F6E');
      if (selectedCount(bundle.drawer) !== selected.length) throw new Error('\u8DE8\u9875\u9009\u4E2D\u6570\u91CF\u672A\u4FDD\u7559\uFF0C\u7981\u6B62\u7EE7\u7EED');
      var candidates = bundle.rows.filter(function (item) { return !handled.has(item.id); });
      var eligible = [];
      var boundary = '';
      for (var i = 0; i < candidates.length; i++) {
        var item = candidates[i];
        if (!eligibleForChase(item)) continue;
        if (item.roi === null) { boundary = 'ROI \u4E3A\u201C\u2014\u201D'; break; }
        if (item.roi < cfg.roiThreshold) { boundary = 'ROI\uFF1C' + cfg.roiThreshold; break; }
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
          reason = '\u8FBE\u5230\u5355\u8BA1\u5212' + cfg.maxGroups + '\u7EC4\u4E0A\u9650';
          break;
        }
        if (eligible.length > chosen.length) continue;
      }
      if (boundary) {
        reason = '\u7B2C' + pageNumber(bundle.drawer) + '\u9875\u9996\u6B21\u51FA\u73B0' + boundary + '\uFF0C\u4EC5\u8FFD\u6295\u6B64\u524D\u8FBE\u5230\u9608\u503C\u7684\u7D20\u6750';
        break;
      }
      // Platform selection is page-local: commit this page before navigation.
      if (selected.length && hasNextPage(context('creative').drawer)) {
        var pageCount = selected.length;
        var sourcePage = pageNumber(context('creative').drawer);
        await submitProductPageGroup(selected);
        selected = [];
        addLog('\u7B2C' + sourcePage + '\u9875\u7FFB\u9875\u524D\u4F59\u91CF' + pageCount + '\u6761\u5DF2\u5355\u72EC\u63D0\u4EA4\u5E76\u6E05\u7A7A\u52FE\u9009\uFF1B\u4E0B\u4E00\u9875\u91CD\u65B0\u7EC4\u5355');
        if (cfg.mode === 'roi' && cfg.roiStrategy === 'whole_group' && stopAfterGroup) {
          reason = '\u5F53\u524D\u9875\u9996\u6B21\u8DE8\u8FC7ROI\u9608\u503C\uFF0C\u672C\u9875\u7EC4\u5DF2\u63D0\u4EA4\u540E\u505C\u6B62';
          break;
        }
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '\u8FBE\u5230\u5355\u8BA1\u5212' + cfg.maxGroups + '\u7EC4\u4E0A\u9650';
          break;
        }
      }
      if (!await nextPage()) { reason = '\u7D20\u6750\u5217\u8868\u5DF2\u5230\u6700\u540E\u4E00\u9875'; break; }
    }
    if (selected.length >= (cfg.planKind === 'live' ? cfg.tailMin : 1) && state.currentRun.groups.length < cfg.maxGroups) {
      if (selectedCount(context('creative').drawer) !== selected.length) throw new Error('\u5C3E\u7EC4\u9009\u4E2D\u6570\u91CF\u4E0D\u5339\u914D');
      await submitProductPageGroup(selected);
      reason += '\uFF1B\u672B\u7EC4' + selected.length + '\u6761\u8FBE\u6807\u7D20\u6750\u5DF2\u63D0\u4EA4';
    } else if (selected.length) {
      reason += '\uFF1B\u5269\u4F59' + selected.length + '\u6761\u4E0D\u8DB3\u5C3E\u7EC4' + cfg.tailMin + '\u6761\u4E0B\u9650\uFF0C\u672A\u63D0\u4EA4';
    }
    return reason || '\u8FBE\u5230\u5355\u8BA1\u5212\u8FFD\u6295\u7EC4\u6570\u4E0A\u9650';
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
      if (++steps > 300) throw new Error('\u8D85\u8FC7300\u6B21\u7D20\u6750\u9875\u626B\u63CF\uFF0C\u5DF2\u505C\u6B62');
      var bundle = await waitForProductRowsReady();
      if (bundle.rows.length > roiPageSize()) throw new Error('\u5F53\u524D\u9875\u7D20\u6750\u6570\u8D85\u8FC7\u6BCF\u9875\u8BBE\u7F6E');
      if (selectedCount(bundle.drawer) !== selected.length) throw new Error('\u8DE8\u9875\u9009\u4E2D\u6570\u91CF\u672A\u4FDD\u7559\uFF0C\u7981\u6B62\u7EE7\u7EED');
      var candidates = bundle.rows.filter(function (item) { return !handled.has(item.id) && eligibleForChase(item); });
      var pageHasBelow = candidates.some(function (item) {
        return item.roi !== null && item.roi < cfg.roiThreshold;
      });
      if (!stopAfterGroup && cfg.dashPolicy === 'pause' && !pageHasBelow &&
          candidates.some(function (item) { return item.roi === null; })) {
        pausedForDash = true;
        reason = '\u7B2C' + pageNumber(bundle.drawer) + '\u9875\u51FA\u73B0 ROI \u4E3A\u201C\u2014\u201D\u7684\u7D20\u6750\uFF0C\u6309\u5B89\u5168\u7B56\u7565\u6682\u505C';
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
          reason = '\u7B2C' + pageNumber(bundle.drawer) + '\u9875\u9996\u6B21\u8DE8\u8FC7 ROI ' + cfg.roiThreshold + ' \u9608\u503C\uFF0C\u6574\u7EC4\u63D0\u4EA4\u540E\u505C\u6B62';
          break;
        }
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '\u8FBE\u5230\u5355\u8BA1\u5212' + cfg.maxGroups + '\u7EC4\u4E0A\u9650';
          break;
        }
        if (candidates.length > chosen.length) continue;
      }
      // Platform selection is page-local: commit this page before navigation.
      if (selected.length && hasNextPage(context('creative').drawer)) {
        var pageCount = selected.length;
        var sourcePage = pageNumber(context('creative').drawer);
        await submitProductPageGroup(selected);
        selected = [];
        addLog('\u7B2C' + sourcePage + '\u9875\u7FFB\u9875\u524D\u4F59\u91CF' + pageCount + '\u6761\u5DF2\u5355\u72EC\u63D0\u4EA4\u5E76\u6E05\u7A7A\u52FE\u9009\uFF1B\u4E0B\u4E00\u9875\u91CD\u65B0\u7EC4\u5355');
        if (cfg.mode === 'roi' && cfg.roiStrategy === 'whole_group' && stopAfterGroup) {
          reason = '\u5F53\u524D\u9875\u9996\u6B21\u8DE8\u8FC7ROI\u9608\u503C\uFF0C\u672C\u9875\u7EC4\u5DF2\u63D0\u4EA4\u540E\u505C\u6B62';
          break;
        }
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '\u8FBE\u5230\u5355\u8BA1\u5212' + cfg.maxGroups + '\u7EC4\u4E0A\u9650';
          break;
        }
      }
      if (!await nextPage()) { reason = '\u7D20\u6750\u5217\u8868\u5DF2\u5230\u6700\u540E\u4E00\u9875'; break; }
    }
    if (pausedForDash && selected.length) {
      reason += '\uFF1B\u5DF2\u6709' + selected.length + '\u6761\u672A\u6EE1\u7EC4\u7D20\u6750\u4FDD\u6301\u52FE\u9009\uFF0C\u672A\u63D0\u4EA4';
    } else if (selected.length && state.currentRun.groups.length < cfg.maxGroups) {
      if (selectedCount(context('creative').drawer) !== selected.length) throw new Error('\u5C3E\u7EC4\u9009\u4E2D\u6570\u91CF\u4E0D\u5339\u914D');
      await submitProductPageGroup(selected);
      reason += '\uFF1B\u672B\u7EC4' + selected.length + '\u6761\u5DF2\u63D0\u4EA4';
    }
    return reason || '\u8FBE\u5230\u5355\u8BA1\u5212\u8FFD\u6295\u7EC4\u6570\u4E0A\u9650';
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
      if (++pageSteps > 300) throw new Error('\u8D85\u8FC7300\u6B21\u7D20\u6750\u9875\u626B\u63CF\uFF0C\u5DF2\u505C\u6B62');
      var bundle = await waitForProductRowsReady();
      if (bundle.rows.length > 20) throw new Error('\u5F53\u524D\u9875\u8D85\u8FC720\u6761');
      if (selectedCount(bundle.drawer) !== selected.length) {
        throw new Error('\u8DE8\u9875\u9009\u4E2D\u6570\u91CF\u672A\u4FDD\u7559\uFF0C\u7981\u6B62\u7EE7\u7EED');
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
          reason = '\u8FBE\u5230\u5355\u8BA1\u5212' + cfg.maxGroups + '\u7EC4\u4E0A\u9650';
          break;
        }
        if (eligible.length > chosen.length) continue;
      }
      var olderThanStart = bundle.rows.some(function (item) { return item.date < cfg.startDate; });
      if (olderThanStart) {
        reason = '\u7B2C' + pageNumber(bundle.drawer) + '\u9875\u51FA\u73B0\u65E9\u4E8E\u8D77\u59CB\u65E5\u671F' + cfg.startDate + '\u7684\u7D20\u6750';
        break;
      }
      // Platform selection is page-local: commit this page before navigation.
      if (selected.length && hasNextPage(context('creative').drawer)) {
        var pageCount = selected.length;
        var sourcePage = pageNumber(context('creative').drawer);
        await submitProductPageGroup(selected);
        selected = [];
        addLog('\u7B2C' + sourcePage + '\u9875\u7FFB\u9875\u524D\u4F59\u91CF' + pageCount + '\u6761\u5DF2\u5355\u72EC\u63D0\u4EA4\u5E76\u6E05\u7A7A\u52FE\u9009\uFF1B\u4E0B\u4E00\u9875\u91CD\u65B0\u7EC4\u5355');
        if (cfg.mode === 'roi' && cfg.roiStrategy === 'whole_group' && stopAfterGroup) {
          reason = '\u5F53\u524D\u9875\u9996\u6B21\u8DE8\u8FC7ROI\u9608\u503C\uFF0C\u672C\u9875\u7EC4\u5DF2\u63D0\u4EA4\u540E\u505C\u6B62';
          break;
        }
        if (state.currentRun.groups.length >= cfg.maxGroups) {
          reason = '\u8FBE\u5230\u5355\u8BA1\u5212' + cfg.maxGroups + '\u7EC4\u4E0A\u9650';
          break;
        }
      }
      if (!await nextPage()) {
        reason = '\u7D20\u6750\u5217\u8868\u5DF2\u5230\u6700\u540E\u4E00\u9875';
        break;
      }
    }
    if (selected.length >= cfg.tailMin && selected.length < cfg.dateGroupSize && state.currentRun.groups.length < cfg.maxGroups) {
      if (selectedCount(context('creative').drawer) !== selected.length) throw new Error('\u5C3E\u7EC4\u9009\u4E2D\u6570\u91CF\u4E0D\u5339\u914D');
      await submitProductPageGroup(selected);
      reason += '\uFF1B\u5C3E\u7EC4' + selected.length + '\u6761\u5DF2\u63D0\u4EA4';
    } else if (selected.length > 0 && selected.length < cfg.tailMin) {
      reason += '\uFF1B\u5269\u4F59' + selected.length + '\u6761\u4E0D\u8DB3' + cfg.tailMin + '\u6761\uFF0C\u672A\u63D0\u4EA4';
    }
    return reason;
  }

  function taskTable(drawer) {
    var heads = Array.from(drawer.querySelectorAll('.main-vmok-plugin-table__head-wrapper')).filter(visible);
    var head = heads.find(function (el) {
      return exactText(el).includes('\u4EFB\u52A1\u540D\u79F0') && exactText(el).includes('\u7D20\u6750');
    });
    if (!head) throw new Error('\u65E0\u6CD5\u5B9A\u4F4D\u7D20\u6750\u8FFD\u6295\u4EFB\u52A1\u8868\u5934');
    var wrapper = head.parentElement;
    var body = wrapper.querySelector('.main-vmok-plugin-table__body-wrapper');
    if (!body) throw new Error('\u65E0\u6CD5\u5B9A\u4F4D\u7D20\u6750\u8FFD\u6295\u4EFB\u52A1\u8868\u4F53');
    var headers = Array.from(head.querySelectorAll('thead tr:first-child th')).map(exactText);
    return { body: body, headers: headers };
  }

  async function openTaskCenter() {
    var drawer = context().drawer;
    var tab = unique(Array.from(drawer.querySelectorAll('[role="tab"]')).filter(function (el) {
      return el.id.endsWith('-tab-uni_task_center') && exactText(el) === '\u8C03\u63A7';
    }), '\u8C03\u63A7\u6807\u7B7E');
    if (tab.getAttribute('aria-selected') !== 'true') await safeClick(tab, '\u8C03\u63A7\u6807\u7B7E', true);
    await waitFor(function () {
      return !!context('uni_task_center').drawer;
    }, '\u8C03\u63A7\u4EFB\u52A1\u9875');
    drawer = context('uni_task_center').drawer;
    var radio = unique(Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
      .filter(function (el) { return exactText(el) === '\u7D20\u6750\u8FFD\u6295'; }), '\u7D20\u6750\u8FFD\u6295\u4EFB\u52A1\u6807\u7B7E');
    if (!radio.className.includes('--checked')) await safeClick(radio, '\u7D20\u6750\u8FFD\u6295\u4EFB\u52A1\u6807\u7B7E', true);
    await waitFor(function () { return taskTable(context('uni_task_center').drawer); }, '\u7D20\u6750\u8FFD\u6295\u4EFB\u52A1\u5217\u8868', 10000);
  }

  function taskRows() {
    var table = taskTable(context('uni_task_center').drawer);
    var h = table.headers;
    var nameIdx = h.findIndex(function (x) { return x.includes('\u4EFB\u52A1\u540D\u79F0'); });
    var countIdx = h.findIndex(function (x) { return x === '\u7D20\u6750'; });
    var statusIdx = h.findIndex(function (x) { return x.includes('\u8C03\u63A7\u72B6\u6001'); });
    var budgetIdx = h.findIndex(function (x) { return x.includes('\u8C03\u63A7\u9884\u7B97'); });
    var hoursIdx = h.findIndex(function (x) { return x.includes('\u8C03\u63A7\u65F6\u957F'); });
    if ([nameIdx, countIdx, statusIdx, budgetIdx].some(function (x) { return x < 0; }) ||
        (state.config.planKind !== 'live' && hoursIdx < 0)) {
      throw new Error('\u7D20\u6750\u8FFD\u6295\u4EFB\u52A1\u5217\u8868\u5217\u540D\u5DF2\u6539\u53D8');
    }
    return Array.from(table.body.querySelectorAll('tbody tr')).filter(visible).map(function (tr) {
      var cells = Array.from(tr.querySelectorAll(':scope > td')).map(exactText);
      var nameCell = cells[nameIdx] || '';
      var taskId = (nameCell.match(/ID[\uFF1A:]\s*(\d+)/) || [])[1] || '';
      var materialCell = cells[countIdx] || '';
      var countMatch = materialCell.match(/\u5171\s*(\d+)\s*\u6761\u89C6\u9891/);
      var singleMaterial = !countMatch && /\u7D20\u6750ID[\uFF1A:]\s*\d+/.test(materialCell);
      var budget = (cells[budgetIdx] || '').match(/[\d,.]+/);
      var hours = hoursIdx < 0 ? null : (cells[hoursIdx] || '').match(/[\d.]+/);
      return {
        name: nameCell.replace(/\s*ID[\uFF1A:]\s*\d+[\s\S]*$/, '').trim(),
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
    await waitFor(function () { return taskRows().length > 0; }, '\u7D20\u6750\u8FFD\u6295\u4EFB\u52A1\u6570\u636E', 10000);
    var firstFooters = Array.from(context('uni_task_center').drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper')).filter(visible);
    if (firstFooters.length > 1) throw new Error('\u4EFB\u52A1\u5206\u9875\u680F\u51FA\u73B0\u591A\u4E2A\uFF0C\u65E0\u6CD5\u5B89\u5168\u6838\u67E5');
    if (firstFooters.length === 1) {
      var firstFooter = firstFooters[0];
      var activePage = unique(firstFooter.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '\u4EFB\u52A1\u5F53\u524D\u9875\u7801');
      if (exactText(activePage) !== '1') {
        var beforeId = taskRows()[0] && taskRows()[0].taskId;
        var firstPage = unique(Array.from(firstFooter.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
          .filter(function (el) { return exactText(el) === '1'; }), '\u4EFB\u52A1\u7B2C1\u9875');
        await safeClick(firstPage, '\u4EFB\u52A1\u5217\u8868\u7B2C1\u9875', true);
        await waitFor(function () {
          var footer = unique(context('uni_task_center').drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'), '\u4EFB\u52A1\u5206\u9875\u680F');
          var active = unique(footer.querySelectorAll('.main-vmok-plugin-page-turner__item--active'), '\u4EFB\u52A1\u5F53\u524D\u9875\u7801');
          var first = taskRows()[0];
          return exactText(active) === '1' && first && first.taskId !== beforeId;
        }, '\u4EFB\u52A1\u5217\u8868\u56DE\u5230\u7B2C1\u9875', 8000);
      }
    }
    var expected = state.currentRun.groups;
    if (waitForRecent) {
      await waitFor(function () {
        var listed = taskRows();
        return expected.some(function (g) {
          return listed.some(function (row) { return row.name === g.name; });
        });
      }, '\u65B0\u8FFD\u6295\u4EFB\u52A1\u8FDB\u5165\u8C03\u63A7\u5217\u8868', 20000);
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
      if (footers.length > 1) throw new Error('\u4EFB\u52A1\u5206\u9875\u680F\u51FA\u73B0\u591A\u4E2A\uFF0C\u65E0\u6CD5\u5B89\u5168\u6838\u67E5');
      if (footers.length === 0) break;
      var nexts = Array.from(footers[0].querySelectorAll('li.main-vmok-plugin-page-turner__item'))
        .filter(function (el) { return !!el.querySelector('.main-vmok-plugin-page-turner__next-icon'); });
      if (nexts.length !== 1 || nexts[0].className.includes('disabled') ||
          nexts[0].getAttribute('aria-disabled') === 'true') break;
      var firstBefore = taskRows()[0] && taskRows()[0].taskId;
      await safeClick(nexts[0], '\u4EFB\u52A1\u5217\u8868\u4E0B\u4E00\u9875', true);
      await waitFor(function () {
        var first = taskRows()[0];
        return first && first.taskId !== firstBefore;
      }, '\u4EFB\u52A1\u5217\u8868\u7FFB\u9875', 8000);
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
          row.state.startsWith('\u8C03\u63A7\u4E2D') ?
          'verified' : 'mismatch';
        g.actual = { count: row.count, budget: row.budget, hours: row.hours, state: row.state };
      }
    });
    saveJournal();
    if (incompleteScan) {
      state.currentRun.verifyIncomplete = true;
      state.currentRun.stopReason += '\uFF1B\u4EFB\u52A1\u5217\u8868\u626B\u63CF\u8FBE\u523020\u9875\uFF0C\u91CD\u590D\u4EFB\u52A1\u68C0\u67E5\u4E0D\u5B8C\u6574';
      addLog('\u4EFB\u52A1\u5217\u8868\u626B\u63CF\u8FBE\u523020\u9875\uFF0C\u91CD\u590D\u4EFB\u52A1\u68C0\u67E5\u4E0D\u5B8C\u6574');
    }
    var verified = expected.filter(function (g) { return g.status === 'verified'; }).length;
    addLog('\u8C03\u63A7\u2192\u7D20\u6750\u8FFD\u6295\u6838\u67E5\uFF1A' + verified + '/' + expected.length + '\u7EC4\u6570\u636E\u5B8C\u5168\u5339\u914D');
    return !incompleteScan && verified === expected.length;
  }

  function validateConfig(overviewMode) {
    var cfg = state.config;
    var current = overviewMode ? null : context('creative');
    if (!cfg.accountId || (!overviewMode && !cfg.planId)) throw new Error('\u8BF7\u5148\u9501\u5B9A\u5F53\u524D\u8BA1\u5212');
    if (current && current.planKind !== cfg.planKind) throw new Error('\u9501\u5B9A\u8BA1\u5212\u7C7B\u578B\u4E0E\u9875\u9762\u4E0D\u4E00\u81F4');
    if (!Number.isInteger(cfg.budget) || cfg.budget < MIN_BUDGET || cfg.budget > MAX_BUDGET) {
      throw new Error('\u5355\u7EC4\u9884\u7B97\u987B\u4E3A100\u2013500\u5143\u6574\u6570');
    }
    if (cfg.planKind !== 'live' && (!Number.isFinite(cfg.hours) || cfg.hours < 0.5 || cfg.hours > MAX_HOURS)) {
      throw new Error('\u8C03\u63A7\u65F6\u957F\u987B\u4E3A0.5\u201324\u5C0F\u65F6');
    }
    var maxAllowedGroups = cfg.planKind === 'live' ? MAX_LIVE_GROUPS : MAX_PRODUCT_GROUPS;
    if (!Number.isInteger(cfg.maxGroups) || cfg.maxGroups < 1 || cfg.maxGroups > maxAllowedGroups) {
      throw new Error('\u672C\u8F6E\u7EC4\u6570\u987B\u4E3A1\u2013' + maxAllowedGroups + '\u7EC4');
    }
    var groupSize = cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize;
    if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 20) {
      throw new Error('\u5355\u7EC4\u89C6\u9891\u6570\u91CF\u987B\u4E3A1\u201320\u6761\u6574\u6570');
    }
    if (cfg.planKind === 'live') {
      if (groupSize < cfg.tailMin || cfg.tailMin < 1 || cfg.tailMin > 20) {
        throw new Error('\u76F4\u64AD\u5C3E\u7EC4\u6700\u5C11\u6570\u91CF\u987B\u57281\u201320\u6761\u4E14\u4E0D\u5927\u4E8E\u6BCF\u7EC4\u6570\u91CF');
      }
      if (!['\u76F4\u64AD\u95F4\u6210\u4EA4', '\u7EFC\u5408\u8425\u9500ROI'].includes(cfg.liveGoal)) throw new Error('\u76F4\u64AD\u4F18\u5316\u76EE\u6807\u65E0\u6CD5\u8BC6\u522B');
      if (!['\u4E0D\u9650', '\u7537', '\u5973'].includes(cfg.liveGender)) throw new Error('\u76F4\u64AD\u6027\u522B\u5B9A\u5411\u65E0\u6CD5\u8BC6\u522B');
      if (cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' && (!Number.isFinite(cfg.bid) || cfg.bid <= 0 || cfg.bid > 1000)) {
        throw new Error('\u76F4\u64AD\u201C\u6211\u7684\u51FA\u4EF7\u201D\u987B\u4E3A0\u20131000\u5143\u4E4B\u95F4\u7684\u6B63\u6570');
      }
      if (cfg.liveGoal === '\u7EFC\u5408\u8425\u9500ROI' &&
          (!Number.isFinite(Number(cfg.liveRoiTarget)) || Number(cfg.liveRoiTarget) <= 0 || Number(cfg.liveRoiTarget) > 1000)) {
        throw new Error('\u76F4\u64AD\u7EFC\u5408\u8425\u9500ROI\u76EE\u6807\u987B\u4E3A0\u20131000\u4E4B\u95F4\u7684\u6B63\u6570');
      }
      if (cfg.mode === 'roi' && cfg.roiStrategy !== 'strict') {
        throw new Error('\u76F4\u64AD ROI \u8FFD\u6295\u53EA\u652F\u6301\u4E25\u683C\u7B5B\u9009\u8FBE\u6807\u7D20\u6750');
      }
    }
    if (cfg.mode === 'roi') {
      if (cfg.planKind === 'live') {
        var today = new Date();
        var localDay = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'),
          String(today.getDate()).padStart(2, '0')].join('-');
        if (new URL(location.href).searchParams.get('dateRange') !== localDay + ',' + localDay) {
          throw new Error('\u76F4\u64AD ROI \u6A21\u5F0F\u987B\u5C06\u5343\u5DDD\u6570\u636E\u65E5\u671F\u8BBE\u4E3A\u7CFB\u7EDF\u5F53\u5929\uFF1A' + localDay);
        }
      }
      if (!Number.isFinite(cfg.roiThreshold) || cfg.roiThreshold < 0 || cfg.roiThreshold > 1000) {
        throw new Error('ROI \u9608\u503C\u987B\u4E3A0\u20131000\u4E4B\u95F4\u7684\u6570\u503C');
      }
      if (!['whole_group', 'strict'].includes(cfg.roiStrategy)) throw new Error('ROI \u8FFD\u6295\u7B56\u7565\u65E0\u6CD5\u8BC6\u522B');
    }
    if (cfg.mode === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.endDate) ||
          cfg.startDate > cfg.endDate) {
        throw new Error('\u8BF7\u586B\u5199\u6709\u6548\u7684\u521B\u5EFA\u65E5\u671F\u533A\u95F4\uFF0C\u8D77\u59CB\u65E5\u671F\u4E0D\u80FD\u665A\u4E8E\u7ED3\u675F\u65E5\u671F');
      }
    }
  }

  function readFormSnapshot() {
    var get = function (id) {
      var el = shadow.getElementById(id);
      if (!el) throw new Error('\u64CD\u4F5C\u9762\u677F\u7F3A\u5C11\u8F93\u5165\u9879\uFF1A' + id);
      return el;
    };
    var cfg = state.config;
    cfg.dryRun = get('dry-run').checked;
    cfg.budget = Number(get('budget').value);
    if (cfg.planKind === 'live') {
      cfg.liveGoal = get('live-goal').value;
      cfg.liveGender = get('live-gender').value;
      if (cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4') cfg.bid = Number(get('bid').value);
      else cfg.liveRoiTarget = get('live-roi-target').value.trim();
      cfg.tailMin = Number(get('tail-min').value);
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
          return line.includes('\u7B2C' + (index + 1) + '\u7EC4\uFF1A\u9875\u9762\u663E\u793A\u64CD\u4F5C\u6210\u529F');
        });
    });
    return [
      run.accountName + ' \u2192 ' + run.planName,
      '\u6A21\u5F0F\uFF1A' + (run.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI\u964D\u5E8F' : '\u521B\u5EFA\u65E5\u671F\u964D\u5E8F'),
      '\u8BA1\u5212\u7C7B\u578B\uFF1A' + (run.planKind === 'live' ? '\u63A8\u76F4\u64AD\u95F4' : '\u5546\u54C1\u81EA\u9009') +
        (run.planKind === 'live' ? '\uFF1B\u63A7\u6210\u672C\u8FFD\u6295\uFF1B\u4F18\u5316\u76EE\u6807' + run.liveGoal + '\uFF1B' +
          (run.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' ? '\u6211\u7684\u51FA\u4EF7' + run.bid + '\u5143' : '\u7EFC\u5408\u8425\u9500ROI\u76EE\u6807' + run.liveRoiTarget) +
          '\uFF1B\u5B9A\u5411\u6027\u522B' + run.liveGender + '\uFF1B' +
          (run.skipControlling ? '\u8DF3\u8FC7\u8C03\u63A7\u4E2D\u7D20\u6750' : '\u4E0D\u8DF3\u8FC7\u8C03\u63A7\u4E2D\u7D20\u6750') : ''),
      '\u8BBE\u7F6E\uFF1A\u6BCF\u7EC4' + (run.groupSize || (run.mode === 'roi' ? 10 : 20)) + '\u6761' +
        (run.mode === 'roi' ? '\uFF1BROI\u2265' + (run.roiThreshold == null ? 1 : run.roiThreshold) +
          '\uFF1B' + (run.roiStrategy === 'strict' ? '\u4E25\u683C\u53EA\u8FFD\u6295\u8FBE\u6807\u7D20\u6750' : '\u8DE8\u9608\u503C\u6574\u7EC4\u63D0\u4EA4\u540E\u505C\u6B62') :
          (run.startDate && run.endDate ? '\uFF1B\u521B\u5EFA\u65E5\u671F' + run.startDate + '\u81F3' + run.endDate + '\uFF08\u542B\u4E24\u7AEF\uFF09' : '')),
      '\u786E\u8BA4\u6210\u529F\u7EC4\u6570\uFF1A' + verified.length + '\uFF1B\u9875\u9762\u663E\u793A\u6210\u529F\u7EC4\u6570\uFF1A' + uiSuccess.length,
      '\u4EFB\u52A1\u6838\u67E5\u72B6\u6001\uFF1A' + (run.verifyDeferred ? '\u8FFD\u6295\u4E2D\u9014\u505C\u6B62\uFF0C\u672A\u81EA\u52A8\u79BB\u5F00\u7D20\u6750\u9875\uFF1B\u53EF\u624B\u52A8\u70B9\u51FB\u201C\u53EA\u91CD\u65B0\u6838\u67E5\u672A\u6838\u6E05\u4EFB\u52A1\uFF08\u4E0D\u63D0\u4EA4\uFF09\u201D' :
        (run.status === 'verified' ? '\u5DF2\u7EDF\u4E00\u6838\u67E5' :
          (groups.length ? '\u5DF2\u6838\u67E5\uFF0C\u4ECD\u6709\u4EFB\u52A1\u5F85\u786E\u8BA4' : '\u672C\u8F6E\u672A\u521B\u5EFA\u4EFB\u52A1'))),
      '\u6BCF\u7EC4\u5B9E\u9645\u7D20\u6750\u6570\u91CF\uFF1A' + groups.map(function (g) { return g.count + '\u6761\uFF08' + g.status + '\uFF09'; }).join('\u3001'),
      '\u5E73\u53F0\u8FC7\u6EE4\u672A\u8FFD\u6295\u7D20\u6750\uFF1A' + (groups.flatMap(function (g) { return g.platformSkippedIds || []; }).join('\u3001') || '\u65E0'),
      '\u660E\u786E\u5931\u8D25\u540E\u81EA\u52A8\u91CD\u8BD5\u7684\u7EC4\u6570\uFF1A' + groups.filter(function (g) { return g.submitAttempts === 2; }).length + '\uFF1B\u6BCF\u7EC4\u6700\u591A\u91CD\u8BD5\u4E00\u6B21',
      '\u786E\u8BA4\u8FFD\u6295\u7D20\u6750\u603B\u6570\uFF1A' + verified.reduce(function (n, g) { return n + g.count; }, 0),
      '\u786E\u8BA4\u8C03\u63A7\u65E5\u9884\u7B97\uFF1A' + verified.reduce(function (n, g) { return n + g.budget; }, 0) + '\u5143',
      '\u505C\u6B62\u4F4D\u7F6E\u548C\u539F\u56E0\uFF1A' + run.stopReason,
      '\u672A\u6267\u884C\u8BA1\u5212\uFF1A\u65E0\uFF08\u672C\u8F6E\u4EC5\u9501\u5B9A\u4E00\u6761\u8BA1\u5212\uFF09',
      '\u91CD\u590D\u4EFB\u52A1\u3001\u63D0\u4EA4\u5F02\u5E38\u6216\u98CE\u63A7\uFF1A' + (abnormal.length ?
        abnormal.map(function (g) {
          var actual = g.actual ? '\uFF0C\u4EFB\u52A1\u5217\u8868\u4E3A' + g.actual.count + '\u6761/' + g.actual.budget +
            '\u5143/' + (run.planKind === 'live' ? '' : g.actual.hours + '\u5C0F\u65F6/') + g.actual.state : '';
          return g.name + ' ' + g.status + actual + (g.error ? ' ' + g.error : '');
        }).join('\uFF1B') :
        (run.verifyIncomplete ? '\u4EFB\u52A1\u5217\u8868\u672A\u626B\u63CF\u5B8C\uFF0C\u91CD\u590D\u60C5\u51B5\u672A\u80FD\u6392\u9664' : '\u672C\u8F6E\u5DF2\u626B\u63CF\u4EFB\u52A1\u4E2D\u672A\u53D1\u73B0\uFF1B\u672A\u68C0\u6D4B\u5230\u5E73\u53F0\u98CE\u63A7')),
      '\u4EFB\u52A1 ID\uFF1A' + groups.map(function (g) { return g.taskId || '\u672A\u8BFB\u53D6'; }).join('\u3001')
    ].join('\n');
  }

  function liveOverview() {
    var url = new URL(location.href);
    if (url.pathname !== '/overall-prom' || !url.hash.includes('marGoal=2') ||
        url.searchParams.get('campaignType') !== '1' || url.searchParams.get('uniTab') !== 'ad') {
      throw new Error('\u6279\u91CF\u5165\u53E3\u4EC5\u5728\u201C\u4E58\u65B9\u2192\u76F4\u64AD\u2192\u5728\u6295\u8BA1\u5212\u201D\u603B\u89C8\u9875\u4F7F\u7528');
    }
    return readAccountIdentity(url);
  }

  async function scanLivePlans() {
    await dismissKnownPromo();
    var account = liveOverview();
    var plans = [];
    var skipped = [];
    var seen = new Set();
    for (var page = 1; page <= 300; page++) {
      var footer = unique(document.querySelectorAll('[class*="paginationContainer"]'), '\u76F4\u64AD\u8BA1\u5212\u5206\u9875\u680F');
      var active = unique(footer.querySelectorAll('.aurora-qc-pagination-item-active'), '\u76F4\u64AD\u8BA1\u5212\u9875\u7801');
      if (Number(exactText(active)) !== page) throw new Error('\u76F4\u64AD\u8BA1\u5212\u9875\u7801\u4E0E\u626B\u63CF\u8FDB\u5EA6\u4E0D\u4E00\u81F4');
      var rows = Array.from(document.querySelectorAll('tr[data-row-key]')).filter(visible).filter(function (tr) {
        return !!tr.querySelector('[id^="ad-name-"]');
      });
      if (!rows.length) throw new Error('\u76F4\u64AD\u8BA1\u5212\u5217\u8868\u6CA1\u6709\u53EF\u8BFB\u53D6\u7684\u8BA1\u5212\u884C');
      rows.forEach(function (tr) {
        var id = tr.getAttribute('data-row-key');
        var cells = Array.from(tr.querySelectorAll(':scope > td'));
        if (!/^\d+$/.test(id || '') || cells.length < 3 || seen.has(id)) throw new Error('\u76F4\u64AD\u8BA1\u5212 ID \u6216\u884C\u6570\u636E\u5F02\u5E38');
        seen.add(id);
        var heading = cells[1].querySelector('#ad-name-' + id);
        if (!heading || !exactText(heading).includes('\u76F4\u64AD\u5927\u5C4F')) throw new Error('\u8BA1\u5212 ' + id + ' \u4E0D\u662F\u76F4\u64AD\u5927\u5C4F\u8BA1\u5212');
        var lines = (heading.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var name = lines[1] || '';
        if (!name || name === '\u7D20\u6750') throw new Error('\u65E0\u6CD5\u8BFB\u53D6\u76F4\u64AD\u8BA1\u5212\u540D\u79F0\uFF1A' + id);
        var status = exactText(cells[2]);
        if (status.split(' ').includes('\u6295\u653E\u4E2D')) plans.push({ id: id, name: name });
        else skipped.push({ id: id, name: name, reason: '\u72B6\u6001\u4E0D\u662F\u6295\u653E\u4E2D\uFF1A' + status });
      });
      var next = unique(footer.querySelectorAll('li.aurora-qc-pagination-next'), '\u76F4\u64AD\u8BA1\u5212\u4E0B\u4E00\u9875');
      if (next.className.includes('disabled') || next.getAttribute('aria-disabled') === 'true') {
        return { account: account, plans: plans, skipped: skipped };
      }
      var button = unique(next.querySelectorAll('button'), '\u76F4\u64AD\u8BA1\u5212\u4E0B\u4E00\u9875\u6309\u94AE');
      await safeClick(button, '\u76F4\u64AD\u8BA1\u5212\u4E0B\u4E00\u9875');
      await waitFor(function () {
        var f = unique(document.querySelectorAll('[class*="paginationContainer"]'), '\u76F4\u64AD\u8BA1\u5212\u5206\u9875\u680F');
        var a = unique(f.querySelectorAll('.aurora-qc-pagination-item-active'), '\u76F4\u64AD\u8BA1\u5212\u9875\u7801');
        return Number(exactText(a)) === page + 1;
      }, '\u76F4\u64AD\u8BA1\u5212\u7FFB\u9875', 10000);
    }
    throw new Error('\u76F4\u64AD\u8BA1\u5212\u5217\u8868\u8D85\u8FC7300\u9875\uFF0C\u5DF2\u505C\u6B62');
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
      if (!result.plans.length) throw new Error('\u672C\u8D26\u6237\u6CA1\u6709\u6295\u653E\u4E2D\u7684\u76F4\u64AD\u8BA1\u5212');
      if (state.config.dryRun) {
        state.report = '\u76F4\u64AD\u5728\u6295\u8BA1\u5212\u626B\u63CF\u5B8C\u6210\uFF1B\u6F14\u7EC3\u672A\u52FE\u9009\u6216\u63D0\u4EA4\u3002\n' +
          '\u8D26\u6237\uFF1A' + result.account.accountName + '\n\u5728\u6295\u8BA1\u5212\uFF1A' +
          result.plans.map(function (p) { return p.name + '\uFF08' + p.id + '\uFF09'; }).join('\u3001') +
          '\n\u672A\u6267\u884C\u8BA1\u5212\uFF1A' + (result.skipped.length ? result.skipped.map(function (p) {
            return p.name + '\uFF08' + p.id + '\uFF09\uFF1A' + p.reason;
          }).join('\uFF1B') : '\u65E0');
        setPhase('\u8D26\u6237\u8BA1\u5212\u626B\u63CF\u5B8C\u6210\uFF1B\u672A\u63D0\u4EA4');
        return;
      }
      if (state.batch && ['navigating', 'running', 'needs_review'].includes(state.batch.status)) {
        throw new Error('\u5DF2\u6709\u672A\u5B8C\u6210\u7684\u76F4\u64AD\u6279\u91CF\u4EFB\u52A1\uFF0C\u8BF7\u5148\u4EBA\u5DE5\u6838\u5BF9');
      }
      state.batch = {
        status: 'navigating', account: result.account, plans: result.plans,
        skipped: result.skipped, index: 0, reports: [], config: Object.assign({}, state.config),
        startedAt: new Date().toISOString()
      };
      saveBatch();
      location.assign(livePlanUrl(result.plans[0].id));
    } catch (error) { setPhase('\u76F4\u64AD\u6279\u91CF\u5F00\u59CB\u5931\u8D25\uFF1A' + error.message); }
    finally { state.busy = false; render(); }
  }

  function advanceLiveBatch(run) {
    var batch = state.batch;
    if (!batch || batch.status !== 'running') return;
    var target = batch.plans[batch.index];
    if (!target || !run || run.planId !== target.id || run.accountId !== batch.account.accountId) {
      batch.status = 'needs_review';
      saveBatch();
      setPhase('\u6279\u91CF\u4E2D\u65AD\uFF1A\u8BA1\u5212\u8EAB\u4EFD\u6216\u63D0\u4EA4\u8BB0\u5F55\u4E0D\u4E00\u81F4');
      return;
    }
    batch.reports.push(makeReport(run));
    if (!['verified', 'stopped_without_submit'].includes(run.status)) {
      batch.status = 'needs_review';
      saveBatch();
      state.report = batch.reports.join('\n\n') + '\n\n\u672A\u6267\u884C\u8BA1\u5212\uFF1A' +
        batch.plans.slice(batch.index + 1).map(function (p) { return p.name + '\uFF08' + p.id + '\uFF09\uFF1A\u524D\u4E00\u8BA1\u5212\u7ED3\u679C\u5F85\u6838\u5BF9'; }).concat(
          batch.skipped.map(function (p) { return p.name + '\uFF08' + p.id + '\uFF09\uFF1A' + p.reason; })
        ).join('\uFF1B');
      setPhase('\u6279\u91CF\u4E2D\u65AD\uFF1A\u5F53\u524D\u8BA1\u5212\u987B\u4EBA\u5DE5\u6838\u5BF9\uFF0C\u540E\u7EED\u8BA1\u5212\u672A\u6267\u884C');
      return;
    }
    batch.index++;
    if (batch.index >= batch.plans.length) {
      batch.status = 'complete';
      saveBatch();
      state.report = batch.reports.join('\n\n') + '\n\n\u8D26\u6237\u6279\u91CF\u5B8C\u6210\u3002\u672A\u6267\u884C\u8BA1\u5212\uFF1A' +
        (batch.skipped.length ? batch.skipped.map(function (p) { return p.name + '\uFF1A' + p.reason; }).join('\uFF1B') : '\u65E0');
      setPhase('\u5168\u90E8\u5728\u6295\u76F4\u64AD\u8BA1\u5212\u5904\u7406\u5B8C\u6BD5');
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
      setPhase('\u6279\u91CF\u6D41\u7A0B\u56E0\u9875\u9762\u5237\u65B0\u4E2D\u65AD\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5BF9\u5F53\u524D\u8BA1\u5212\uFF0C\u7981\u6B62\u81EA\u52A8\u91CD\u63D0');
      return;
    }
    if (batch.status !== 'navigating') return;
    var target = batch.plans[batch.index];
    if (!target || new URL(location.href).searchParams.get('adId') !== target.id) return;
    try {
      await dismissKnownPromo();
      var current = await waitFor(function () {
        try { return context('creative', true); } catch (_) { return null; }
      }, '\u6279\u91CF\u8BA1\u5212\u7D20\u6750\u9875', 15000);
      if (current.accountId !== batch.account.accountId || current.planId !== target.id ||
          current.planName !== target.name || current.planKind !== 'live') {
        throw new Error('\u6279\u91CF\u8BA1\u5212\u8D26\u6237\u3001\u540D\u79F0\u6216 ID \u4E0D\u5339\u914D');
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
      setPhase('\u6279\u91CF\u4E2D\u65AD\uFF1A' + error.message);
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
      if (!pending.length) throw new Error('\u5F53\u524D\u8BA1\u5212\u6CA1\u6709\u5F85\u6838\u67E5\u7684\u811A\u672C\u63D0\u4EA4\u8BB0\u5F55');
      state.config.accountId = current.accountId;
      state.config.accountName = current.accountName;
      state.config.planId = current.planId;
      state.config.planName = current.planName;
      state.config.planKind = current.planKind;
      var run = pending[pending.length - 1];
      state.currentRun = run;
      setPhase('\u53EA\u91CD\u65B0\u6838\u67E5\u8C03\u63A7\u4EFB\u52A1\uFF0C\u4E0D\u63D0\u4EA4\u7D20\u6750');
      var allGood = await verifyTasks(false);
      run.verifyDeferred = false;
      run.status = allGood ? 'verified' : 'needs_review';
      saveJournal();
      state.report = makeReport(run);
      setPhase(allGood ? '\u6838\u67E5\u5B8C\u6210\uFF1B\u672A\u65B0\u589E\u8FFD\u6295\u4EFB\u52A1' : '\u6838\u67E5\u672A\u901A\u8FC7\uFF1B\u672A\u65B0\u589E\u8FFD\u6295\u4EFB\u52A1');
    } catch (error) {
      if (state.currentRun) state.report = makeReport(state.currentRun);
      setPhase('\u91CD\u65B0\u6838\u67E5\u505C\u6B62\uFF1A' + error.message);
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
    run.stopReason = '\u7B2C' + page + '\u9875\u6570\u636E\u672A\u5C31\u7EEA\uFF0C\u6B63\u5728\u5237\u65B0\u5E76\u8FD4\u56DE\u539F\u7D20\u6750\u9875';
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
    addLog('\u7B2C' + page + '\u9875 ROI/\u8FFD\u6295\u72B6\u6001\u672A\u5C31\u7EEA\uFF1B\u5DF2\u4FDD\u5B58\u672C\u8F6E' + run.groups.length +
      '\u7EC4\u63D0\u4EA4\u8BB0\u5F55\uFF0C\u5237\u65B0\u540E\u8FD4\u56DE\u8BE5\u9875\u81EA\u52A8\u7EE7\u7EED\uFF08\u672C\u9875\u7B2C' + attempts[page] + '\u6B21\uFF09');
    setPhase('\u5237\u65B0\u5343\u5DDD\u9875\u9762\u5E76\u6062\u590D\u7B2C' + page + '\u9875');
    location.reload();
    return true;
  }

  async function resumeAfterDataRefresh(checkpoint) {
    var run = journal.runs.find(function (item) { return item.id === checkpoint.runId; });
    try {
      if (!run || run.status !== 'refreshing' || Date.now() - checkpoint.createdAt > 5 * 60 * 1000 ||
          !Number.isInteger(checkpoint.page) || checkpoint.page < 1 || checkpoint.page > 300) {
        throw new Error('\u5237\u65B0\u6062\u590D\u8BB0\u5F55\u5DF2\u5931\u6548');
      }
      var savedUrl = new URL(checkpoint.url);
      var currentUrl = new URL(location.href);
      if (currentUrl.origin !== savedUrl.origin || currentUrl.pathname !== savedUrl.pathname ||
          currentUrl.searchParams.get('aavid') !== checkpoint.accountId ||
          currentUrl.searchParams.get('adId') !== checkpoint.planId ||
          currentUrl.searchParams.get('dateRange') !== savedUrl.searchParams.get('dateRange')) {
        throw new Error('\u5237\u65B0\u540E\u7F51\u5740\u7684\u8D26\u6237\u3001\u8BA1\u5212\u6216\u6570\u636E\u65E5\u671F\u5DF2\u6539\u53D8');
      }
      if (!checkpoint.viewport) throw new Error('\u5237\u65B0\u524D\u7A97\u53E3\u5C3A\u5BF8\u8BB0\u5F55\u7F3A\u5931');
      state.viewportLock = checkpoint.viewport;
      if (viewportChanged()) throw new Error('\u5237\u65B0\u540E\u6D4F\u89C8\u5668\u7A97\u53E3\u3001\u5C4F\u5E55\u5206\u8FA8\u7387\u6216\u7F29\u653E\u6BD4\u4F8B\u5DF2\u6539\u53D8');
      state.config = Object.assign({}, checkpoint.config);
      state.config.dryRun = false;
      state.currentRun = run;
      state.logs = (run.logs || []).slice(-60);
      state.busy = true;
      state.stopRequested = false;
      setPhase('\u5237\u65B0\u540E\u6062\u590D\u539F\u76F4\u64AD\u8BA1\u5212\u7D20\u6750\u9875');
      await dismissKnownPromo();
      var current = await waitFor(function () {
        try { return context(null, true); } catch (_) { return null; }
      }, '\u5237\u65B0\u540E\u7684\u76F4\u64AD\u8BA1\u5212\u8BE6\u60C5', 30000);
      if (current.accountId !== checkpoint.accountId || current.planId !== checkpoint.planId ||
          current.planName !== checkpoint.planName || current.planKind !== 'live') {
        throw new Error('\u5237\u65B0\u540E\u7684\u8D26\u6237\u6216\u76F4\u64AD\u8BA1\u5212\u4E0E\u539F\u8FD0\u884C\u4E0D\u4E00\u81F4');
      }
      var creativeTab = unique(current.drawer.querySelectorAll('[id$="-tab-creative"]'), '\u76F4\u64AD\u7D20\u6750\u6807\u7B7E');
      if (creativeTab.getAttribute('aria-selected') !== 'true') await safeClick(creativeTab, '\u8FD4\u56DE\u7D20\u6750\u6807\u7B7E');
      current = context(null, true);
      var videoTab = unique(Array.from(current.drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .filter(function (el) { return exactText(el) === '\u89C6\u9891'; }), '\u76F4\u64AD\u89C6\u9891\u6807\u7B7E');
      if (!videoTab.className.includes('--checked')) await safeClick(videoTab, '\u8FD4\u56DE\u89C6\u9891\u7D20\u6750');
      await waitFor(function () {
        try { return context('creative', true); } catch (_) { return null; }
      }, '\u5237\u65B0\u540E\u7684\u76F4\u64AD\u89C6\u9891\u7D20\u6750\u9875', 15000);
      validateConfig();
      await ensureSourceFilter();
      await ensurePageSize(100);
      await ensureSort(state.config.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4');
      var page = pageNumber(context('creative').drawer);
      if (page > checkpoint.page) {
        var footer = materialPagination(context('creative').drawer);
        var first = unique(Array.from(footer.querySelectorAll('li.main-vmok-plugin-page-turner__item'))
          .filter(function (el) { return exactText(el) === '1'; }), '\u7D20\u6750\u7B2C1\u9875');
        await safeClick(first, '\u8FD4\u56DE\u7D20\u6750\u7B2C1\u9875');
        await waitFor(function () { return pageNumber(context('creative').drawer) === 1; }, '\u8FD4\u56DE\u7D20\u6750\u7B2C1\u9875', 10000);
        page = 1;
      }
      while (page < checkpoint.page) {
        if (!await nextPage()) throw new Error('\u65E0\u6CD5\u8FD4\u56DE\u5237\u65B0\u524D\u7684\u7B2C' + checkpoint.page + '\u9875');
        page = pageNumber(context('creative').drawer);
      }
      if (page !== checkpoint.page) throw new Error('\u5237\u65B0\u540E\u7D20\u6750\u9875\u7801\u4E0E\u539F\u8FD0\u884C\u4E0D\u4E00\u81F4');
      var ready = await waitForLiveStatusPage();
      if (selectedCount(ready.drawer) !== 0 || ready.rows.some(function (item) { return item.check.checked; })) {
        throw new Error('\u5237\u65B0\u540E\u7D20\u6750\u9875\u5B58\u5728\u52FE\u9009\uFF0C\u7981\u6B62\u81EA\u52A8\u7EE7\u7EED');
      }
      if (run.groups.some(function (group) { return !group.uiSuccess; })) {
        throw new Error('\u672C\u8F6E\u6709\u63D0\u4EA4\u7ED3\u679C\u4E0D\u660E\u7684\u7EC4\uFF0C\u7981\u6B62\u81EA\u52A8\u7EE7\u7EED');
      }
      assertViewport();
      if (state.stopRequested) throw new Error(state.stopMessage);
      GM_setValue(REFRESH_KEY, null);
      sessionStorage.removeItem(REFRESH_TAB_KEY);
      run.status = 'running';
      run.stopReason = '';
      saveJournal();
      if (checkpoint.batch) {
        if (!state.batch || state.batch.status !== 'refreshing') throw new Error('\u76F4\u64AD\u6279\u91CF\u8BB0\u5F55\u65E0\u6CD5\u5339\u914D\u5237\u65B0\u6062\u590D');
        state.batch.status = 'running';
        saveBatch();
      }
      addLog('\u5DF2\u8FD4\u56DE\u7B2C' + page + '\u9875\u5E76\u786E\u8BA4\u6570\u636E\u5C31\u7EEA\uFF1B\u6CBF\u7528\u672C\u8F6E\u5DF2\u63D0\u4EA4\u7D20\u6750 ID \u81EA\u52A8\u7EE7\u7EED');
      state.busy = false;
      state.viewportLock = null;
      state.currentRun = null;
      state.resumeRun = run;
      state.batchRunActive = !!checkpoint.batch;
      render();
      await start();
      if (!state.refreshing && run.status === 'running') {
        throw new Error('\u5237\u65B0\u540E\u81EA\u52A8\u7EE7\u7EED\u672A\u5B8C\u6210\uFF0C\u5DF2\u505C\u6B62\u672C\u8F6E');
      }
      state.batchRunActive = false;
    } catch (error) {
      GM_setValue(REFRESH_KEY, null);
      sessionStorage.removeItem(REFRESH_TAB_KEY);
      if (run) {
        run.status = 'needs_review';
        run.verifyDeferred = run.groups.length > 0;
        run.stopReason = '\u5237\u65B0\u540E\u6062\u590D\u5931\u8D25\uFF1A' + error.message;
        saveJournal();
        state.report = makeReport(run);
      }
      if (checkpoint.batch && state.batch) {
        state.batch.status = 'needs_review';
        saveBatch();
      }
      setPhase('\u5237\u65B0\u6062\u590D\u505C\u6B62\uFF1A' + error.message);
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
    try { readFormSnapshot(); } catch (error) { setPhase('\u5F00\u59CB\u524D\u68C0\u67E5\u5931\u8D25\uFF1A' + error.message); return; }
    state.busy = true;
    state.stopRequested = false;
    state.stopMessage = '\u7528\u6237\u5DF2\u8BF7\u6C42\u505C\u6B62';
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
        await ensureSort(state.config.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4');
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
        bid: cfg.planKind === 'live' && cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' ? cfg.bid : null,
        liveRoiTarget: cfg.planKind === 'live' && cfg.liveGoal === '\u7EFC\u5408\u8425\u9500ROI' ? Number(cfg.liveRoiTarget) : null,
        liveGoal: cfg.planKind === 'live' ? cfg.liveGoal : null,
        liveGender: cfg.planKind === 'live' ? cfg.liveGender : null,
        skipControlling: cfg.planKind === 'live' ? cfg.skipControlling : false,
        mode: cfg.mode,
        groupSize: cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize,
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
          throw new Error('\u5237\u65B0\u540E\u7684\u672C\u8F6E\u8FFD\u6295\u8BB0\u5F55\u65E0\u6CD5\u5B89\u5168\u7EED\u8DD1');
        }
        state.resumeRun = null;
        addLog('\u5237\u65B0\u540E\u6062\u590D\u540C\u4E00\u8F6E\u8FFD\u6295\uFF1B\u5DF2\u6392\u9664\u5148\u524D\u6210\u529F\u7684' +
          run.groups.reduce(function (sum, group) { return sum + group.count; }, 0) + '\u6761\u7D20\u6750');
      } else journal.runs.push(run);
      saveJournal();
      setPhase('\u8BBE\u7F6E\u7D20\u6750\u7B5B\u9009\u548C\u6392\u5E8F');
      await ensureSourceFilter();
      await ensurePageSize(cfg.mode === 'roi' ? roiPageSize() : (cfg.planKind === 'live' ? 100 : 20));
      await ensureSort(cfg.mode === 'roi' ? '\u7EFC\u5408\u8425\u9500ROI' : '\u521B\u5EFA\u65F6\u95F4');
      rowsNow();
      setPhase('\u9010\u9875\u8FFD\u6295');
      try {
        run.stopReason = cfg.mode === 'roi' ? await runRoi() : await runDate();
      } catch (error) {
        if (refreshUnreadyLivePage(run, error)) return;
        run.executionError = true;
        run.stopReason = error.message;
        addLog('\u6267\u884C\u505C\u6B62\uFF1A' + error.message);
      }
      if (run.executionError || run.incomplete) {
        run.status = 'needs_review';
        run.verifyDeferred = run.groups.length > 0;
        if (run.verifyDeferred) addLog('\u8FFD\u6295\u672A\u6B63\u5E38\u7ED3\u675F\uFF1B\u4FDD\u7559\u5F53\u524D\u7D20\u6750\u9875\uFF0C\u4E0D\u81EA\u52A8\u8FDB\u5165\u8C03\u63A7\u6838\u67E5\u3002\u53EF\u624B\u52A8\u53EA\u91CD\u65B0\u6838\u67E5\u672A\u6838\u6E05\u4EFB\u52A1');
      } else if (run.groups.length) {
        setPhase('\u7EDF\u4E00\u6838\u67E5\u8C03\u63A7\u2192\u7D20\u6750\u8FFD\u6295');
        try {
          var allGood = await verifyTasks(true);
          run.status = allGood ? 'verified' : 'needs_review';
        } catch (verifyError) {
          run.status = 'needs_review';
          run.stopReason += '\uFF1B\u4EFB\u52A1\u6838\u67E5\u5931\u8D25\uFF1A' + verifyError.message;
          addLog('\u4EFB\u52A1\u6838\u67E5\u5931\u8D25\uFF1A' + verifyError.message);
        }
      } else {
        run.status = 'stopped_without_submit';
      }
      saveJournal();
      state.report = makeReport(run);
      setPhase(run.verifyDeferred ? '\u5DF2\u505C\u6B62\uFF1B\u672A\u81EA\u52A8\u6838\u67E5\uFF0C\u8BF7\u67E5\u770B\u62A5\u544A' :
        (run.status === 'verified' ? '\u5DF2\u5B8C\u6210\u5E76\u6838\u67E5' : '\u5DF2\u505C\u6B62\uFF0C\u8BF7\u67E5\u770B\u62A5\u544A'));
    } catch (error) {
      if (state.currentRun) {
        state.currentRun.status = 'needs_review';
        state.currentRun.stopReason = error.message;
        saveJournal();
        state.report = makeReport(state.currentRun);
      }
      setPhase('\u5DF2\u505C\u6B62\uFF1A' + error.message);
      addLog('\u5B89\u5168\u505C\u6B62\uFF1A' + error.message);
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

  const launcherPlacement = createAndroidLauncherPosition(shadow, LAUNCHER_TOP_KEY, 1);

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
      '<button class="launcher" id="launch" title="\u70B9\u51FB\u5C55\u5F00\uFF0C\u62D6\u52A8\u53EF\u8C03\u6574\u4F4D\u7F6E" aria-label="\u5C55\u5F00\u5343\u5DDD\u8FFD\u6295\u52A9\u624B" style="display:', state.open === false ? 'block' : 'none', ';top:', esc(state.launcherTop), '%">\u8FFD\u6295\u52A9\u624B</button>',
      '<div class="panel" style="display:', state.open === false ? 'none' : 'flex', '">',
      '<div class="head"><strong>\u5343\u5DDD\u7D20\u6750\u8FFD\u6295\u52A9\u624B v0.4.37</strong><button id="close" title="\u6700\u5C0F\u5316" aria-label="\u6700\u5C0F\u5316\u52A9\u624B">\u2212</button></div>',
      '<div class="body">',
      '<div class="card"><div class="muted">\u9501\u5B9A\u8D26\u6237 / ', cfg.planKind === 'live' ? '\u63A8\u76F4\u64AD\u95F4\u8BA1\u5212' : '\u5546\u54C1\u81EA\u9009\u8BA1\u5212', '</div>',
      '<strong>', esc(cfg.accountName || '\u5C1A\u672A\u9501\u5B9A'), '</strong><br>',
      esc(cfg.accountId || '\u8D26\u6237 ID \u5F85\u8BFB\u53D6'), '<br>',
      '<strong>', esc(cfg.planName || '\u8BA1\u5212\u5F85\u8BFB\u53D6'), '</strong><br>',
      esc(cfg.planId || '\u8BA1\u5212 ID \u5F85\u8BFB\u53D6'), '<br>',
      '<button class="btn" id="capture" style="margin-top:7px">\u9501\u5B9A\u5F53\u524D\u7D20\u6750\u9875\u8BA1\u5212</button></div>',
      cfg.planKind === 'live' && location.pathname === '/overall-prom' ?
        '<div class="card"><strong>\u8D26\u6237\u5185\u5168\u90E8\u5728\u6295\u76F4\u64AD\u8BA1\u5212</strong><div class="small">\u6F14\u7EC3\u53EA\u626B\u63CF\u8BA1\u5212\u5217\u8868\uFF1B\u5173\u95ED\u6F14\u7EC3\u540E\u9010\u6761\u5904\u7406\u5168\u90E8\u5728\u6295\u76F4\u64AD\u8BA1\u5212\u3002\u6BCF\u8BA1\u5212\u72EC\u7ACB\u8BA1\u7EC4\u6570\uFF1B\u5F02\u5E38\u65F6\u505C\u6B62\u6279\u91CF\u6D41\u7A0B\u3002</div><button class="btn primary" id="batch-start" style="width:100%;margin-top:7px">' +
        (cfg.dryRun ? '\u626B\u63CF\u5168\u90E8\u5728\u6295\u76F4\u64AD\u8BA1\u5212\uFF08\u4E0D\u63D0\u4EA4\uFF09' : '\u5F00\u59CB\u5168\u90E8\u5728\u6295\u76F4\u64AD\u8BA1\u5212\u8FFD\u6295') + '</button></div>' : '',
      state.batch && state.batch.status !== 'complete' ?
        '<div class="card"><strong>\u76F4\u64AD\u6279\u91CF\u8FDB\u5EA6\uFF1A</strong>' + esc(state.batch.status) + '\uFF0C\u7B2C' +
        esc((state.batch.index || 0) + 1) + '/' + esc(state.batch.plans.length) + '\u6761\u8BA1\u5212\u3002' +
        '<div class="small warn">\u4E2D\u65AD\u540E\u8BF7\u5148\u6838\u5BF9\u8C03\u63A7\u4EFB\u52A1\u3002\u7ED3\u675F\u8BB0\u5F55\u4EC5\u505C\u6B62\u81EA\u52A8\u7EED\u8DD1\u3002</div>' +
        '<button class="btn danger" id="batch-reset">\u7ED3\u675F\u672A\u5B8C\u6210\u6279\u91CF\u6D41\u7A0B</button></div>' : '',
      '<div class="section">\u6267\u884C\u903B\u8F91</div><div class="tabs">',
      '<button class="tab ', cfg.mode === 'roi' ? 'on' : '', '" id="mode-roi">\u6309 ROI \u8FFD\u6295</button>',
      '<button class="tab ', cfg.mode === 'date' ? 'on' : '', '" id="mode-date">\u6309\u521B\u5EFA\u65E5\u671F\u8FFD\u6295</button></div>',
      '<div class="card" style="margin-top:9px">',
      cfg.mode === 'roi' ?
        ((cfg.planKind === 'live' ? '\u76F4\u64AD\u89C6\u9891' : '\u81EA\u9009\u6295\u653E\u7D20\u6750') + ' \u00B7 \u7EFC\u5408\u8425\u9500 ROI \u964D\u5E8F \u00B7 ' + roiPageSize() + ' \u6761/\u9875\u3002' +
          (cfg.roiStrategy === 'strict' ? '\u53EA\u9009 ROI\u2265' + cfg.roiThreshold + ' \u7684\u7D20\u6750\uFF1B\u5C3E\u7EC4\u8FBE\u5230' + (cfg.planKind === 'live' ? cfg.tailMin : 1) + '\u6761\u624D\u63D0\u4EA4\u3002' :
            '\u9996\u6B21\u9047\u5230 ROI\uFF1C' + cfg.roiThreshold + ' \u65F6\uFF0C\u51D1\u6EE1\u5F53\u524D\u7EC4\u63D0\u4EA4\u540E\u505C\u6B62\uFF1B\u8BE5\u7EC4\u53EF\u80FD\u5305\u542B\u4F4E\u4E8E\u9608\u503C\u7684\u7D20\u6750\u3002')) :
        ((cfg.planKind === 'live' ? '\u76F4\u64AD\u89C6\u9891' : '\u81EA\u9009\u6295\u653E\u7D20\u6750') + ' \u00B7 \u521B\u5EFA\u65F6\u95F4\u964D\u5E8F \u00B7 ' + (cfg.planKind === 'live' ? 100 : 20) + ' \u6761/\u9875\u3002\u53EA\u9009\u8D77\u59CB\u65E5\u81F3\u7ED3\u675F\u65E5\uFF08\u542B\u4E24\u7AEF\uFF09\u5185\u521B\u5EFA\u7684\u7D20\u6750\uFF1B\u6BCF ' + cfg.dateGroupSize + ' \u6761\u4E00\u7EC4\uFF0C\u5C3E\u7EC4\u81F3\u5C11 ' + cfg.tailMin + ' \u6761\u624D\u63D0\u4EA4\u3002'),
      '</div>',
      cfg.mode === 'date' ? [
        '<div class="grid"><label class="field">\u521B\u5EFA\u65E5\u671F\u4ECE\uFF08\u542B\uFF09<input id="start-date" type="date" value="', esc(cfg.startDate), '"></label>',
        '<label class="field">\u521B\u5EFA\u65E5\u671F\u5230\uFF08\u542B\uFF09<input id="end-date" type="date" value="', esc(cfg.endDate), '"></label></div>',
        '<div class="small">\u6309\u521B\u5EFA\u65F6\u95F4\u964D\u5E8F\u626B\u63CF\uFF1B\u9047\u5230\u65E9\u4E8E\u201C\u4ECE\u201D\u65E5\u671F\u7684\u7D20\u6750\u5373\u505C\u6B62\u3002\u53EA\u8FFD\u6295\u4E00\u5929\u65F6\uFF0C\u4E24\u4E2A\u65E5\u671F\u586B\u540C\u4E00\u5929\u3002</div>'
      ].join('') : [
        '<div class="grid"><label class="field">ROI \u9608\u503C\uFF08\u542B\u7B49\u4E8E\uFF09<input id="roi-threshold" type="number" min="0" max="1000" step="0.01" value="', esc(cfg.roiThreshold), '"></label>',
        cfg.planKind === 'live' ? '<div class="field">\u8FFD\u6295\u7B56\u7565<br><strong>\u4E25\u683C\u53EA\u8FFD\u6295\u8FBE\u6807\u7D20\u6750</strong></div>' :
          '<label class="field">\u8FFD\u6295\u7B56\u7565<select id="roi-strategy">' +
          '<option value="whole_group" ' + (cfg.roiStrategy === 'whole_group' ? 'selected' : '') + '>\u8DE8\u9608\u503C\u6574\u7EC4\u540E\u505C\u6B62</option>' +
          '<option value="strict" ' + (cfg.roiStrategy === 'strict' ? 'selected' : '') + '>\u4E25\u683C\u53EA\u8FFD\u6295\u8FBE\u6807\u7D20\u6750</option></select></label>', '</div>',
        cfg.planKind !== 'live' && cfg.roiStrategy === 'whole_group' ? [
          '<label class="field">\u9047\u5230 ROI \u201C\u2014\u201D\u4E14\u672C\u7EC4\u5C1A\u672A\u8DE8\u9608\u503C\u65F6',
          '<select id="dash-policy"><option value="pause" ', cfg.dashPolicy === 'pause' ? 'selected' : '', '>\u6682\u505C\u5E76\u53CD\u9988\uFF08\u9ED8\u8BA4\uFF09</option>',
          '<option value="below" ', cfg.dashPolicy === 'below' ? 'selected' : '', '>\u89C6\u4E3A\u4F4E\u4E8E\u9608\u503C\uFF0C\u6574\u7EC4\u63D0\u4EA4\u540E\u505C\u6B62</option></select></label>'
        ].join('') : '<div class="small">\u4E25\u683C\u6A21\u5F0F\u9047\u5230 ROI \u201C\u2014\u201D\u4F1A\u505C\u6B62\uFF0C\u4E0D\u4F1A\u8FFD\u6295\u8BE5\u6761\u53CA\u540E\u7EED\u7D20\u6750\u3002</div>'
      ].join(''),
      '<div class="section">\u8FFD\u6295\u53C2\u6570</div><div class="grid">',
      '<label class="field">', cfg.planKind === 'live' ? '\u8C03\u63A7\u65E5\u9884\u7B97' : '\u5355\u7EC4\u9884\u7B97', '\uFF08\u5143\uFF09<input id="budget" type="number" min="100" max="500" step="1" value="', esc(cfg.budget), '"></label>',
      cfg.planKind === 'live' ? (cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' ?
        '<label class="field">\u6211\u7684\u51FA\u4EF7\uFF08\u5143/\u6210\u4EA4\uFF09<input id="bid" type="number" min="0.01" max="1000" step="0.01" value="' + esc(cfg.bid) + '"></label>' :
        '<label class="field">\u7EFC\u5408\u8425\u9500ROI\u76EE\u6807<input id="live-roi-target" type="number" min="0.01" max="1000" step="0.01" value="' + esc(cfg.liveRoiTarget) + '"></label>') :
        '<label class="field">\u65F6\u957F\uFF08\u5C0F\u65F6\uFF09<input id="hours" type="number" min="0.5" max="24" step="0.5" value="' + esc(cfg.hours) + '"></label>',
      '<label class="field">\u672C\u8F6E\u6700\u591A\u521B\u5EFA\u7EC4\u6570<input id="max-groups" type="number" min="1" max="', cfg.planKind === 'live' ? MAX_LIVE_GROUPS : MAX_PRODUCT_GROUPS, '" step="1" value="', esc(cfg.maxGroups), '"></label>',
      '<label class="field">\u6BCF\u7EC4\u89C6\u9891\u6570\u91CF\uFF08\u6761\uFF09<input id="group-size" type="number" min="1" max="20" step="1" value="', esc(cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize), '"></label>',
      cfg.planKind === 'live' ? '<label class="field">\u6700\u7EC8\u9875/\u505C\u6B62\u70B9\u5C3E\u7EC4\u6700\u4F4E\u6570\u91CF<input id="tail-min" type="number" min="1" max="20" step="1" value="' + esc(cfg.tailMin) + '"></label>' : '',
      '<div class="field">\u5141\u8BB8\u5DF2\u8FFD\u6295\u7D20\u6750<br><strong>\u662F</strong></div></div>',
      cfg.planKind === 'live' ?
        '<div class="small">\u76F4\u64AD\u7D20\u6750\u53EA\u9009\u5BA1\u6838\u901A\u8FC7\u7684\u7D20\u6750\uFF0C\u8DF3\u8FC7\u5DF2\u6682\u505C\u548C\u5BA1\u6838\u4E0D\u901A\u8FC7\uFF1B\u6574\u7EC4\u52FE\u9009\u540E\u518D\u6B21\u7B49\u5F85\u5217\u8868\u7A33\u5B9A\uFF0C\u53D6\u6D88\u72B6\u6001\u53D8\u5316\u7684\u7D20\u6750\u5E76\u4ECE\u540E\u9762\u8865\u9009\uFF0C\u590D\u6838\u901A\u8FC7\u624D\u63D0\u4EA4\u3002</div>' :
        '<div class="small">\u63A8\u5546\u54C1\u6309 ROI \u6216\u521B\u5EFA\u65E5\u671F\u9009\u81EA\u9009\u6295\u653E\u7D20\u6750\uFF0C\u4E0D\u56E0\u5BA1\u6838\u72B6\u6001\u4E3A\u7A7A\u6216\u4E0D\u901A\u8FC7\u800C\u53D6\u6D88\u52FE\u9009\uFF1B\u63D0\u4EA4\u524D\u4ECD\u6838\u5BF9\u52FE\u9009\u6570\u91CF\u3001\u7D20\u6750 ID \u548C\u5E73\u53F0\u5F39\u7A97\u5B9E\u9645\u63A5\u6536\u6E05\u5355\u3002</div>',
      cfg.planKind === 'live' ? [
        '<div class="card">\u8FFD\u6295\u65B9\u5F0F\uFF1A\u63A7\u6210\u672C\u8FFD\u6295\u3002<div class="grid">',
        '<label class="field">\u4F18\u5316\u76EE\u6807<select id="live-goal">',
        '<option value="\u76F4\u64AD\u95F4\u6210\u4EA4" ', cfg.liveGoal === '\u76F4\u64AD\u95F4\u6210\u4EA4' ? 'selected' : '', '>\u76F4\u64AD\u95F4\u6210\u4EA4</option>',
        '<option value="\u7EFC\u5408\u8425\u9500ROI" ', cfg.liveGoal === '\u7EFC\u5408\u8425\u9500ROI' ? 'selected' : '', '>\u7EFC\u5408\u8425\u9500ROI</option></select></label>',
        '<label class="field">\u5B9A\u5411\u6027\u522B<select id="live-gender">',
        '<option value="\u4E0D\u9650" ', cfg.liveGender === '\u4E0D\u9650' ? 'selected' : '', '>\u4E0D\u9650</option>',
        '<option value="\u7537" ', cfg.liveGender === '\u7537' ? 'selected' : '', '>\u7537</option>',
        '<option value="\u5973" ', cfg.liveGender === '\u5973' ? 'selected' : '', '>\u5973</option></select></label></div>',
        '<label class="row"><input id="skip-controlling" type="checkbox" ', cfg.skipControlling ? 'checked' : '', '> \u8DF3\u8FC7\u201C\u7D20\u6750\u8FFD\u6295\u201D\u5217\u663E\u793A\u8C03\u63A7\u4E2D\u7684\u7D20\u6750</label>',
        '<div class="small">\u76F4\u64AD\u6BCF\u9875100\u6761\uFF1B\u540C\u9875\u51D1\u7EC4\u5E76\u63D0\u4EA4\uFF0C\u7FFB\u9875\u4E0D\u643A\u5E26\u52FE\u9009\u3002\u6709\u4E0B\u4E00\u9875\u65F6\uFF0C\u672C\u9875\u5269\u4F59\u5408\u683C\u7D20\u6750\u4F1A\u5355\u72EC\u63D0\u4EA4\u4E00\u7EC4\uFF08\u5373\u4F7F\u4F4E\u4E8E\u5C3E\u7EC4\u6700\u4F4E\u6570\u91CF\uFF09\uFF0C\u518D\u7FFB\u9875\u7EE7\u7EED\u3002\u6570\u636E\u7B49\u5F8530\u79D2\u4ECD\u672A\u5C31\u7EEA\u65F6\uFF0C\u6BCF\u9875\u6700\u591A\u81EA\u52A8\u5237\u65B0\u4E00\u6B21\uFF0C\u8FD4\u56DE\u539F\u9875\u5E76\u6CBF\u7528\u672C\u8F6E\u7D20\u6750ID\u7EE7\u7EED\u3002</div></div>'
      ].join('') : '',
      '<div class="card" id="quantity-preview">\u672C\u8F6E\u6700\u591A ', esc(cfg.maxGroups), ' \u7EC4 \u00D7 \u6BCF\u7EC4 ',
      esc(cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize), ' \u6761 = \u6700\u591A ',
      esc(cfg.maxGroups * (cfg.mode === 'roi' ? cfg.roiGroupSize : cfg.dateGroupSize)), ' \u6761\u7D20\u6750\u3002</div>',
      '<div class="small">\u53EF\u518D\u6B21\u6267\u884C\u540C\u4E00\u8BA1\u5212\uFF1B\u672C\u5730\u5386\u53F2\u63D0\u4EA4\u8BB0\u5F55\u4EC5\u7528\u4E8E\u6838\u67E5\uFF0C\u4E0D\u963B\u6B62\u65B0\u4E00\u8F6E\u521B\u5EFA\u3002\u5343\u5DDD\u660E\u786E\u63D0\u793A\u201C\u64CD\u4F5C\u5931\u8D25\u201D\u4E14\u539F\u5F39\u7A97\u3001\u7D20\u6750\u548C\u53C2\u6570\u4E0D\u53D8\u65F6\uFF0C\u53EA\u91CD\u8BD5\u63D0\u4EA4\u4E00\u6B21\uFF1B\u7ED3\u679C\u4E0D\u660E\u6216\u8D85\u65F6\u4ECD\u4F1A\u505C\u6B62\u3002</div>',
      '<div class="small">\u6B63\u5E38\u8FFD\u6295\u7ED3\u675F\u540E\u7EDF\u4E00\u8FDB\u5165\u8C03\u63A7\u9875\u6838\u67E5\uFF1B\u4E2D\u9014\u5F02\u5E38\u6216\u624B\u52A8\u505C\u6B62\u65F6\u7559\u5728\u7D20\u6750\u9875\uFF0C\u5F85\u624B\u52A8\u6838\u67E5\uFF0C\u4E0D\u81EA\u52A8\u91CD\u63D0\u3002</div>',
      '<div class="hint">\u63A8\u5546\u54C1\u7FFB\u9875\u524D\u5148\u63D0\u4EA4\u672C\u9875\u4F59\u91CF\uFF0C\u518D\u6E05\u7A7A\u52FE\u9009\u5E76\u7FFB\u9875\uFF1B\u4E0D\u8DB3\u8BBE\u5B9A\u6761\u6570\u4E5F\u4F1A\u5355\u72EC\u6210\u7EC4\uFF0C\u9884\u7B97\u4ECD\u6309\u5355\u7EC4\u8BBE\u7F6E\uFF0C\u5E76\u8BA1\u5165\u7EC4\u6570\u4E0A\u9650\u3002</div>',
      '<label class="row"><input id="dry-run" type="checkbox" ', cfg.dryRun ? 'checked' : '', '> \u6F14\u7EC3\u6A21\u5F0F\uFF1A\u53EA\u68C0\u67E5\u5F53\u524D\u9875\uFF0C\u52FE\u9009\u6700\u591A\u4E00\u7EC4\uFF0C\u4E0D\u63D0\u4EA4</label>',
      '<div class="small warn">\u6B63\u5F0F\u6267\u884C\u4EC5\u9650\u5F53\u524D\u9501\u5B9A\u8BA1\u5212\u3002\u6F14\u7EC3\u52FE\u9009\u4F1A\u5728\u6B63\u5F0F\u5F00\u59CB\u524D\u6838\u5BF9\u5E76\u6E05\u9664\uFF1B\u8FD0\u884C\u4E2D\u4E0D\u64CD\u4F5C\u539F\u8BA1\u5212\u9884\u7B97\u3001ROI \u76EE\u6807\u548C\u6295\u653E\u72B6\u6001\u3002</div>',
      '<div class="buttons"><button class="btn primary" id="start" ', state.busy ? 'disabled' : '', '>',
      cfg.dryRun ? '\u68C0\u67E5\u5E76\u52FE\u9009\u4E00\u7EC4\uFF08\u4E0D\u63D0\u4EA4\uFF09' : '\u5F00\u59CB\u8FFD\u6295\u5E76\u63D0\u4EA4', '</button>',
      '<button class="btn danger" id="stop" ', state.busy ? '' : 'disabled', '>\u505C\u6B62</button></div>',
      '<button class="btn" id="recheck" style="width:100%;margin-top:8px" ', state.busy ? 'disabled' : '', '>\u53EA\u91CD\u65B0\u6838\u67E5\u672A\u6838\u6E05\u4EFB\u52A1\uFF08\u4E0D\u63D0\u4EA4\uFF09</button>',
      '<div class="section">\u6267\u884C\u72B6\u6001</div><div class="status">', esc(status), '</div>',
      '<div class="section">\u6267\u884C\u8BB0\u5F55</div><div class="log">', logs || '\u6682\u65E0\u8BB0\u5F55', '</div>',
      state.report ? '<div class="section">\u7ED3\u679C\u62A5\u544A</div><div class="report">' + esc(state.report) + '</div><button class="btn" id="copy" style="margin-top:7px">\u590D\u5236\u62A5\u544A</button>' : '',
      '</div></div>'
    ].join('');
    shadow.innerHTML = html;
    var newBody = shadow.querySelector('.body');
    if (newBody) newBody.scrollTop = bodyScrollTop;
    launcherPlacement.bind(shadow.getElementById('launch'), () => { state.open = true; render(); });
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
      setPhase('\u5DF2\u7ED3\u675F\u6279\u91CF\u81EA\u52A8\u7EED\u8DD1\uFF1B\u672A\u63D0\u4EA4\u65B0\u4EFB\u52A1');
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
          '\u672C\u8F6E\u6700\u591A ' + groups + ' \u7EC4 \u00D7 \u6BCF\u7EC4 ' + size + ' \u6761 = \u6700\u591A ' + (groups * size) + ' \u6761\u7D20\u6750\u3002' :
          '\u8BF7\u586B\u5199\u6709\u6548\u7EC4\u6570\uFF081\u2013' + maxAllowed + '\uFF09\u548C\u6BCF\u7EC4\u89C6\u9891\u6570\u91CF\uFF081\u201320\uFF09\u3002';
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
      state.stopMessage = '\u7528\u6237\u5DF2\u8BF7\u6C42\u505C\u6B62';
      addLog('\u7528\u6237\u8BF7\u6C42\u505C\u6B62\uFF1B\u5F53\u524D\u63D0\u4EA4\u82E5\u5DF2\u70B9\u51FB\uFF0C\u4F1A\u5148\u7B49\u5F85\u7ED3\u679C\u518D\u505C\u6B62');
    };
    var copy = shadow.getElementById('copy');
    if (copy) copy.onclick = function () { GM_setClipboard(state.report, 'text'); addLog('\u62A5\u544A\u5DF2\u590D\u5236'); };
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
    try { currentTabToken = sessionStorage.getItem(REFRESH_TAB_KEY) || ''; } catch (_) { /* \u4E0D\u8DE8\u6807\u7B7E\u9875\u81EA\u52A8\u6062\u590D */ }
    if (currentTabToken && currentTabToken === savedRefresh.tabToken) resumeAfterDataRefresh(savedRefresh);
    else setPhase('\u53E6\u4E00\u5343\u5DDD\u6807\u7B7E\u9875\u6B63\u5728\u6062\u590D\u7D20\u6750\u6570\u636E\uFF1B\u672C\u6807\u7B7E\u9875\u4E0D\u81EA\u52A8\u7EED\u8DD1');
  }
  else if (state.batch && state.batch.status === 'refreshing') {
    state.batch.status = 'needs_review';
    saveBatch();
    setPhase('\u76F4\u64AD\u6279\u91CF\u5237\u65B0\u6062\u590D\u8BB0\u5F55\u7F3A\u5931\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u7EED\u8DD1');
  } else if (state.batch) resumeLiveBatch();
})();
