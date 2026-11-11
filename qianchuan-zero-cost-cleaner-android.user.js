// ==UserScript==
// @name         Qianchuan Zero Cost Material Cleaner (Android)
// @namespace    local.qianchuan.empty-cost-cleaner
// @version      1.1.7
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-android.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-android.user.js
// @description  Android empty-cost cleanup; resume batch deletion after AIGC tagging, with final-row protection.
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
  const SOURCE = '\u81EA\u9009\u6295\u653E';
  const SORT = '\u7EFC\u5408\u6210\u672C(\u5143)';
  const PAGE_SIZE = 20;
  const MAX_QUOTA = 500;
  const QUICK_CLICK = { before: 140, after: 180 };
  const AIGC_WARNING = /\u672C\u7D20\u6750\u751F\u6210\u7684\s*AIGC\s*\u7D20\u6750\u5177\u5907\u8DD1\u91CF\u4F18\u52BF|\u5220\u9664\u53EF\u80FD\u4F1A\u5F71\u54CD\s*AIGC\s*\u6D88\u8017/;
  const ORDINARY_DELETE = /\u786E\u5B9A\u8981\u5220\u9664\u89C6\u9891\u5417[\uFF1F?]?/;
  const cfg = Object.assign({ cutoff: '', quota: 90 }, GM_getValue(SAVED_KEY, {}));
  const state = {
    lock: null, busy: false, stop: false, phase: '\u8BF7\u9501\u5B9A\u5F53\u524D\u5546\u54C1\u6216\u76F4\u64AD\u8BA1\u5212',
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
    if (found.length !== 1) throw new Error(label + '\u5E94\u6070\u597D\u51FA\u73B0\u4E00\u6B21\uFF0C\u5B9E\u9645 ' + found.length + ' \u6B21');
    return found[0];
  }
  function exact(root, selector, value, label) {
    return one(Array.from(root.querySelectorAll(selector)).filter(el => text(el) === value), label || value);
  }
  async function wait(check, label, timeout = 16000, ignoreStop = false) {
    const end = Date.now() + timeout;
    let lastIssue = '';
    while (Date.now() < end) {
      if (state.stop && !ignoreStop) throw new Error('\u7528\u6237\u5DF2\u505C\u6B62');
      try { const answer = check(); if (answer) return answer; } catch (error) { lastIssue = error.message; }
      await sleep(180);
    }
    throw new Error(label + '\u7B49\u5F85\u8D85\u65F6' + (lastIssue ? '\uFF1A' + lastIssue : '') + '\uFF1B\u7ED3\u679C\u672A\u786E\u8BA4\uFF0C\u5DF2\u505C\u6B62\uFF0C\u7981\u6B62\u76F4\u63A5\u91CD\u8BD5\u5220\u9664');
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
    // Android browser bars expand/collapse while scrolling. Revalidate DOM before every
    // action; only a width, scale or physical-screen change invalidates this layout lock.
    if (innerWidth !== v.width || devicePixelRatio !== v.scale ||
      screen.width !== v.screenWidth || screen.height !== v.screenHeight) {
      throw new Error('\u7A97\u53E3\u5927\u5C0F\u3001\u7F29\u653E\u6216\u5C4F\u5E55\u5206\u8FA8\u7387\u5DF2\u6539\u53D8');
    }
  }
  function assertRun() {
    if (state.stop) throw new Error('\u7528\u6237\u5DF2\u505C\u6B62');
    assertViewport();
    context();
  }
  function detectBlock() {
    const words = Array.from(document.querySelectorAll('[role="dialog"], .main-vmok-plugin-modal__wrap'))
      .filter(visible).map(text).join(' ');
    if (/\u9A8C\u8BC1\u7801|\u6ED1\u5757\u9A8C\u8BC1|\u767B\u5F55\u5931\u6548|\u6743\u9650\u4E0D\u8DB3|\u8BBF\u95EE\u53D7\u9650|\u5E73\u53F0\u98CE\u63A7/.test(words)) {
      throw new Error('\u5E73\u53F0\u767B\u5F55\u3001\u9A8C\u8BC1\u3001\u6743\u9650\u6216\u98CE\u63A7\u63D0\u793A');
    }
  }
  function context(ignoreLock = false) {
    detectBlock();
    const url = new URL(location.href);
    const livePlan = url.pathname === '/overall-prom/detail' && url.hash.includes('marGoal=2');
    const productPlan = url.pathname === '/overall-prom' && url.hash.includes('marGoal=1');
    if (url.origin !== 'https://qianchuan.jinritemai.com' || (!livePlan && !productPlan) ||
      url.searchParams.get('campaignType') !== '1' || url.searchParams.get('uniTab') !== 'ad') {
      throw new Error('\u5F53\u524D\u4E0D\u662F\u4E58\u65B9\u5546\u54C1\u6216\u76F4\u64AD\u5728\u6295\u8BA1\u5212\u9875');
    }
    const { accountId, accountName } = readAccountIdentity(url);
    const drawer = one(document.querySelectorAll('.ad-detail-wrapper'), '\u8BA1\u5212\u8BE6\u60C5\u62BD\u5C49');
    const lines = (drawer.innerText || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 12);
    const planName = livePlan ? lines[2] : lines[0];
    const planId = (lines.join('\n').match(livePlan ? /\u8BA1\u5212ID[\uFF1A:]\s*(\d+)/ : /ID[\uFF1A:]\s*(\d+)/) || [])[1];
    if (!accountId || !planId || !planName || url.searchParams.get('aavid') !== accountId ||
      url.searchParams.get('adId') !== planId) throw new Error('\u7F51\u5740\u4E0E\u9875\u9762\u8D26\u6237\u6216\u8BA1\u5212 ID \u4E0D\u4E00\u81F4');
    if (!lines.includes('\u6295\u653E\u4E2D')) throw new Error('\u8BA1\u5212\u72B6\u6001\u4E0D\u662F\u6295\u653E\u4E2D');
    if (!drawer.querySelector('[id$="-tab-creative"][aria-selected="true"]')) throw new Error('\u8BF7\u6253\u5F00\u8BA1\u5212\u7684\u7D20\u6750\u6807\u7B7E');
    if (livePlan) {
      if (lines[0] !== '\u63A8\u76F4\u64AD\u95F4' || !planName || !lines.includes('\u76F4\u64AD\u5927\u5C4F')) {
        throw new Error('\u5F53\u524D\u4E0D\u662F\u63A8\u76F4\u64AD\u95F4\u8BA1\u5212');
      }
      if (!Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-radio-group-item'))
        .some(el => text(el) === '\u89C6\u9891' && el.className.includes('--checked'))) {
        throw new Error('\u8BF7\u6253\u5F00\u76F4\u64AD\u8BA1\u5212\u7684\u201C\u7D20\u6750\u2192\u89C6\u9891\u201D\u9875');
      }
    } else {
      if (!document.querySelector('[id$="-tab-1"][aria-selected="true"]')) throw new Error('\u5F53\u524D\u4E0D\u662F\u5546\u54C1\u81EA\u9009\u8BA1\u5212');
      const active = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map(text);
      const oldSelfSelect = active.includes('\u5546\u54C1\u81EA\u9009');
      const newSelfSelect = active.includes('\u8BA1\u5212\u89C6\u56FE') && Array.from(document.querySelectorAll('label')).some(label =>
        visible(label) && text(label) === '\u5546\u54C1\u81EA\u9009' && label.querySelector('input[type="radio"]')?.checked);
      if (!active.includes('\u5546\u54C1') || !(oldSelfSelect || newSelfSelect)) throw new Error('\u5F53\u524D\u4E0D\u662F\u5546\u54C1\u81EA\u9009\u8BA1\u5212\uFF08\u517C\u5BB9\u8BA1\u5212\u89C6\u56FE\u65B0\u7248\u5165\u53E3\uFF09');
    }
    if (!ignoreLock && (!state.lock || state.lock.accountId !== accountId || state.lock.planId !== planId ||
      state.lock.planName !== planName ||
      state.lock.planKind !== (livePlan ? 'live' : 'product'))) {
      throw new Error('\u8D26\u6237\u6216\u8BA1\u5212\u4E0E\u9501\u5B9A\u5BF9\u8C61\u4E0D\u4E00\u81F4');
    }
    return { drawer, accountId, accountName, planId, planName, planKind: livePlan ? 'live' : 'product' };
  }
  async function click(el, label, beforeClick, pace = { before: 260, after: 480 }) {
    assertRun();
    if (!visible(el)) throw new Error(label + '\u4E0D\u53EF\u89C1');
    const drawer = context().drawer;
    const allowed = drawer.contains(el) || !!el.closest('.main-vmok-plugin-modal__wrap, [role="dialog"], .main-vmok-plugin-oc-popover-text__content, .main-vmok-plugin-popover, .main-vmok-plugin-select__options, .main-vmok-plugin-cascader-panel');
    if (!allowed) throw new Error(label + '\u8D85\u51FA\u5F53\u524D\u7D20\u6750\u64CD\u4F5C\u533A\u57DF');
    phase('\u5373\u5C06\u64CD\u4F5C\uFF1A' + label);
    await sleep(pace.before);
    assertRun();
    if (!visible(el)) throw new Error(label + '\u5728\u64CD\u4F5C\u524D\u6D88\u5931');
    if (beforeClick) beforeClick();
    el.click();
    await sleep(pace.after);
  }
  function sourceChip(drawer) {
    const label = state.lock?.planKind === 'live' ? '\u89C6\u9891\u7C7B\u578B\uFF1A\u81EA\u9009\u6295\u653E\u89C6\u9891' : '\u7D20\u6750\u7C7B\u578B\uFF1A\u81EA\u9009\u6295\u653E';
    return Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-filter-echo-item'))
      .some(el => text(el).replace(/\s+/g, '').includes(label));
  }
  async function ensureFilter() {
    const drawer = context().drawer;
    const live = state.lock.planKind === 'live';
    const field = live ? '\u89C6\u9891\u7C7B\u578B' : '\u7D20\u6750\u7C7B\u578B';
    const optionLabel = live ? '\u81EA\u9009\u6295\u653E\u89C6\u9891' : SOURCE;
    if (sourceChip(drawer)) return;
    const more = one(drawer.querySelectorAll('.main-vmok-plugin-more-filter-btn button'), '\u66F4\u591A\u7B5B\u9009');
    if (!/^\u66F4\u591A\u7B5B\u9009(?:\s*\d+)?$/.test(text(more))) throw new Error('\u66F4\u591A\u7B5B\u9009\u6309\u94AE\u6587\u5B57\u5DF2\u6539\u53D8');
    await click(more, '\u66F4\u591A\u7B5B\u9009');
    const item = await wait(() => Array.from(document.querySelectorAll('.main-vmok-plugin-body-title-item'))
      .filter(visible).find(el => text(el).includes(field)), field + '\u7B5B\u9009');
    const popup = item.closest('.main-vmok-plugin-oc-popover-text__content');
    if (!popup) throw new Error('\u65E0\u6CD5\u5B9A\u4F4D' + field + '\u7B5B\u9009\u9762\u677F');
    const input = one(item.querySelectorAll('input[readonly][placeholder="\u8BF7\u9009\u62E9"]'), field + '\u9009\u62E9\u6846');
    await click(input, field + '\u9009\u62E9\u6846');
    const option = await wait(() => Array.from(document.querySelectorAll('li.main-vmok-plugin-cascader-panel__selection-item'))
      .filter(visible).find(el => text(el) === optionLabel), optionLabel + '\u9009\u9879');
    await click(option, optionLabel);
    await click(exact(popup, 'button', '\u786E\u5B9A', '\u7B5B\u9009\u786E\u5B9A'), '\u7B5B\u9009\u786E\u5B9A');
    await wait(() => sourceChip(context().drawer), field + '\u7B5B\u9009\u751F\u6548');
    log('\u5DF2\u7B5B\u9009' + field + '\uFF1A' + optionLabel);
  }
  function readAccountIdentity(url) {
    var accountId = url.searchParams.get('aavid') || '';
    if (!/^\d+$/.test(accountId)) throw new Error('\u7F51\u5740\u4E2D\u7684\u8D26\u6237 ID \u65E0\u6548');
    // Tablet layouts can hide the account header under the plan drawer.
    // Only use visible headers as page evidence; never select a stale hidden header.
    var headers = Array.from(document.querySelectorAll('.account-info-box')).filter(visible);
    var names = [];
    headers.forEach(function (el) {
      var accountText = text(el);
      var match = accountText.match(/ID[\uFF1A:]\s*(\d+)/);
      if (!match) throw new Error('\u9875\u9762\u8D26\u6237 ID \u5C1A\u672A\u52A0\u8F7D\u5B8C\u6574');
      if (match[1] !== accountId) throw new Error('\u7F51\u5740\u4E0E\u9875\u9762\u8D26\u6237 ID \u4E0D\u4E00\u81F4');
      var name = accountText.slice(0, match.index).trim();
      if (name && names.indexOf(name) < 0) names.push(name);
    });
    if (names.length > 1) throw new Error('\u9875\u9762\u8D26\u6237\u540D\u79F0\u5B58\u5728\u51B2\u7A81');
    var lockedName = state.lock?.accountId === accountId ? state.lock?.accountName : '';
    return { accountId: accountId, accountName: names[0] || lockedName ||
      '\u8D26\u6237 ' + accountId };
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

  function materialHeaderText(th) {
    var label = text(th).replace(/\s+/g, '').replace(/\uFF08/g, '(').replace(/\uFF09/g, ')');
    // New live UI renamed the audit column. Keep the cell index and all status checks.
    return label === '\u7D20\u6750\u72B6\u6001' ? '\u5BA1\u6838\u72B6\u6001' : label;
  }

  function findMaterialTable(drawer) {
    var required = ['\u89C6\u9891', state.lock?.planKind === 'live' ? '\u89C6\u9891\u7C7B\u578B' : '\u7D20\u6750\u7C7B\u578B', '\u6807\u7B7E', '\u521B\u5EFA\u65F6\u95F4', SORT];
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
              /\u7D20\u6750\s*ID[\uFF1A:]\s*\d+/.test(text(row));
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
        .map(function (row) { return (text(row).match(/\u7D20\u6750\s*ID[\uFF1A:]\s*(\d+)/) || [])[1]; }).join('|');
    }));
    if (signatures.size !== 1) throw new Error('\u627E\u5230\u591A\u4E2A\u4E0D\u4E00\u81F4\u7684\u7D20\u6750\u8868\uFF0C\u7B49\u5F85\u9875\u9762\u5237\u65B0');
    var head = pairs[0].head;
    var body = pairs[0].body;
    var headers = pairs[0].headers;
    var missing = required.filter(function (label) { return !headers.includes(label); });
    if (state.lock?.planKind !== 'live' && !headers.includes('\u89C6\u9891') && !headers.includes('\u7D20\u6750\u7C7B\u578B')) {
      missing.push('\u89C6\u9891\u6216\u7D20\u6750\u7C7B\u578B');
    }
    if (missing.length) throw new Error('\u7D20\u6750\u8868\u7F3A\u5C11\u5217\u201C' + missing.join('\u3001') + '\u201D\uFF1B\u5F53\u524D\u8868\u5934\uFF1A' + headers.join('\u3001'));
    return { head: head, body: body, headers: headers };
  }

  function materialPageSizeInput(footer) {
    var inputs = Array.from(footer.querySelectorAll('input[readonly]')).filter(function (input) {
      return tableLayoutVisible(input) && /^\d+\s*\u6761\s*\/\s*\u9875$/.test((input.value || '').trim());
    });
    return one(inputs, '\u6BCF\u9875\u6761\u6570');
  }

  function materialPagination(drawer) {
    var legacy = Array.from(drawer.querySelectorAll('.main-vmok-plugin-oc-pagination-wrapper'))
      .filter(tableLayoutVisible);
    if (legacy.length === 1) return legacy[0];
    if (legacy.length > 1) throw new Error('\u5F53\u524D\u62BD\u5C49\u5185\u6709\u591A\u4E2A\u7D20\u6750\u5206\u9875\u680F');
    var candidates = Array.from(drawer.querySelectorAll('[class*="pagination"], [class*="Pagination"]'))
      .filter(function (el) {
        if (!tableLayoutVisible(el) || !/\u5171\s*\d+\s*\u6761\u8BB0\u5F55/.test(text(el))) return false;
        try { return !!materialPageSizeInput(el); } catch (_) { return false; }
      });
    var innermost = candidates.filter(function (el) {
      return !candidates.some(function (other) { return other !== el && el.contains(other); });
    });
    return one(innermost, '\u7D20\u6750\u5206\u9875\u680F');
  }

  function table() {
    const drawer = context().drawer;
    const { head, body, headers } = findMaterialTable(drawer);
    const sourceColumn = state.lock?.planKind === 'live' ? '\u89C6\u9891\u7C7B\u578B' : '\u7D20\u6750\u7C7B\u578B';
    const index = Object.fromEntries(['\u89C6\u9891',sourceColumn,'\u6807\u7B7E','\u521B\u5EFA\u65F6\u95F4',SORT].map(name => [name, headers.indexOf(name)]));
    if (index['\u89C6\u9891'] < 0 || index[sourceColumn] < 0 || index['\u6807\u7B7E'] < 0 || index['\u521B\u5EFA\u65F6\u95F4'] < 0 || index[SORT] < 0) {
      throw new Error('\u5F53\u524D\u4E0D\u662F\u89C6\u9891\u7D20\u6750\u8868\uFF0C\u6216\u7F3A\u5C11\u89C6\u9891\u7C7B\u578B\u3001\u6807\u7B7E\u3001\u521B\u5EFA\u65F6\u95F4\u3001\u7EFC\u5408\u6210\u672C\u5217');
    }
    return { drawer, head, body, headers, index, sourceColumn };
  }
  function sorted(t) {
    const th = one(materialHeaderCells(t.head).filter(el => materialHeaderText(el) === SORT), SORT + '\u5217');
    return th.getAttribute('aria-sort') === 'descending' || !!th.querySelector('[class*="sorter-down--active"]');
  }
  function footer() {
    return materialPagination(context().drawer);
  }
  function pageInfo() {
    const f = footer();
    const count = (text(f).match(/\u5171\s*(\d+)\s*\u6761\u8BB0\u5F55/) || [])[1];
    const size = Number((materialPageSizeInput(f).value || '').match(/^\d+/)?.[0]);
    const page = Number(text(one(f.querySelectorAll('[class*="page-turner__item--active"], [class*="pagination-item-active"], [aria-current="page"]'), '\u5F53\u524D\u9875\u7801')));
    if (count == null || !Number.isInteger(size) || !Number.isInteger(page) || size < 1 || page < 1) {
      throw new Error('\u65E0\u6CD5\u8BFB\u53D6\u5206\u9875\u6570\u91CF\u3001\u9875\u7801\u6216\u6BCF\u9875\u6761\u6570');
    }
    return { total: Number(count), size, page, pages: Math.max(1, Math.ceil(Number(count) / size)) };
  }
  function costValue(raw) {
    const value = raw.trim();
    if (value === '' || /^[-\u2014\u2013]+$/.test(value) || value === '\u6682\u65E0\u6570\u636E') return null;
    const number = Number(value.replace(/[,\uFFE5\u00A5\s]/g, ''));
    if (!Number.isFinite(number) || number < 0) throw new Error('\u7EFC\u5408\u6210\u672C\u6570\u503C\u65E0\u6CD5\u8BC6\u522B\uFF1A' + value);
    return number;
  }
  function rows() {
    const t = table();
    if (!sourceChip(t.drawer)) throw new Error('\u81EA\u9009\u6295\u653E\u89C6\u9891\u7B5B\u9009\u5DF2\u5931\u6548');
    if (!sorted(t)) throw new Error('\u7EFC\u5408\u6210\u672C(\u5143)\u964D\u5E8F\u5DF2\u5931\u6548');
    const result = [], ids = new Set();
    for (const tr of Array.from(t.body.querySelectorAll('tbody tr')).filter(visible)) {
      const cells = Array.from(tr.querySelectorAll(':scope > td'));
      if (cells.length !== t.headers.length) throw new Error('\u7D20\u6750\u884C\u4E0E\u8868\u5934\u5217\u6570\u4E0D\u4E00\u81F4');
      const id = (text(cells[t.index['\u89C6\u9891']]).match(/\u7D20\u6750\s*ID[\uFF1A:]\s*(\d+)/) || [])[1];
      if (!id || ids.has(id)) throw new Error('\u7D20\u6750 ID \u7F3A\u5931\u6216\u672C\u9875\u91CD\u590D');
      ids.add(id);
      const date = (text(cells[t.index['\u521B\u5EFA\u65F6\u95F4']]).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      if (!date) throw new Error('\u7D20\u6750 ' + id + ' \u521B\u5EFA\u65E5\u671F\u672A\u5C31\u7EEA');
      const source = text(cells[t.index[t.sourceColumn]]);
      const label = text(cells[t.index['\u6807\u7B7E']]);
      const rawCost = text(cells[t.index[SORT]]);
      const checkbox = one(cells[0].querySelectorAll('input[type="checkbox"]'), '\u7D20\u6750 ' + id + ' \u590D\u9009\u6846');
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
    }, '\u6574\u9875\u7D20\u6750\u3001\u7EFC\u5408\u6210\u672C\u548C\u6392\u5E8F\u7A33\u5B9A', 22000);
  }
  async function ensureSizeSort() {
    const f = footer();
    const input = materialPageSizeInput(f);
    if (Number((input.value || '').match(/^\d+/)?.[0]) !== PAGE_SIZE) {
      await click(input, '\u6BCF\u9875\u6761\u6570');
      const opt = await wait(() => Array.from(document.querySelectorAll('.main-vmok-plugin-select__options .main-vmok-plugin-option__content'))
        .filter(visible).find(el => text(el) === PAGE_SIZE + '\u6761/\u9875'), PAGE_SIZE + '\u6761/\u9875');
      await click(opt, PAGE_SIZE + '\u6761/\u9875');
      await wait(() => pageInfo().size === PAGE_SIZE, '\u6BCF\u987520\u6761\u751F\u6548');
    }
    let t = table();
    if (!sorted(t)) {
      const th = one(materialHeaderCells(t.head).filter(el => materialHeaderText(el) === SORT), SORT + '\u5217');
      await click(one(th.querySelectorAll('[class*="sorter-down"]'), '\u7EFC\u5408\u6210\u672C\u964D\u5E8F\u7BAD\u5934'), '\u7EFC\u5408\u6210\u672C\u964D\u5E8F');
    }
    await stable();
  }
  function pagerButton(kind) {
    const f = footer();
    const items = Array.from(f.querySelectorAll('li, button, [role="button"]')).filter(el =>
      visible(el) && (!!el.querySelector('[class*="page-turner__' + kind + '-icon"]') ||
        new RegExp(kind === 'next' ? '\u4E0B\u4E00\u9875|next' : '\u4E0A\u4E00\u9875|prev', 'i').test(el.getAttribute('aria-label') || el.getAttribute('title') || '')));
    return one(items.filter(el => !items.some(other => other !== el && el.contains(other))), kind + '\u9875\u6309\u94AE');
  }
  async function move(kind) {
    const before = pageInfo(), currentIds = rows().map(r => r.id).join('|');
    const button = pagerButton(kind);
    if (button.disabled || button.className.includes('disabled') || button.getAttribute('aria-disabled') === 'true' ||
        button.closest('[aria-disabled="true"], li[class*="disabled"]')) return false;
    await click(button, kind === 'next' ? '\u4E0B\u4E00\u9875' : '\u4E0A\u4E00\u9875');
    const target = before.page + (kind === 'next' ? 1 : -1);
    await wait(() => pageInfo().page === target, '\u5207\u6362\u5230\u7B2C' + target + '\u9875');
    await wait(() => rows().map(r => r.id).join('|') !== currentIds, '\u7B2C' + target + '\u9875\u7D20\u6750\u5237\u65B0');
    await stable();
    return true;
  }
  async function lastPage() {
    const before = pageInfo();
    if (before.page === before.pages) return;
    const oldIds = rows().map(r => r.id).join('|');
    const pageItems = Array.from(footer().querySelectorAll('li, button, [role="button"]'))
      .filter(el => text(el) === String(before.pages));
    const last = one(pageItems.filter(el => !pageItems.some(other => other !== el && el.contains(other))), '\u672B\u9875\u9875\u7801 ' + before.pages);
    phase('\u76F4\u63A5\u8DF3\u5230\u672B\u9875\uFF1A\u7B2C ' + before.page + ' \u2192 ' + before.pages + ' \u9875');
    await click(last, '\u672B\u9875\u9875\u7801 ' + before.pages);
    await wait(() => pageInfo().page === before.pages, '\u5207\u6362\u5230\u7B2C ' + before.pages + ' \u9875');
    await wait(() => rows().map(r => r.id).join('|') !== oldIds, '\u672B\u9875\u7D20\u6750\u5237\u65B0');
    await stable();
    log('\u5DF2\u76F4\u63A5\u8DF3\u5230\u7EFC\u5408\u6210\u672C\u964D\u5E8F\u672B\u9875\uFF1A\u7B2C ' + pageInfo().page + '/' + pageInfo().pages + ' \u9875');
  }
  function selectedRows() { return rows().filter(r => r.checkbox.checked); }
  function toolbarSelectedCount() {
    const matches = Array.from(context().drawer.innerText.matchAll(/\u5DF2\u9009\s*(\d+)\s*\u4E2A\s*\u89C6\u9891/g));
    if (matches.length !== 1) throw new Error('\u65E0\u6CD5\u552F\u4E00\u8BFB\u53D6\u5DE5\u5177\u680F\u5DF2\u9009\u89C6\u9891\u6570\u91CF');
    return Number(matches[0][1]);
  }
  function selectionMatches(ids) {
    const actual = selectedRows().map(r => r.id);
    return actual.length === ids.length && ids.every(id => actual.includes(id)) && toolbarSelectedCount() === ids.length;
  }
  function headerCheckbox() {
    const first = materialHeaderCells(table().head)[0];
    const found = first ? Array.from(first.querySelectorAll('input[type="checkbox"]')).filter(visible) : [];
    return found.length === 1 ? found[0] : null;
  }
  async function clearSelection() {
    const initial = selectedRows();
    const header = headerCheckbox();
    if (initial.length && initial.length === rows().length && header && header.checked) {
      await click(header, '\u53D6\u6D88\u672C\u9875\u5168\u9009', null, QUICK_CLICK);
      await wait(() => selectedRows().length === 0, '\u53D6\u6D88\u672C\u9875\u5168\u9009\u751F\u6548', 3500);
      return;
    }
    for (const id of selectedRows().map(r => r.id)) {
      const current = rows().find(r => r.id === id);
      if (!current || !current.checkbox.checked) throw new Error('\u6E05\u9664\u52FE\u9009\u65F6\u7D20\u6750\u5217\u8868\u5DF2\u53D8\u5316');
      await click(current.checkbox, '\u53D6\u6D88\u52FE\u9009\u7D20\u6750 ' + id, null, QUICK_CLICK);
    }
    await wait(() => selectedRows().length === 0, '\u6E05\u9664\u5168\u90E8\u52FE\u9009');
  }
  async function selectIds(ids) {
    if (selectedRows().length) throw new Error('\u9875\u9762\u5DF2\u6709\u52FE\u9009\uFF0C\u7981\u6B62\u53E0\u52A0');
    const current = rows();
    if (!ids.length || ids.some(id => !current.some(r => r.id === id && eligible(r)))) {
      throw new Error('\u5F85\u9009\u7D20\u6750 ID \u6216\u7B5B\u9009\u6761\u4EF6\u5DF2\u6539\u53D8');
    }
    const info = pageInfo();
    if (info.page === info.pages && ids.length === current.length) {
      throw new Error('\u672B\u9875\u7981\u6B62\u5168\u9875\u5220\u9664\uFF1B\u987B\u4FDD\u7559\u6700\u540E\u4E00\u6761\u7D20\u6750');
    }
    const header = headerCheckbox();
    const last = current[current.length - 1];
    const keepLast = current.length > 1 && info.page === info.pages &&
      ids.length === current.length - 1 && last && state.protectedTailIds.includes(last.id) &&
      ids.every((id, index) => current[index].id === id) && header && !header.checked;
    if (keepLast) {
      await click(header, '\u672B\u9875\u5168\u9009\u540E\u4FDD\u7559\u6700\u540E\u4E00\u6761', null, QUICK_CLICK);
      await wait(() => selectionMatches(current.map(r => r.id)), '\u672B\u9875\u5168\u9009\u751F\u6548', 3500);
      const protectedRow = rows().find(r => r.id === last.id);
      if (!protectedRow || !protectedRow.checkbox.checked) throw new Error('\u672B\u9875\u4FDD\u7559\u7D20\u6750\u72B6\u6001\u5DF2\u6539\u53D8');
      await click(protectedRow.checkbox, '\u53D6\u6D88\u672B\u9875\u4FDD\u7559\u7D20\u6750 ' + last.id, null, QUICK_CLICK);
    } else if (ids.length === current.length && header && !header.checked) {
      await click(header, '\u672C\u9875\u5408\u683C\u7D20\u6750\u5168\u9009', null, QUICK_CLICK);
    } else {
      for (const id of ids) {
        const row = rows().find(r => r.id === id);
        if (!row || row.checkbox.checked) throw new Error('\u5F85\u9009\u7D20\u6750 ' + id + ' \u5DF2\u6539\u53D8');
        await click(row.checkbox, '\u52FE\u9009\u7D20\u6750 ' + id, null, QUICK_CLICK);
      }
    }
    await wait(() => selectionMatches(ids), '\u52FE\u9009\u6307\u5B9A\u7D20\u6750 ID \u751F\u6548', 3500);
  }
  function eligibleBase(r) {
    return r.source === (state.lock?.planKind === 'live' ? '\u81EA\u9009\u6295\u653E\u89C6\u9891' : '\u81EA\u9009\u6295\u653E\u7D20\u6750') &&
      r.cost === null && r.date < cfg.cutoff &&
      !r.label.includes('AIGC\u8DD1\u91CF') && !state.deleted.includes(r.id) && !state.tagged.includes(r.id);
  }
  function eligible(r) { return eligibleBase(r) && !state.protectedTailIds.includes(r.id); }
  function protectFinalPageTail(info, current) {
    if (info.page !== info.pages || !current.length ||
        current.some(r => state.protectedTailIds.includes(r.id)) ||
        !current.every(eligibleBase)) return;
    const id = current[current.length - 1].id;
    state.protectedTailIds.push(id);
    log('\u672B\u9875 ' + current.length + ' \u6761\u5168\u90E8\u7B26\u5408\u5220\u9664\u6761\u4EF6\uFF1B\u4FDD\u7559\u6700\u540E\u4E00\u6761\u7D20\u6750 ' + id + '\uFF0C\u672C\u8F6E\u4E0D\u5220\u9664');
  }
  function warningVisible() {
    // \u5343\u5DDD\u6709\u65F6\u628A\u8B66\u544A\u653E\u5728\u666E\u901A\u786E\u8BA4\u6846\u4E4B\u5916\uFF1B\u53EA\u8BFB\u53D6\u7F51\u9875\u53EF\u89C1\u6587\u5B57\uFF0C\u4E0D\u8BFB\u53D6\u52A9\u624B\u7684 Shadow DOM\u3002
    return AIGC_WARNING.test(document.body.innerText || '');
  }
  function visibleDialogs() {
    const drawer = context().drawer;
    const all = Array.from(document.querySelectorAll('.main-vmok-plugin-modal__wrap, .tools-vmok-plugin-modal__wrap, [role="alertdialog"], [role="dialog"]'))
      .filter(visible)
      .filter(el => !el.contains(drawer)) // \u8BA1\u5212\u62BD\u5C49\u4E5F\u53EF\u80FD\u5E26 role="dialog"\uFF0C\u4E0D\u80FD\u5F53\u4F5C\u5220\u9664\u786E\u8BA4\u6846\u3002
      .filter(el => {
        const wording = text(el);
        return wording.length < 1000 && (ORDINARY_DELETE.test(wording) || AIGC_WARNING.test(wording));
      });
    return all.filter(el => !all.some(other => other !== el && el.contains(other)));
  }
  function deletionDialog() {
    const matches = visibleDialogs();
    if (matches.length > 1) throw new Error('\u540C\u65F6\u51FA\u73B0\u591A\u4E2A\u5220\u9664\u63D0\u793A\uFF0C\u65E0\u6CD5\u5224\u660E\uFF0C\u5DF2\u505C\u6B62');
    return matches[0] || null;
  }
  async function openDelete(ids) {
    const drawer = context().drawer;
    const candidates = Array.from(drawer.querySelectorAll('button, a, span')).filter(el => visible(el) && text(el) === '\u5220\u9664')
      .filter(el => !el.closest('tbody'));
    const button = one(candidates.filter(el => !candidates.some(other => other !== el && el.contains(other))), '\u9009\u4E2D\u7D20\u6750\u540E\u7684\u5DE5\u5177\u680F\u5220\u9664');
    if (!selectionMatches(ids)) {
      throw new Error('\u70B9\u51FB\u5220\u9664\u524D\u52FE\u9009 ID \u5DF2\u6539\u53D8');
    }
    if (warningVisible() || deletionDialog()) throw new Error('\u70B9\u51FB\u5220\u9664\u524D\u9875\u9762\u5DF2\u6709\u672A\u5904\u7406\u7684\u5220\u9664\u63D0\u793A');
    const prompt = { dialog: null, warningSeen: false, observer: null };
    // \u4ECE\u70B9\u51FB\u524D\u5F00\u59CB\u76D1\u542C\uFF0C\u907F\u514D\u77ED\u6682\u51FA\u73B0\u7684 AIGC \u8B66\u544A\u5728\u8BFB\u53D6\u5F39\u7A97\u65F6\u5DF2\u7ECF\u6D88\u5931\u3002
    const observer = new MutationObserver(() => { if (warningVisible()) prompt.warningSeen = true; });
    prompt.observer = observer;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden'] });
    try {
      await click(button, '\u5DE5\u5177\u680F\u5220\u9664\uFF08\u53EA\u6253\u5F00\u786E\u8BA4\u6846\uFF09', null, QUICK_CLICK);
      prompt.dialog = await wait(deletionDialog, '\u5220\u9664\u786E\u8BA4\u6216 AIGC \u8B66\u544A', 10000);
      await sleep(900);
      if (warningVisible()) prompt.warningSeen = true;
      if (!visible(prompt.dialog)) throw new Error('\u5220\u9664\u63D0\u793A\u5728\u6838\u5BF9\u65F6\u6D88\u5931\uFF0C\u7ED3\u679C\u4E0D\u660E');
      return prompt;
    } catch (error) { observer.disconnect(); throw error; }
  }
  function dialogKind(prompt) {
    const wording = text(prompt.dialog);
    if (prompt.warningSeen || warningVisible() || AIGC_WARNING.test(wording)) return 'aigc';
    if (/AIGC|\u8DD1\u91CF\u4F18\u52BF/.test(wording)) throw new Error('\u5220\u9664\u63D0\u793A\u6D89\u53CA AIGC\uFF0C\u4F46\u8B66\u544A\u5185\u5BB9\u65E0\u6CD5\u51C6\u786E\u8BC6\u522B');
    if (!ORDINARY_DELETE.test(wording)) throw new Error('\u5220\u9664\u5F39\u7A97\u5185\u5BB9\u672A\u77E5');
    const buttons = Array.from(prompt.dialog.querySelectorAll('button')).filter(visible).map(text);
    if (buttons.filter(value => value === '\u786E\u5B9A').length !== 1 ||
      buttons.filter(value => value === '\u53D6\u6D88').length !== 1) {
      throw new Error('\u666E\u901A\u5220\u9664\u5F39\u7A97\u6309\u94AE\u4E0D\u5B8C\u6574\u6216\u4E0D\u552F\u4E00');
    }
    const extra = wording.replace(ORDINARY_DELETE, '').replace(/\u53D6\u6D88|\u786E\u5B9A|[\u00D7\u2715]/g, '').trim();
    if (extra) throw new Error('\u666E\u901A\u5220\u9664\u5F39\u7A97\u51FA\u73B0\u989D\u5916\u8BF4\u660E\uFF0C\u5DF2\u505C\u6B62\uFF1A' + extra.slice(0, 100));
    return 'normal';
  }
  async function dismissDialog(dialog) {
    const buttons = Array.from(dialog.querySelectorAll('button')).filter(visible);
    const cancel = buttons.filter(el => ['\u53D6\u6D88','\u5173\u95ED','\u6211\u77E5\u9053\u4E86'].includes(text(el)));
    if (cancel.length === 1) await click(cancel[0], '\u53D6\u6D88\u5220\u9664\u5F39\u7A97');
    else {
      const close = Array.from(dialog.querySelectorAll('[aria-label], .main-vmok-plugin-modal__close')).filter(visible)
        .find(el => /\u5173\u95ED|close/i.test(el.getAttribute('aria-label') || el.className));
      if (!close) throw new Error('\u65E0\u6CD5\u5B89\u5168\u5173\u95ED AIGC/\u6D4B\u8BD5\u5F39\u7A97');
      await click(close, '\u5173\u95ED\u5220\u9664\u5F39\u7A97');
    }
    await wait(() => !deletionDialog(), '\u5220\u9664\u5F39\u7A97\u5173\u95ED');
  }
  async function deletionEvidence(ids, oldTotal, timeout) {
    const end = Date.now() + timeout;
    let observed = '\u5217\u8868\u5C1A\u672A\u5C31\u7EEA';
    while (Date.now() < end) {
      try {
        const info = pageInfo();
        const current = rows();
        const stillHere = ids.filter(id => current.some(r => r.id === id));
        const expected = Math.min(info.size, Math.max(0, info.total - (info.page - 1) * info.size));
        observed = '\u603B\u6570 ' + info.total + '\uFF08\u539F ' + oldTotal + '\uFF09\uFF0C\u5F53\u524D\u9875\u4ECD\u6709\u76EE\u6807 ID\uFF1A' + (stillHere.join(', ') || '\u65E0');
        if (info.page <= info.pages && current.length === expected && !current.some(r => r.checkbox.checked) &&
          info.total === oldTotal - ids.length && stillHere.length === 0) {
          return { confirmed: true, observed };
        }
      } catch (_) { observed = '\u7D20\u6750\u5217\u8868\u5237\u65B0\u4E2D'; }
      await sleep(240);
    }
    return { confirmed: false, observed };
  }
  async function confirmDelete(prompt, ids, oldTotal) {
    if (!ids.length || ids.length > PAGE_SIZE) throw new Error('\u5220\u9664\u7EC4\u6570\u8D85\u51FA\u672C\u9875\u8303\u56F4');
    const info = pageInfo();
    if (info.page === info.pages && ids.length === rows().length) {
      throw new Error('\u786E\u8BA4\u524D\u53D1\u73B0\u5F85\u5220\u7D20\u6750\u5360\u6EE1\u672B\u9875\uFF0C\u5DF2\u505C\u6B62\u4EE5\u4FDD\u7559\u6700\u540E\u4E00\u6761');
    }
    if (dialogKind(prompt) !== 'normal') throw new Error('\u4E0D\u662F\u666E\u901A\u5220\u9664\u786E\u8BA4\u6846');
    assertRun();
    if (!selectionMatches(ids)) throw new Error('\u786E\u8BA4\u524D\u7D20\u6750\u52FE\u9009\u53D1\u751F\u53D8\u5316');
    if (ids.some(id => !rows().some(r => r.id === id && eligible(r)))) throw new Error('\u786E\u8BA4\u5220\u9664\u524D\u7D20\u6750\u6761\u4EF6\u5DF2\u6539\u53D8');
    if (warningVisible()) throw new Error('\u786E\u8BA4\u524D\u51FA\u73B0 AIGC \u8B66\u544A\uFF0C\u672A\u5220\u9664');
    const confirm = one(Array.from(prompt.dialog.querySelectorAll('button')).filter(el => text(el) === '\u786E\u5B9A'), '\u5220\u9664\u786E\u8BA4\u6309\u94AE');
    await click(confirm, '\u786E\u8BA4\u5220\u9664 ' + ids.length + ' \u6761', () => {
      if (dialogKind(prompt) !== 'normal' || warningVisible()) {
        throw new Error('\u70B9\u51FB\u786E\u5B9A\u524D\u63D0\u793A\u53D1\u751F\u53D8\u5316\u6216\u51FA\u73B0 AIGC \u8B66\u544A\uFF0C\u672A\u5220\u9664');
      }
      if (!selectionMatches(ids) || ids.some(id => !rows().some(r => r.id === id && eligible(r)))) {
        throw new Error('\u70B9\u51FB\u786E\u5B9A\u524D\u7D20\u6750 ID\u3001\u6761\u4EF6\u6216\u52FE\u9009\u53D1\u751F\u53D8\u5316\uFF0C\u672A\u5220\u9664');
      }
    }, QUICK_CLICK);
    // \u5148\u7B49\u9875\u9762\u81EA\u884C\u66F4\u65B0\uFF1B\u672A\u66F4\u65B0\u65F6\u53EA\u7FFB\u9875\u91CD\u8BFB\uFF0C\u4E0D\u518D\u6B21\u70B9\u51FB\u5220\u9664\u3002
    let evidence = await deletionEvidence(ids, oldTotal, 8000);
    if (!evidence.confirmed && !state.stop) {
      if (deletionDialog()) throw new Error('\u5220\u9664\u5F39\u7A97\u4ECD\u5728\uFF0C\u76EE\u6807 ID\uFF1A' + ids.join(', ') + '\uFF1B\u7ED3\u679C\u4E0D\u660E\uFF0C\u672A\u91CD\u590D\u63D0\u4EA4');
      log('\u76EE\u6807 ID ' + ids.join(', ') + ' \u5220\u9664\u7ED3\u679C\u5C1A\u672A\u5237\u65B0\uFF1B\u53EA\u7FFB\u9875\u91CD\u8BFB\u4E00\u6B21\uFF0C\u4E0D\u91CD\u590D\u5220\u9664');
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
      throw new Error('\u76EE\u6807 ID ' + ids.join(', ') + ' \u5220\u9664\u7ED3\u679C\u4E0D\u660E\u786E\uFF1A' + evidence.observed + '\uFF1B\u5DF2\u505C\u6B62\uFF0C\u7981\u6B62\u76F4\u63A5\u91CD\u8BD5\u5220\u9664');
    }
    state.deleted.push(...ids);
    log('\u786E\u8BA4\u5220\u9664 ' + ids.length + ' \u6761\uFF1B\u7D2F\u8BA1 ' + state.deleted.length + '/' + cfg.quota);
    await wait(() => !deletionDialog(), '\u5220\u9664\u5F39\u7A97\u6D88\u5931', 10000, true);
  }
  async function tagAigc(id) {
    // \u4EC5\u5728\u5355\u6761\u7D20\u6750\u89E6\u53D1\u5343\u5DDD\u660E\u786E\u7684 AIGC \u8DD1\u91CF\u8B66\u544A\u540E\u6267\u884C\u3002
    const row = rows().find(r => r.id === id);
    if (!row || !row.checkbox.checked || selectedRows().length !== 1) throw new Error('AIGC \u6807\u8BB0\u524D\u9009\u4E2D\u7D20\u6750\u4E0D\u552F\u4E00');
    const drawer = context().drawer;
    const buttons = Array.from(drawer.querySelectorAll('button, a, span')).filter(el => visible(el) && text(el) === '\u6DFB\u52A0\u6807\u7B7E' && !el.closest('tbody'));
    const tagButton = one(buttons.filter(el => !buttons.some(other => other !== el && el.contains(other))), '\u5DE5\u5177\u680F\u6DFB\u52A0\u6807\u7B7E');
    await click(tagButton, '\u6DFB\u52A0\u6807\u7B7E');
    const candidate = await wait(() => Array.from(document.querySelectorAll('label, li, button, span'))
      .filter(visible).filter(el => text(el) === 'AIGC\u8DD1\u91CF' && !el.closest('tbody'))
      .sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0], 'AIGC\u8DD1\u91CF\u6807\u7B7E\u9009\u9879', 8000);
    const box = candidate.closest('label')?.querySelector('input[type="checkbox"]') || candidate.querySelector('input[type="checkbox"]');
    if (box && box.checked) throw new Error('AIGC \u8DD1\u91CF\u6807\u7B7E\u9009\u62E9\u72B6\u6001\u4E0D\u660E');
    await click(box || candidate, '\u9009\u62E9 AIGC\u8DD1\u91CF \u6807\u7B7E');
    const popups = Array.from(document.querySelectorAll('.main-vmok-plugin-modal__wrap, [role="dialog"], .main-vmok-plugin-oc-popover-text__content'))
      .filter(visible).filter(el => text(el).includes('AIGC\u8DD1\u91CF') && !el.contains(drawer));
    const popup = popups.sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (!popup) throw new Error('\u65E0\u6CD5\u5B9A\u4F4D AIGC \u6807\u7B7E\u786E\u8BA4\u9762\u677F');
    const confirms = Array.from(popup.querySelectorAll('button')).filter(el => visible(el) && ['\u786E\u5B9A','\u786E\u8BA4'].includes(text(el)));
    if (confirms.length !== 1) throw new Error('AIGC \u6807\u7B7E\u786E\u8BA4\u6309\u94AE\u4E0D\u552F\u4E00');
    await click(confirms[0], '\u786E\u8BA4 AIGC\u8DD1\u91CF \u6807\u7B7E');
    await wait(() => rows().some(r => r.id === id && r.label.includes('AIGC\u8DD1\u91CF')), 'AIGC \u8DD1\u91CF\u6807\u7B7E\u751F\u6548', 15000);
    state.tagged.push(id);
    log('\u7D20\u6750 ' + id + ' \u89E6\u53D1 AIGC \u8B66\u544A\uFF0C\u5DF2\u6DFB\u52A0 AIGC\u8DD1\u91CF \u6807\u7B7E');
    if (selectedRows().length) await clearSelection();
  }
  async function processOne(id) {
    // \u6BCF\u8F6E\u53EA\u5904\u7406\u4E00\u6761\u3002\u5343\u5DDD\u5220\u9664\u540E\u4F1A\u91CD\u6392\u5217\u8868\uFF0C\u4E0B\u4E00\u6761\u5FC5\u987B\u4ECE\u5237\u65B0\u540E\u7684\u672B\u9875\u91CD\u65B0\u6838\u5BF9\u3002
    if (!id || selectedRows().length) throw new Error('\u9010\u6761\u5220\u9664\u524D\u9009\u62E9\u72B6\u6001\u4E0D\u6B63\u786E');
    const row = rows().find(r => r.id === id);
    if (!row || !eligible(row)) throw new Error('\u5F85\u5904\u7406\u7D20\u6750\u6761\u4EF6\u5DF2\u6539\u53D8');
    const before = pageInfo().total;
    await selectIds([id]);
    const prompt = await openDelete([id]);
    try {
      const kind = dialogKind(prompt);
      if (kind === 'aigc') {
        await dismissDialog(prompt.dialog);
        log('\u7D20\u6750 ' + id + ' \u51FA\u73B0 AIGC \u8B66\u544A\uFF1B\u53D6\u6D88\u5220\u9664\u5E76\u5C1D\u8BD5\u8865\u6807');
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
    if (!ids.length || ids.length > PAGE_SIZE || selectedRows().length) throw new Error('\u6279\u91CF\u5220\u9664\u524D\u9009\u62E9\u72B6\u6001\u4E0D\u6B63\u786E');
    if (ids.some(id => !rows().some(r => r.id === id && eligible(r)))) throw new Error('\u6279\u91CF\u5019\u9009\u7D20\u6750\u6761\u4EF6\u5DF2\u6539\u53D8');
    const before = pageInfo().total;
    await selectIds(ids);
    const prompt = await openDelete(ids);
    try {
      if (dialogKind(prompt) === 'aigc') {
        await dismissDialog(prompt.dialog);
        await clearSelection();
        log('\u672C\u7EC4 ' + ids.length + ' \u6761\u51FA\u73B0 AIGC \u8B66\u544A\uFF1B\u5DF2\u53D6\u6D88\u6279\u91CF\u5220\u9664\uFF0C\u6539\u4E3A\u9010\u6761\u6392\u67E5');
        return 'aigc';
      }
      await confirmDelete(prompt, ids, before);
      return 'deleted';
    } finally {
      prompt.observer.disconnect();
    }
  }
  async function prepare() {
    await wait(() => { table(); pageInfo(); return true; }, '\u7D20\u6750\u8868\u683C\u548C\u5206\u9875\u680F\u52A0\u8F7D', 30000);
    const preselected = Array.from(table().body.querySelectorAll('tbody tr input[type="checkbox"]')).filter(el => el.checked);
    if (preselected.length) throw new Error('\u9875\u9762\u539F\u672C\u5DF2\u52FE\u9009 ' + preselected.length + ' \u6761\u7D20\u6750\uFF1B\u8BF7\u5148\u624B\u52A8\u6E05\u9664\u52FE\u9009\u540E\u518D\u8FD0\u884C');
    await ensureFilter();
    await ensureSizeSort();
    await lastPage();
    await stable();
  }
  function report(reason) {
    const c = state.lock || {};
    const body = [
      '\u5343\u5DDD\u96F6\u6D88\u8017\u7D20\u6750\u6E05\u7406\u62A5\u544A',
      '\u8D26\u6237\uFF1A' + (c.accountName || '-') + '\uFF08' + (c.accountId || '-') + '\uFF09',
      '\u8BA1\u5212\uFF1A' + (c.planName || '-') + '\uFF08' + (c.planId || '-') + '\uFF09',
      '\u8BA1\u5212\u7C7B\u578B\uFF1A' + (c.planKind === 'live' ? '\u63A8\u76F4\u64AD\u95F4' : c.planKind === 'product' ? '\u5546\u54C1\u81EA\u9009' : '\u672A\u9501\u5B9A'),
      '\u6761\u4EF6\uFF1A' + (c.planKind === 'live' ? '\u89C6\u9891\u7C7B\u578B\u4E3A\u81EA\u9009\u6295\u653E\u89C6\u9891' : '\u7D20\u6750\u7C7B\u578B\u4E3A\u81EA\u9009\u6295\u653E\u7D20\u6750') +
        '\uFF1B\u7EFC\u5408\u6210\u672C\u4E3A\u7A7A\uFF1B\u521B\u5EFA\u65E5\u671F\u65E9\u4E8E ' + cfg.cutoff + '\uFF1B\u65E0 AIGC\u8DD1\u91CF \u6807\u7B7E',
      '\u6570\u91CF\u4E0A\u9650\uFF1A' + cfg.quota,
      '\u5DF2\u786E\u8BA4\u5220\u9664\uFF1A' + state.deleted.length,
      '\u672C\u8F6E\u8865\u6807 AIGC\u8DD1\u91CF\uFF1A' + state.tagged.length,
      '\u672B\u9875\u4FDD\u7559\u7D20\u6750 ID\uFF1A' + (state.protectedTailIds.join(', ') || '\u65E0'),
      '\u505C\u6B62\u4F4D\u7F6E\uFF1A' + (() => { try { const p = pageInfo(); return '\u7B2C ' + p.page + '/' + p.pages + ' \u9875'; } catch (_) { return '\u65E0\u6CD5\u786E\u8BA4'; } })(),
      '\u505C\u6B62\u539F\u56E0\uFF1A' + reason,
      '\u5DF2\u5220\u7D20\u6750 ID\uFF1A' + (state.deleted.join(', ') || '\u65E0'),
      '\u8865\u6807\u7D20\u6750 ID\uFF1A' + (state.tagged.join(', ') || '\u65E0'),
      '\u6700\u8FD1\u64CD\u4F5C\uFF1A', ...state.logs.slice(-30)
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
      if (!state.lock) throw new Error('\u8BF7\u5148\u9501\u5B9A\u5F53\u524D\u8BA1\u5212');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.cutoff) || Number.isNaN(Date.parse(cfg.cutoff + 'T00:00:00'))) throw new Error('\u8BF7\u8F93\u5165\u6709\u6548\u7684\u622A\u6B62\u65E5\u671F');
      if (!Number.isInteger(cfg.quota) || cfg.quota < 1 || cfg.quota > MAX_QUOTA) throw new Error('\u5220\u9664\u6570\u91CF\u987B\u4E3A 1\u2014' + MAX_QUOTA);
      context();
      if (!dry) {
        const ok = await requestRunApproval();
        if (!ok) return;
        context();
      }
      state.busy = true; state.stop = false; state.deleted = []; state.tagged = []; state.skipped = []; state.failed = []; state.protectedTailIds = []; state.logs = [];
      state.viewport = { width: innerWidth, height: innerHeight, scale: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height };
      phase(dry ? '\u6F14\u7EC3\uFF1A\u5B9A\u4F4D\u672B\u9875\u5E76\u68C0\u67E5\uFF0C\u4E0D\u52FE\u9009\u6216\u5220\u9664' : '\u6B63\u5F0F\u6267\u884C\uFF1A\u51C6\u5907\u7D20\u6750\u9875');
      await prepare();
      if (dry) {
        const rr = rows();
        protectFinalPageTail(pageInfo(), rr);
        const eligibleRows = rr.filter(eligible);
        log('\u672B\u9875\u7B2C ' + pageInfo().page + ' \u9875\uFF1A' + rr.length + ' \u6761\uFF0C\u672C\u8F6E\u53EF\u5220\u9664 ' + eligibleRows.length + ' \u6761\uFF1BID\uFF1A' + eligibleRows.map(r => r.id).join(', '));
        phase('\u6F14\u7EC3\u5B8C\u6210\uFF1A\u672A\u52FE\u9009\u3001\u672A\u6807\u8BB0\u3001\u672A\u5220\u9664');
        report('\u6F14\u7EC3\u68C0\u67E5\u5F53\u524D\u672B\u9875\uFF0C\u672A\u5220\u9664');
        return;
      }
      let visits = 0, scanned = 0, reason = '', returnToLast = false;
      const singleFallbackIds = new Set();
      while (state.deleted.length < cfg.quota) {
        assertRun();
        if (++visits > 1000) throw new Error('\u626B\u63CF\u8D85\u8FC71000\u8F6E\uFF0C\u5DF2\u505C\u6B62\u4EE5\u907F\u514D\u5FAA\u73AF');
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
            log('\u7B2C ' + info.page + '/' + info.pages + ' \u9875\u9010\u6761\u6392\u67E5 AIGC \u8B66\u544A\u7EC4\u7D20\u6750 ' + fallback.id);
            const result = await processOne(fallback.id);
            singleFallbackIds.delete(fallback.id);
            if (result === 'tagged') {
              singleFallbackIds.clear();
              log('\u5DF2\u627E\u5230\u5E76\u8865\u6807 AIGC \u8DD1\u91CF\u7D20\u6750\uFF1B\u7ED3\u675F\u9010\u6761\u6392\u67E5\uFF0C\u4E0B\u4E00\u8F6E\u91CD\u65B0\u8BFB\u53D6\u5408\u683C\u7D20\u6750\u5E76\u6062\u590D\u6279\u91CF\u5220\u9664');
            }
            if (result === 'deleted') returnToLast = true;
          } else {
            const ids = candidates.map(r => r.id);
            log('\u7B2C ' + info.page + '/' + info.pages + ' \u9875\u62DF\u6279\u91CF\u5220\u9664 ' + ids.length + ' \u6761\uFF1B\u9010\u6761\u6838\u5BF9 ID\u3001\u65E5\u671F\u3001\u6210\u672C\u548C\u6807\u7B7E');
            const result = await processBatch(ids);
            if (result === 'aigc') ids.forEach(id => singleFallbackIds.add(id));
            else returnToLast = true;
          }
          continue;
        }
        if (info.page <= 1) { reason = '\u5DF2\u626B\u63CF\u5230\u7B2C1\u9875\uFF0C\u65E0\u66F4\u591A\u7B26\u5408\u6761\u4EF6\u7684\u7D20\u6750\uFF1B\u672B\u9875\u4FDD\u7559\u7D20\u6750\u4E0D\u4F1A\u5220\u9664'; break; }
        if (!(await move('prev'))) { reason = '\u65E0\u6CD5\u7EE7\u7EED\u7FFB\u4E0A\u4E00\u9875'; break; }
      }
      if (!reason) reason = '\u8FBE\u5230\u5220\u9664\u6570\u91CF\u4E0A\u9650 ' + cfg.quota + ' \u6761';
      phase('\u5DF2\u505C\u6B62\uFF1A' + reason);
      log('\u626B\u63CF\u9875\u6B21 ' + scanned + '\uFF0C\u5220\u9664 ' + state.deleted.length + ' \u6761\uFF0C\u8865\u6807 ' + state.tagged.length + ' \u6761');
      report(reason);
    } catch (error) {
      const message = error && error.message || String(error);
      phase('\u5DF2\u505C\u6B62\uFF1A' + message);
      log('\u5B89\u5168\u505C\u6B62\uFF1A' + message);
      report(message + '\u3002\u8BF7\u4EBA\u5DE5\u6838\u5BF9\u5F53\u524D\u5F39\u7A97\u4E0E\u7D20\u6750\u5217\u8868\uFF1B\u4E0D\u8981\u76F4\u63A5\u91CD\u590D\u672C\u8F6E\u5220\u9664\u3002');
    } finally {
      state.busy = false; state.viewport = null; render();
    }
  }
  function lockCurrent() {
    try {
      if (state.busy) throw new Error('\u8FD0\u884C\u4E2D\u4E0D\u80FD\u5207\u6362\u8BA1\u5212');
      const current = context(true);
      state.lock = { accountId: current.accountId, accountName: current.accountName, planId: current.planId,
        planName: current.planName, planKind: current.planKind };
      phase('\u5DF2\u9501\u5B9A\u5F53\u524D' + (current.planKind === 'live' ? '\u76F4\u64AD' : '\u5546\u54C1') + '\u5728\u6295\u8BA1\u5212');
      log('\u9501\u5B9A ' + current.accountName + ' \u2192 ' + current.planName + '\uFF08' + current.planId + '\uFF09');
    } catch (error) { phase('\u9501\u5B9A\u5931\u8D25\uFF1A' + error.message); }
    render();
  }

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'position:fixed;z-index:2147483646;inset:0;pointer-events:none';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({mode:'open'});
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

  const launcherPlacement = createAndroidLauncherPosition(shadow, LAUNCHER_TOP_KEY, 0);
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
    const planLabel = live ? '\u76F4\u64AD\u5728\u6295\u8BA1\u5212' : '\u5546\u54C1\u5728\u6295\u8BA1\u5212';
    const sourceLabel = live ? '\u89C6\u9891\u7C7B\u578B\u4E3A\u81EA\u9009\u6295\u653E\u89C6\u9891' : '\u7D20\u6750\u7C7B\u578B\u4E3A\u81EA\u9009\u6295\u653E\u7D20\u6750';
    shadow.innerHTML = css + `<button class="launcher" id="launch" title="\u70B9\u51FB\u5C55\u5F00\uFF0C\u62D6\u52A8\u8C03\u6574\u4F4D\u7F6E" aria-label="\u5C55\u5F00\u5343\u5DDD\u96F6\u6D88\u8017\u7D20\u6750\u6E05\u7406\u52A9\u624B" style="display:${state.panelOpen?'none':'block'};top:${escapeHTML(state.launcherTop)}%">\u6E05\u7406\u52A9\u624B</button>
      <div class="panel" style="display:${state.panelOpen?'flex':'none'}"><div class="head"><div><strong>\u5343\u5DDD\u96F6\u6D88\u8017\u7D20\u6750\u6E05\u7406\u52A9\u624B</strong><small>v1.1.6 \u5B89\u5353\u7248 \u00B7 ${planLabel} \u00B7 \u81EA\u9009\u6295\u653E\u89C6\u9891</small></div><button id="close" title="\u6700\u5C0F\u5316" aria-label="\u6700\u5C0F\u5316\u52A9\u624B">\u2212</button></div><div class="body">
      <div class="card"><div class="eyebrow">\u9501\u5B9A\u8D26\u6237 / \u5F53\u524D\u8BA1\u5212</div><div class="title">${lock?escapeHTML(lock.accountName):'\u5C1A\u672A\u9501\u5B9A'}</div><div class="muted">${lock?escapeHTML(lock.accountId):''}</div><div class="title" style="margin-top:6px">${lock?escapeHTML(lock.planName):'\u8BF7\u5148\u6253\u5F00\u7D20\u6750\u9875'}</div><div class="muted">${lock?escapeHTML(lock.planId):''}</div><div class="row"><button class="btn" id="lock" ${state.busy?'disabled':''}>\u9501\u5B9A\u5F53\u524D\u8BA1\u5212</button></div></div>
      <div class="card"><div class="eyebrow">\u7B5B\u9009\u6761\u4EF6</div><div class="grid"><label class="field">\u521B\u5EFA\u65E5\u671F\u4E25\u683C\u65E9\u4E8E<input id="cutoff" type="date" value="${escapeHTML(cfg.cutoff)}" ${state.busy?'disabled':''}></label><label class="field">\u6700\u591A\u5220\u9664\u6761\u6570<input id="quota" type="number" min="1" max="${MAX_QUOTA}" step="1" value="${escapeHTML(cfg.quota)}" ${state.busy?'disabled':''}></label></div><div class="hint">${live?'\u76F4\u64AD\u7D20\u6750\u2192\u89C6\u9891\u9875\u7B5B\u9009\u201C\u89C6\u9891\u7C7B\u578B\uFF1A\u81EA\u9009\u6295\u653E\u89C6\u9891\u201D':'\u5546\u54C1\u7D20\u6750\u9875\u7B5B\u9009\u201C\u7D20\u6750\u7C7B\u578B\uFF1A\u81EA\u9009\u6295\u653E\u201D'}\uFF0C20 \u6761/\u9875\uFF1B\u6309<strong>\u7EFC\u5408\u6210\u672C(\u5143)\u964D\u5E8F</strong>\u4ECE\u672B\u9875\u5F80\u524D\u68C0\u67E5\u3002\u4EC5\u5220\u6210\u672C\u4E3A\u7A7A\uFF08-\u3001--\u3001\u6682\u65E0\u6570\u636E\u6216\u7A7A\u767D\uFF09\u3001\u65E5\u671F\u65E9\u4E8E\u622A\u6B62\u65E5\u3001\u4E14\u65E0 AIGC\u8DD1\u91CF \u6807\u7B7E\u7684\u7D20\u6750\u3002</div></div>
      <div class="card"><div class="eyebrow">\u6267\u884C</div><div class="hint warn">\u5148\u6F14\u7EC3\u67E5\u770B\u672B\u9875\u5019\u9009\u3002\u672B\u9875\u5168\u90E8\u5408\u683C\u65F6\u4FDD\u7559\u6700\u540E\u4E00\u6761\uFF0C\u907F\u514D\u5220\u9664\u540E\u7A7A\u9875\uFF1B\u5176\u4F59\u5408\u683C\u7D20\u6750\u4F18\u5148\u6574\u6279\u5904\u7406\u3002\u51FA\u73B0 AIGC \u8B66\u544A\u5219\u53D6\u6D88\u672C\u6279\uFF0C\u9010\u6761\u6392\u67E5\uFF1B\u627E\u5230\u5E76\u8865\u6807 AIGC \u7D20\u6750\u540E\u6062\u590D\u6279\u91CF\u5220\u9664\uFF0C\u518D\u9047\u8B66\u544A\u624D\u91CD\u65B0\u6392\u67E5\u3002\u63D0\u793A\u4E0D\u660E\u786E\u6216\u5220\u9664\u7ED3\u679C\u672A\u786E\u8BA4\u65F6\u7ACB\u5373\u505C\u6B62\uFF0C\u4E0D\u91CD\u590D\u63D0\u4EA4\u3002</div><div class="row"><button class="btn" id="preview" ${state.busy?'disabled':''}>\u68C0\u67E5\u672B\u9875</button><button class="btn primary" id="start" ${state.busy?'disabled':''}>\u5F00\u59CB\u6E05\u7406</button><button class="btn stop" id="stop" ${state.busy?'':'disabled'}>\u505C\u6B62</button></div></div>
      <div class="card"><div class="eyebrow">\u6267\u884C\u72B6\u6001</div><div class="status">${escapeHTML(state.phase)}</div><div class="hint">\u672C\u8F6E\u5DF2\u5220 ${state.deleted.length} \u6761 \u00B7 \u8865\u6807 AIGC ${state.tagged.length} \u6761</div></div>
      <div class="card"><div class="eyebrow">\u6267\u884C\u8BB0\u5F55</div><div class="log">${escapeHTML(state.logs.slice(-35).join('\n')||'\u5C1A\u65E0\u8BB0\u5F55')}</div></div>
      <div class="card"><div class="eyebrow">\u7ED3\u679C\u62A5\u544A</div><div class="report">${escapeHTML(state.lastReport||'\u6267\u884C\u540E\u751F\u6210\u62A5\u544A')}</div><div class="row"><button class="btn" id="copy">\u590D\u5236\u62A5\u544A</button></div></div>
      </div>${state.pendingApproval ? `<div class="confirm-layer" role="dialog" aria-modal="true" aria-label="\u786E\u8BA4\u5F00\u59CB\u6E05\u7406"><div class="confirm-box"><div class="confirm-icon">!</div><div class="confirm-title">\u786E\u8BA4\u5F00\u59CB\u6E05\u7406</div><div class="confirm-detail">\u5C06\u6309\u5F53\u524D\u6761\u4EF6\u5728\u9501\u5B9A\u7684${planLabel}\u4E2D\u6267\u884C\u5220\u9664\u3002\u8BF7\u6838\u5BF9\u5BF9\u8C61\u548C\u6570\u91CF\uFF1B\u5173\u95ED\u6B64\u786E\u8BA4\u533A\u4E0D\u4F1A\u542F\u52A8\u4EFB\u52A1\u3002</div><div class="confirm-summary"><strong>${escapeHTML(lock?.accountName || '')}</strong><br>${escapeHTML(lock?.planName || '')}\uFF08${escapeHTML(lock?.planId || '')}\uFF09<br>\u521B\u5EFA\u65E5\u671F\u65E9\u4E8E <strong>${escapeHTML(cfg.cutoff)}</strong><br>\u6700\u591A\u5220\u9664 <strong>${escapeHTML(cfg.quota)}</strong> \u6761\uFF1B\u4EC5\u5904\u7406\u7EFC\u5408\u6210\u672C\u4E3A\u7A7A\u3001\u65E0 AIGC\u8DD1\u91CF \u6807\u7B7E\u4E14${sourceLabel}\u7684\u7D20\u6750\u3002</div><div class="row"><button class="btn" id="approval-cancel">\u53D6\u6D88</button><button class="btn primary" id="approval-confirm">\u786E\u8BA4\u5F00\u59CB\u6E05\u7406</button></div></div></div>` : ''}</div>`;
        launcherPlacement.bind(shadow.getElementById('launch'), () => { state.panelOpen = true; render(); });
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
    shadow.querySelector('#stop').onclick = () => { state.stop = true; phase('\u5DF2\u8BF7\u6C42\u505C\u6B62\uFF1B\u5F53\u524D\u52A8\u4F5C\u7ED3\u675F\u540E\u505C\u6B62'); };
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
    state.phase = '\u9875\u9762\u5DF2\u6062\u590D\uFF1B\u8BF7\u91CD\u65B0\u9501\u5B9A\u8BA1\u5212\u540E\u518D\u6267\u884C';
    render();
  });
})();
