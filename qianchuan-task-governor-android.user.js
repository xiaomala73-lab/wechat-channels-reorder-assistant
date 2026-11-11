// ==UserScript==
// @name         Qianchuan Task Governor (Android)
// @namespace    local.qianchuan.task-governor
// @version      0.1.13
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-android.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-android.user.js
// @description  Android-compatible task governor; preview and verify each page before deleting tasks or increasing budgets.
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
  host.textContent = '\u8c03\u63a7\u52a9\u624b\u6b63\u5728\u542f\u52a8';
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
    } catch (_) { /* \u5237\u65b0\u540e\u65e0\u6cd5\u53ef\u9760\u6062\u590d\u5f53\u524d\u6807\u7b7e\u9875\u9501\u5b9a\u65f6\u8981\u6c42\u91cd\u65b0\u9501\u5b9a */ }
    const cfg = Object.assign({ action: '', liveDeleteRoi: '', liveBudgetRoi: '',
      gap: '', add: '', productMarketingRoi: '', productPaymentRoi: '' }, GM_getValue(CFG_KEY, {}));
    if (cfg.productMarketingRoi === '' && cfg.productDeleteRoi !== undefined) cfg.productMarketingRoi = cfg.productDeleteRoi;
    if (cfg.productPaymentRoi === '' && cfg.productDeleteRoi !== undefined) cfg.productPaymentRoi = cfg.productDeleteRoi;
    delete cfg.productDeleteRoi;
    const state = {
      open: false, busy: false, stop: false, phase: '\u8bf7\u8fdb\u5165\u8ba1\u5212\u8be6\u60c5\u5e76\u9501\u5b9a\u5f53\u524d\u8ba1\u5212',
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
      if (found.length !== 1) throw new Error(label + '\u5e94\u6070\u597d\u51fa\u73b0\u4e00\u6b21\uff0c\u5b9e\u9645 ' + found.length + ' \u6b21');
      return found[0];
    }
    function number(value, label, positive = false) {
      const raw = String(value == null ? '' : value).trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error(label + '\u987b\u586b\u5199\u6700\u591a\u4e24\u4f4d\u5c0f\u6570\u7684\u975e\u8d1f\u6570');
      const n = Number(raw);
      if (!Number.isFinite(n) || (positive && n <= 0)) throw new Error(label + '\u987b\u5927\u4e8e 0');
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
      return /^[-\u2014\u2013\u2212\uff0d]+$/.test(String(value == null ? '' : value).trim());
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
        '\u5343\u5ddd\u8c03\u63a7\u52a9\u624b',
        lock ? '\u8d26\u6237\uff1a' + lock.accountId + '\uff1b\u8ba1\u5212\uff1a' + lock.planName + '\uff08' + lock.planId + '\uff09' : '\u5c1a\u672a\u9501\u5b9a\u8ba1\u5212',
        '\u7ed3\u679c\uff1a' + message, '', ...state.logs.slice(-60)
      ].join('\n');
      if (tabToken) GM_setValue(REPORT_PREFIX + tabToken, state.report);
      render();
    }

    function normalized(value) { return String(value||'').replace(/\s+/g,'').replace(/\uff08/g,'(').replace(/\uff09/g,')').replace(/\(\u5143\)/g,'').replace(/[\uff1a:]$/,''); }
    function layoutVisible(el) {
      if(!el||!el.isConnected)return false;
      for(let n=el;n&&n.nodeType===1;n=n.parentElement){const css=getComputedStyle(n);if(css.display==='none'||css.visibility==='hidden'||n.hidden||n.getAttribute('aria-hidden')==='true')return false;}
      return visible(el)||Array.from(el.querySelectorAll('td,th,input,button,label')).some(visible);
    }
    function selectedOption(el) { return el?.getAttribute('aria-checked')==='true'||/(?:--checked|--selected)(?:\s|$)/.test(el?.className||'')||!!el?.querySelector('input:checked'); }
    function disabled(el) { return !!el?.disabled||el?.getAttribute('aria-disabled')==='true'||/(?:^|[\s_-])disabled(?:$|[\s_-])/.test(el?.className||''); }
    function accountIdentity(u) {
      const id=u.searchParams.get('aavid');
      for(const el of Array.from(document.querySelectorAll('.account-info-box')).filter(visible)) {
        const found=text(el).match(/ID[\uff1a:]\s*(\d+)/);
        if(!found||found[1]!==id)throw new Error('\u53ef\u89c1\u8d26\u6237\u4fe1\u606f\u4e0e\u7f51\u5740 ID \u4e0d\u4e00\u81f4\u6216\u5c1a\u672a\u52a0\u8f7d');
      }
      return id;
    }
    function rowCheckbox(row) {
      const native=Array.from(row.querySelectorAll('input[type="checkbox"]')).filter(el=>el.isConnected&&!el.closest('[hidden],[aria-hidden="true"]'));
      const boxes=native.length?native:Array.from(row.querySelectorAll('[role="checkbox"]')).filter(layoutVisible);
      if(boxes.length!==1)throw new Error('\u4efb\u52a1\u52fe\u9009\u6846\u5e94\u552f\u4e00\uff0c\u5b9e\u9645 '+boxes.length+' \u4e2a');
      if(disabled(boxes[0])||boxes[0].closest('button:disabled,[aria-disabled="true"]'))throw new Error('\u4efb\u52a1\u52fe\u9009\u6846\u4e0d\u53ef\u7528');
      return boxes[0];
    }
    function rowChecked(row) {
      const native=Array.from(row.querySelectorAll('input[type="checkbox"]'));
      if(native.length===1)return native[0].checked;
      const roles=Array.from(row.querySelectorAll('[role="checkbox"]')).filter(layoutVisible);
      if(roles.length===1)return roles[0].getAttribute('aria-checked')==='true'||selectedOption(roles[0]);
      return false;
    }
    function taskIcon(row,name,label) {
      const icons=Array.from(row.querySelectorAll('iconpark-icon[name="'+name+'"]')).filter(el=>el.isConnected);
      if(icons.length!==1)throw new Error(label+'\u672a\u552f\u4e00\u8bc6\u522b');
      if(disabled(icons[0])||icons[0].closest('button:disabled,[aria-disabled="true"],[class*="--disabled"]'))throw new Error(label+'\u4e0d\u53ef\u7528');
      return icons[0];
    }

    function urlInfo() {
      const u = new URL(location.href);
      const hash = new URLSearchParams(u.hash.replace(/^#\??/, ''));
      const kind = hash.get('marGoal') === '2' ? 'live' : hash.get('marGoal') === '1' ? 'product' : '';
      if (u.origin !== 'https://qianchuan.jinritemai.com' ||
          !['/overall-prom', '/overall-prom/detail'].includes(u.pathname) ||
          u.searchParams.get('campaignType') !== '1' || u.searchParams.get('uniTab') !== 'ad' ||
          !/^\d+$/.test(u.searchParams.get('aavid') || '') || !kind) {
        throw new Error('\u8bf7\u8fdb\u5165\u5343\u5ddd\u4e58\u65b9\u7684\u63a8\u76f4\u64ad\u6216\u63a8\u5546\u54c1\u8ba1\u5212\u9875');
      }
      const planId = u.searchParams.get('adId') || '';
      return { accountId: accountIdentity(u), planId,
        detail: /^\d+$/.test(planId), kind };
    }
    function detailIdentity() {
      const u = urlInfo();
      // \u63a8\u5546\u54c1\u8be6\u60c5\u4ee5 /overall-prom?adId=... \u62bd\u5c49\u663e\u793a\uff0c\u4e0d\u4e00\u5b9a\u5207\u6362\u5230 /detail \u8def\u5f84\u3002
      if (!/^\d+$/.test(u.planId)) throw new Error('\u8bf7\u5148\u6253\u5f00\u4e00\u6761\u8ba1\u5212\u7684\u8be6\u60c5\u9875');
      const drawer = one(document.querySelectorAll('.ad-detail-wrapper'), '\u8ba1\u5212\u8be6\u60c5');
      const intro = text(drawer).slice(0, 650);
      if (!new RegExp('(?:\u8ba1\u5212)?ID[\uff1a:]\\s*' + u.planId + '(?!\\d)').test(intro)) {
        throw new Error('\u8be6\u60c5\u4e2d\u7684\u8ba1\u5212 ID \u4e0e\u7f51\u5740\u4e0d\u4e00\u81f4');
      }
      const primary=drawer.querySelector('[class*="detailHeader-"] [class*="title-"]');
      const titles=Array.from(drawer.querySelectorAll('[class*="title-"]')).filter(el=>visible(el)&&text(el)&&!['\u8ba1\u5212\u8be6\u60c5','\u63a8\u76f4\u64ad\u95f4','\u63a8\u5546\u54c1'].includes(text(el)));
      const name = text(primary)|| (titles.length===1?text(titles[0]):'');
      if (!name) throw new Error('\u672a\u80fd\u8bfb\u53d6\u5f53\u524d\u8ba1\u5212\u540d\u79f0');
      if (!/\u6295\u653e\u4e2d/.test(intro)) throw new Error('\u5f53\u524d\u8ba1\u5212\u672a\u663e\u793a\u6295\u653e\u4e2d');
      return { ...u, planName: name, drawer };
    }
    function assertLock() {
      if (!state.lock) throw new Error('\u8bf7\u5148\u9501\u5b9a\u5f53\u524d\u8ba1\u5212');
      const d = detailIdentity();
      if (d.accountId !== state.lock.accountId || d.planId !== state.lock.planId ||
          d.kind !== state.lock.kind || d.planName !== state.lock.planName) {
        throw new Error('\u8d26\u6237\u6216\u8ba1\u5212\u5df2\u5207\u6362\uff0c\u8bf7\u91cd\u65b0\u9501\u5b9a');
      }
      return d;
    }
    function lockCurrent() {
      try {
        if (state.busy) throw new Error('\u6b63\u5728\u6267\u884c\uff0c\u6682\u4e0d\u80fd\u66f4\u6362\u8ba1\u5212');
        readCfg();
        const d = detailIdentity();
        state.lock = { accountId: d.accountId, planId: d.planId,
          planName: d.planName, kind: d.kind };
        if (tabToken) GM_setValue(LOCK_PREFIX + tabToken, state.lock);
        state.preview = null;
        phase('\u5df2\u9501\u5b9a' + (d.kind === 'live' ? '\u63a8\u76f4\u64ad' : '\u63a8\u5546\u54c1') + '\u8ba1\u5212');
        log('\u9501\u5b9a ' + d.planName + '\uff08' + d.planId + '\uff09');
      } catch (error) { phase('\u9501\u5b9a\u5931\u8d25\uff1a' + error.message); }
    }
    async function wait(check, label, timeout = 16000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (state.stop) throw new Error('\u7528\u6237\u5df2\u505c\u6b62\u672c\u8f6e\u64cd\u4f5c');
        const value = check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(label + '\u7b49\u5f85\u8d85\u65f6');
    }
    function actionKind() {
      const a = cfg.action;
      const d = assertLock();
      if (a === 'live-delete' || a === 'live-budget') {
        if (d.kind !== 'live') throw new Error('\u5f53\u524d\u4e0d\u662f\u63a8\u76f4\u64ad\u8ba1\u5212');
      } else if (a === 'product-delete') {
        if (d.kind !== 'product') throw new Error('\u5f53\u524d\u4e0d\u662f\u63a8\u5546\u54c1\u8ba1\u5212');
      } else throw new Error('\u8bf7\u5148\u9009\u62e9\u64cd\u4f5c');
      return a;
    }
    async function openTaskView() {
      let d = assertLock();
      if (d.kind === 'live' && /\u5df2\u9009\s*\d+\s*\u4e2a?\s*\u4efb\u52a1/.test(text(d.drawer).slice(0, 1200))) {
        throw new Error('\u9875\u9762\u5df2\u6709\u52fe\u9009\u4efb\u52a1\uff0c\u8bf7\u5148\u53d6\u6d88\u52fe\u9009\u518d\u68c0\u67e5\u672c\u9875');
      }
      const tab = d.drawer.querySelector('[id$="-tab-uni_task_center"]');
      if (!tab) throw new Error('\u672a\u627e\u5230\u8ba1\u5212\u8be6\u60c5\u4e2d\u7684\u201c\u8c03\u63a7\u201d\u6807\u7b7e');
      if (tab.getAttribute('aria-selected') !== 'true') {
        tab.click();
        await wait(() => {
          try { return assertLock().drawer.querySelector('[id$="-tab-uni_task_center"][aria-selected="true"]'); }
          catch (_) { return null; }
        }, '\u8c03\u63a7\u6807\u7b7e');
      }
      d = assertLock();
      const expected = d.kind === 'live' ? '\u7d20\u6750/\u4eba\u7fa4\u8ffd\u6295' : '\u7d20\u6750\u8ffd\u6295';
      const option = await wait(() => Array.from(d.drawer.querySelectorAll('[class*="radio-group-item"],[role="radio"]'))
        .find(x => visible(x) && text(x) === expected), expected + '\u6807\u7b7e');
      if (!selectedOption(option)) option.click();
      let lastTableError = null;
      try {
        await wait(() => {
          try { return taskTable().rows; }
          catch (error) { lastTableError = error; return null; }
        }, expected + '\u4efb\u52a1\u8868', 20000);
      } catch (error) {
        if (lastTableError && /\u7b49\u5f85\u8d85\u65f6/.test(error.message)) {
          throw new Error(expected + '\u4efb\u52a1\u8868\u672a\u5c31\u7eea\uff1a' + lastTableError.message);
        }
        throw error;
      }
      return assertLock();
    }

    function taskTable() {
      const d=assertLock();
      const selected=Array.from(d.drawer.querySelectorAll('[class*="radio-group-item"],[role="radio"]')).filter(el=>visible(el)&&selectedOption(el));
      const expected=d.kind==='live'?'\u7d20\u6750/\u4eba\u7fa4\u8ffd\u6295':'\u7d20\u6750\u8ffd\u6295';
      const normalView=selected.length===1&&text(selected[0])===expected;
      const batchView=d.kind==='live'&&/\u5df2\u9009\s*\d+\s*\u4e2a\s*\u4efb\u52a1/.test(text(d.drawer).slice(0,1600));
      if(!normalView&&!batchView)throw new Error('\u5f53\u524d\u4e0d\u662f\u201c'+expected+'\u201d\u5217\u8868');
      const required=d.kind==='live'?['\u4efb\u52a1\u540d\u79f0','\u8c03\u63a7\u72b6\u6001','\u8c03\u63a7\u9884\u7b97(\u5143)','\u8c03\u63a7\u6d88\u8017']:['\u4efb\u52a1\u540d\u79f0','\u8c03\u63a7\u72b6\u6001','\u8c03\u63a7\u7efc\u5408\u6210\u672c','\u8c03\u63a7\u6d88\u8017'];
      const tables=Array.from(d.drawer.querySelectorAll('table')).filter(layoutVisible),heads=[];
      for(const table of tables) {
        const rows=Array.from(table.querySelectorAll('thead tr')).map(tr=>Array.from(tr.querySelectorAll(':scope > th'))).sort((a,b)=>b.length-a.length);
        if(!rows[0]?.length)continue;
        const labels=rows[0].map(el=>normalized(text(el))),column={};
        for(const label of [...required,'\u8c03\u63a7\u7efc\u5408\u8425\u9500ROI','\u8c03\u63a7\u652f\u4ed8ROI']) {
          const positions=labels.map((value,i)=>value===normalized(label)?i:-1).filter(i=>i>=0);
          if(positions.length>1)throw new Error('\u4efb\u52a1\u8868\u5217\u91cd\u590d\uff1a'+label);
          if(positions.length===1)column[label]=positions[0];
        }
        if(!required.every(label=>Number.isInteger(column[label])))continue;
        const roiLabels=(d.kind==='live'?['\u8c03\u63a7\u652f\u4ed8ROI']:['\u8c03\u63a7\u7efc\u5408\u8425\u9500ROI','\u8c03\u63a7\u652f\u4ed8ROI']).filter(label=>Number.isInteger(column[label]));
        if(!roiLabels.length)continue;
        heads.push({head:table,labels,column,roiLabels});
      }
      if(!heads.length)throw new Error('\u4efb\u52a1\u8868\u5217\u672a\u5b8c\u6574\u8bc6\u522b\uff1b\u5f53\u524d\u8868\u5934\uff1a'+tables.map(t=>Array.from(t.querySelectorAll('thead th')).map(text).join('|')).join(' / ').slice(0,500));
      const pairs=[];
      for(const head of heads) {
        for(let parent=head.head;parent&&d.drawer.contains(parent);parent=parent.parentElement) {
          const nearby=parent===head.head?[parent]:Array.from(parent.querySelectorAll('table')).filter(layoutVisible);
          const bodies=nearby.filter(t=>Array.from(t.querySelectorAll('tbody tr')).filter(visible).some(row=>{
            const cells=Array.from(row.querySelectorAll(':scope > td'));
            return cells.length===head.labels.length&&/ID[\uff1a:]\s*\d+/.test(text(cells[head.column['\u4efb\u52a1\u540d\u79f0']]));
          }));
          if(bodies.length){for(const body of bodies)pairs.push({...head,body});break;}
          if(parent===d.drawer)break;
        }
      }
      const footers=Array.from(d.drawer.querySelectorAll('[class*="pagination"],[class*="Pagination"],[role="navigation"]')).filter(el=>layoutVisible(el)&&el.querySelector('[class*="page-turner__item--active"],[class*="pagination-item-active"],[aria-current="page"]'));
      const complete=footers.filter(el=>Array.from(el.querySelectorAll('input')).some(input=>/\d+\s*\u6761\s*\/\s*\u9875/.test(input.value))||/\d+\s*\u6761\s*\/\s*\u9875/.test(text(el)));
      const pool=complete.length?complete:footers;
      const inner=pool.filter(el=>!pool.some(other=>other!==el&&el.contains(other)));
      if(inner.length>1)throw new Error('\u672c\u9875\u4efb\u52a1\u5206\u9875\u680f\u4e0d\u552f\u4e00');
      const footer=inner[0]||null;
      let page='1',size='';
      if(footer) {
        page=text(one(footer.querySelectorAll('[class*="page-turner__item--active"],[class*="pagination-item-active"],[aria-current="page"]'),'\u4efb\u52a1\u5f53\u524d\u9875'));
        const sizeTexts=Array.from(footer.querySelectorAll('input')).filter(layoutVisible).map(el=>el.value).concat(text(footer));
        const sizeMatch=sizeTexts.map(value=>value.match(/(\d+)\s*\u6761\s*\/\s*\u9875/)).find(Boolean);
        if(!/^\d+$/.test(page)||Number(page)<1||!sizeMatch)throw new Error('\u4efb\u52a1\u5206\u9875\u9875\u7801\u6216\u6bcf\u9875\u6761\u6570\u672a\u8bc6\u522b');
        size=Number(sizeMatch[1])+'\u6761/\u9875';
      }
      const prepare=pair=>({...pair,d,rows:Array.from(pair.body.querySelectorAll('tbody tr')).filter(visible).filter(row=>{
        const raw=text(row);return !(/^\u5171\s*\d+\s*\u6761(?:\u4efb\u52a1|\u8bb0\u5f55)?/.test(raw)&&!/ID[\uff1a:]\s*\d+/.test(raw));
      }),page,size});
      if(!pairs.length) {
        if(!/\u5171\s*0\s*\u6761/.test(text(d.drawer)))throw new Error('\u4efb\u52a1\u6570\u636e\u4ecd\u5728\u52a0\u8f7d\u6216\u8868\u683c\u7ed3\u6784\u672a\u8bc6\u522b');
        return {d,rows:[],column:heads[0].column,roiLabels:heads[0].roiLabels,page,size};
      }
      if(!footer)throw new Error('\u4efb\u52a1\u5206\u9875\u680f\u672a\u8bc6\u522b\uff0c\u65e0\u6cd5\u56fa\u5b9a\u672c\u9875\u9884\u89c8');
      const results=pairs.map(prepare);
      const signatures=new Set(results.map(t=>JSON.stringify(readRows(t).map(({row,...item})=>({...item,checked:rowChecked(row)})))));
      if(signatures.size!==1)throw new Error('\u53d1\u73b0\u4e0d\u4e00\u81f4\u7684\u4efb\u52a1\u8868\u526f\u672c\uff0c\u505c\u6b62\u4ee5\u514d\u64cd\u4f5c\u9519\u8bef\u884c');
      return results[0];
    }
    function readRows(table) {
      return table.rows.map(row => {
        const cells = Array.from(row.querySelectorAll(':scope > td'));
        const nameCell = cells[table.column['\u4efb\u52a1\u540d\u79f0']];
        const rawName = text(nameCell);
        const id = (rawName.match(/ID[\uff1a:]\s*(\d+)/) || [])[1];
        if (!id || cells.length <= Math.max(...Object.values(table.column))) throw new Error('\u4efb\u52a1\u884c ID \u6216\u5217\u6570\u5f02\u5e38');
        const status = text(cells[table.column['\u8c03\u63a7\u72b6\u6001']]);
        const budget = table.d.kind === 'live' ? parseMoney(text(cells[table.column['\u8c03\u63a7\u9884\u7b97(\u5143)']])) : NaN;
        const comprehensiveCost = table.d.kind === 'product' ?
          parseMoney(text(cells[table.column['\u8c03\u63a7\u7efc\u5408\u6210\u672c']])) : NaN;
        const spend = parseMoney(text(cells[table.column['\u8c03\u63a7\u6d88\u8017']]));
        const marketingRaw = Number.isInteger(table.column['\u8c03\u63a7\u7efc\u5408\u8425\u9500ROI']) ?
          text(cells[table.column['\u8c03\u63a7\u7efc\u5408\u8425\u9500ROI']]) : '';
        const paymentRaw = Number.isInteger(table.column['\u8c03\u63a7\u652f\u4ed8ROI']) ?
          text(cells[table.column['\u8c03\u63a7\u652f\u4ed8ROI']]) : '';
        const marketingRoi = parseRoi(marketingRaw);
        const paymentRoi = parseRoi(paymentRaw);
        const roi = table.d.kind === 'live' ? paymentRoi : NaN;
        return { id, name: rawName.replace(/\s*ID[\uff1a:]\s*\d+[\s\S]*$/, '').trim(),
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
      if (action === 'live-delete') return { action, roi: number(cfg.liveDeleteRoi, '\u76f4\u64ad\u5220\u9664 ROI \u9608\u503c') };
      if (action === 'product-delete') return { action,
        marketingRoi: number(cfg.productMarketingRoi, '\u7efc\u5408\u8425\u9500 ROI \u9608\u503c'),
        paymentRoi: number(cfg.productPaymentRoi, '\u652f\u4ed8 ROI \u9608\u503c') };
      return { action, roi: number(cfg.liveBudgetRoi, '\u8ffd\u52a0\u9884\u7b97 ROI \u4e0b\u9650'),
        gap: cents(cfg.gap, '\u9884\u7b97\u4e0e\u6d88\u8017\u5dee\u503c'), add: cents(cfg.add, '\u6bcf\u6b21\u8ffd\u52a0\u91d1\u989d', true) };
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
      if (params.action === 'live-delete') return /\u8c03\u63a7\u4e2d/.test(item.status) && item.roi < params.roi;
      if (params.action !== 'live-budget') return false;
      const status = (item.status || '').replace(/\s+/g, '');
      const budgetPaused = /\u5df2\u6682\u505c/.test(status) && /\u4efb\u52a1\u9884\u7b97\u4e0d\u8db3/.test(status) &&
        !/\u624b\u52a8|\u4eba\u5de5|\u5df2\u7ed3\u675f|\u8c03\u63a7\u7ed3\u675f|\u5df2\u7ec8\u6b62|\u5df2\u53d6\u6d88|\u8d26\u6237\u4f59\u989d\u4e0d\u8db3/.test(status);
      return Number.isSafeInteger(item.budget) && item.budget >= 0 &&
        Number.isSafeInteger(item.spend) && item.spend >= 0 && item.roi >= params.roi &&
        (budgetPaused || (/\u8c03\u63a7\u4e2d/.test(status) && item.budget - item.spend < params.gap));
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
        if (map.has(item.id)) throw new Error('\u672c\u9875\u51fa\u73b0\u91cd\u590d\u4efb\u52a1 ID');
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
        phase('\u672c\u9875 ' + items.length + ' \u6761\u4efb\u52a1\uff0c\u7b26\u5408\u6761\u4ef6 ' + targets.length + ' \u6761\uff1b\u8bf7\u6838\u5bf9\u4e0b\u65b9\u6e05\u5355');
        log('\u68c0\u67e5\u7b2c ' + table.page + ' \u9875\uff1a' + targets.length + ' \u6761\u7b26\u5408\u201c' + params.action + '\u201d\u6761\u4ef6\uff1bROI \u5217\uff1a' + table.roiLabels.join('\u3001') +
          (params.action === 'product-delete' ? '\uff1b\u7efc\u5408\u6210\u672c\u548c\u6d88\u8017\u5747\u5927\u4e8e 0\uff0c\u4efb\u4e00 ROI \u4e3a\u201c\u2014\u201d\u6216\u4f4e\u4e8e\u9608\u503c\uff1a\u7efc\u5408\u8425\u9500 ' + params.marketingRoi + '\u3001\u652f\u4ed8 ' + params.paymentRoi : ''));
        report('\u5df2\u751f\u6210\u672c\u9875\u9884\u89c8\uff1b\u5c1a\u672a\u4fee\u6539\u5343\u5ddd\u4efb\u52a1');
      } catch (error) { phase('\u68c0\u67e5\u5931\u8d25\uff1a' + error.message); report(error.message); }
      finally { state.busy = false; render(); }
    }
    function currentPreview() {
      const p = state.preview;
      if (!p || !p.targets.length) throw new Error('\u8bf7\u5148\u68c0\u67e5\u672c\u9875\uff0c\u4e14\u786e\u8ba4\u5b58\u5728\u7b26\u5408\u6761\u4ef6\u7684\u4efb\u52a1');
      if (Date.now() - p.at > MAX_PREVIEW_AGE) throw new Error('\u9884\u89c8\u5df2\u8d85\u8fc7 2 \u5206\u949f\uff0c\u8bf7\u91cd\u65b0\u68c0\u67e5');
      const params = settings();
      if (JSON.stringify(params) !== JSON.stringify(p.params)) throw new Error('\u6761\u4ef6\u5df2\u6539\u53d8\uff0c\u8bf7\u91cd\u65b0\u68c0\u67e5');
      const t = taskTable();
      if (t.d.accountId !== p.accountId || t.d.planId !== p.planId || t.d.kind !== p.kind ||
          JSON.stringify(t.roiLabels) !== JSON.stringify(p.roiLabels) ||
          t.page !== p.page || t.size !== p.size) throw new Error('\u8ba1\u5212\u6216\u9875\u7801\u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u68c0\u67e5');
      const map = rowsById(t);
      for (const old of p.targets) {
        const fresh = map.get(old.id);
        if (!fresh || !sameValues(old, fresh) || !eligible(fresh, params)) {
          throw new Error('\u4efb\u52a1 ' + old.id + ' \u7684\u72b6\u6001\u6216\u6570\u636e\u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u68c0\u67e5');
        }
      }
      return { p, t };
    }
    function taskById(id) {
      const table = taskTable();
      return rowsById(table).get(id) || null;
    }

    function visibleDeleteModal(expected) {
      const modals=Array.from(document.querySelectorAll('[role="dialog"],[class*="modal__wrap"],.main-vmok-plugin-modal')).filter(el=>visible(el)&&text(el).replace(/\s+/g,'').includes(expected.replace(/\s+/g,''))&&text(el).includes('\u5220\u9664\u540e\u4e0d\u53ef\u6062\u590d'));
      const inner=modals.filter(el=>!modals.some(other=>other!==el&&el.contains(other)));
      return one(inner,'\u5343\u5ddd\u5220\u9664\u786e\u8ba4\u5f39\u7a97');
    }

    function closeDeleteModal(expected) {
      try {
        const modal=visibleDeleteModal(expected);
        const cancels=Array.from(modal.querySelectorAll('button,[role="button"]')).filter(el=>visible(el)&&text(el)==='\u53d6\u6d88');
        if(cancels.length===1){cancels[0].click();return;}
        const close=modal.querySelector('[class*="close-icon"],[aria-label="\u5173\u95ed"]');
        if(close)close.click();
      }catch(_){/* Only cancel a uniquely identified deletion dialog. */}
    }

    async function confirmDelete(expected) {
      const modal = await wait(() => {
        try { return visibleDeleteModal(expected); } catch (_) { return null; }
      }, '\u5220\u9664\u786e\u8ba4\u5f39\u7a97', 8000);
      const yes = one(Array.from(modal.querySelectorAll('button')).filter(b => text(b) === '\u786e\u5b9a'), '\u5220\u9664\u786e\u8ba4\u6309\u94ae');
      if(state.stop)throw new Error('\u7528\u6237\u5df2\u505c\u6b62\uff0c\u672a\u786e\u8ba4\u5220\u9664');
      assertLock();
      if(disabled(yes))throw new Error('\u5220\u9664\u786e\u5b9a\u6309\u94ae\u4e0d\u53ef\u7528');
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
      }, '\u5220\u9664\u540e\u4efb\u52a1\u5217\u8868\u66f4\u65b0', 20000);
    }
    async function deleteLive(p) {
      const selectedByScript = [];
      const selected = readRows(taskTable()).filter(x => rowChecked(x.row));
      if (selected.length) throw new Error('\u9875\u9762\u5df2\u6709\u52fe\u9009\u4efb\u52a1\uff0c\u8bf7\u5148\u6e05\u7a7a\u52fe\u9009\u518d\u6267\u884c');
      let submitted = false;
      const expected = '\u786e\u5b9a\u5220\u9664\u6240\u9009\u7684' + p.targets.length + '\u6761\u4efb\u52a1\u5417\uff1f';
      try {
        for (const old of p.targets) {
          if (state.stop) throw new Error('\u7528\u6237\u5df2\u505c\u6b62\u672c\u8f6e\u64cd\u4f5c');
          const fresh = taskById(old.id);
          if (!fresh || !sameValues(old, fresh)) throw new Error('\u4efb\u52a1 ' + old.id + ' \u5df2\u53d8\u5316');
          const box = rowCheckbox(fresh.row);
          box.click(); selectedByScript.push(old.id);
          await wait(() => {
            try {
              const checked = new Set(readRows(taskTable())
                .filter(x => rowChecked(x.row)).map(x => x.id));
              return selectedByScript.every(id => checked.has(id));
            } catch (_) { return false; }
          }, '\u4efb\u52a1 ' + old.id + ' \u52fe\u9009\u540e\u5217\u8868\u7a33\u5b9a', 6000);
        }
        const now = readRows(taskTable()).filter(x => rowChecked(x.row)).map(x => x.id);
        if (now.length !== p.targets.length || now.some(id => !selectedByScript.includes(id))) {
          throw new Error('\u5b9e\u9645\u52fe\u9009\u4efb\u52a1\u4e0e\u9884\u89c8\u4e0d\u4e00\u81f4');
        }
        assertLock();
        const button = one(Array.from(document.querySelectorAll('button,[role="button"]'))
          .filter(b => text(b) === '\u5220\u9664'), '\u9876\u90e8\u6279\u91cf\u5220\u9664\u6309\u94ae');
        button.click();
        const modal = await wait(() => {
          try { return visibleDeleteModal(expected); } catch (_) { return null; }
        }, '\u6279\u91cf\u5220\u9664\u786e\u8ba4\u5f39\u7a97', 8000);
        if (!text(modal).replace(/\s+/g,'').includes(expected.replace(/\s+/g,''))) throw new Error('\u5343\u5ddd\u786e\u8ba4\u6570\u91cf\u4e0e\u9884\u89c8\u4e0d\u4e00\u81f4');
        if (state.stop) throw new Error('\u7528\u6237\u5df2\u505c\u6b62\u672c\u8f6e\u64cd\u4f5c');
        for(const old of p.targets){const latest=taskById(old.id);if(!latest||!sameValues(old,latest)||!eligible(latest,p.params))throw new Error('\u786e\u8ba4\u5220\u9664\u524d\u4efb\u52a1 '+old.id+' \u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u68c0\u67e5');}
        await confirmDelete(expected);
        submitted = true;
        await waitRemoved(selectedByScript);
        log('\u76f4\u64ad\u4efb\u52a1\u672c\u9875\u5df2\u5220\u9664 ' + selectedByScript.length + ' \u6761\uff1a' + selectedByScript.join(', '));
      } finally {
        if (!submitted) {
          closeDeleteModal(expected);
          for (let pass = 0; pass < 3; pass++) {
            let changed = false;
            for (const id of selectedByScript) {
              try {
                const row = taskById(id)?.row;
                const box = row ? rowCheckbox(row) : null;
                if (box && rowChecked(row)) {
                  box.click(); changed = true;
                  await new Promise(resolve => setTimeout(resolve, 250));
                }
              } catch (_) { /* \u9875\u9762\u5237\u65b0\u4e2d\uff0c\u4e0b\u4e00\u8f6e\u91cd\u65b0\u627e\u4efb\u52a1 */ }
            }
            if (!changed) break;
          }
          const leftovers = selectedByScript.filter(id => {
            try { const row=taskById(id)?.row;return row?rowChecked(row):false; }
            catch (_) { return false; }
          });
          if (leftovers.length) log('\u672a\u63d0\u4ea4\uff1b\u8bf7\u4eba\u5de5\u53d6\u6d88\u4ecd\u52fe\u9009\u7684\u4efb\u52a1\uff1a' + leftovers.join(', '));
        }
      }
    }
    async function deleteProduct(p) {
      let count = 0;
      for (const old of p.targets) {
        if (state.stop) throw new Error('\u7528\u6237\u5df2\u505c\u6b62\uff1b\u5df2\u5b8c\u6210 ' + count + ' \u6761');
        const fresh = taskById(old.id);
        if (!fresh || !sameValues(old, fresh) || !eligible(fresh, p.params)) {
          throw new Error('\u4efb\u52a1 ' + old.id + ' \u5df2\u53d8\u5316\u6216\u4e0d\u518d\u7b26\u5408\u5220\u9664\u6761\u4ef6\uff1b\u5df2\u5b8c\u6210 ' + count + ' \u6761');
        }
        const icon = taskIcon(fresh.row,'oc-icon-delete','\u4efb\u52a1 '+old.id+' \u7684\u5355\u6761\u5220\u9664\u6309\u94ae');
        icon.click();
        const expected = '\u786e\u5b9a\u5220\u9664\u6240\u9009\u7684\u4efb\u52a1\u5417\uff1f';
        let submitted = false;
        try {
          await wait(() => {
            try { return visibleDeleteModal(expected); } catch (_) { return null; }
          }, '\u4efb\u52a1 ' + old.id + ' \u7684\u5220\u9664\u786e\u8ba4', 8000);
          if (state.stop) throw new Error('\u7528\u6237\u5df2\u505c\u6b62\uff1b\u5df2\u5b8c\u6210 ' + count + ' \u6761');
          const latest=taskById(old.id);if(!latest||!sameValues(old,latest)||!eligible(latest,p.params))throw new Error('\u786e\u8ba4\u5220\u9664\u524d\u4efb\u52a1 '+old.id+' \u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u68c0\u67e5');
          await confirmDelete(expected);
          submitted = true;
        } finally {
          if (!submitted) {
            closeDeleteModal(expected);
          }
        }
        await waitRemoved([old.id]);
        count++;
        log('\u5546\u54c1\u7d20\u6750\u8ffd\u6295\u4efb\u52a1\u5df2\u5220\u9664 ' + old.id + '\uff1b\u672c\u9875\u7d2f\u8ba1 ' + count + ' \u6761');
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
      const candidates=[];
      for(const input of Array.from(document.querySelectorAll('input')).filter(el=>visible(el)&&!['checkbox','radio','hidden'].includes(el.type))) {
        for(let box=input.parentElement;box&&box!==document.body&&box!==document.documentElement;box=box.parentElement) {
          if(box.matches('.ad-detail-wrapper'))break;
          const buttons=Array.from(box.querySelectorAll('button,[role="button"]')).filter(visible);
          const cancels=buttons.filter(el=>text(el)==='\u53d6\u6d88'),confirms=buttons.filter(el=>text(el)==='\u786e\u5b9a');
          const inputs=Array.from(box.querySelectorAll('input')).filter(el=>visible(el)&&!['checkbox','radio','hidden'].includes(el.type));
          if(inputs.length>1)break;
          if(cancels.length===1&&confirms.length===1&&/\u8c03\u63a7(?:\u65e5|\u603b)?\u9884\u7b97/.test(text(box))) {
            candidates.push({input,box,cancel:cancels[0],confirm:confirms[0]});break;
          }
          if(cancels.length>1||confirms.length>1)break;
        }
      }
      if(candidates.length!==1)throw new Error('\u9884\u7b97\u7f16\u8f91\u5f39\u5c42\u672a\u552f\u4e00\u8bc6\u522b\uff0c\u5b9e\u9645 '+candidates.length+' \u4e2a');
      return candidates[0];
    }
    async function addBudget(p) {
      let count = 0;
      for (const old of p.targets) {
        if (state.stop) throw new Error('\u7528\u6237\u5df2\u505c\u6b62\uff1b\u5df2\u5b8c\u6210 ' + count + ' \u6761');
        const fresh = taskById(old.id);
        if (!fresh || !sameValues(old, fresh) || !eligible(fresh, p.params)) throw new Error('\u4efb\u52a1 ' + old.id + ' \u5df2\u53d8\u5316\uff1b\u5df2\u5b8c\u6210 ' + count + ' \u6761');
        const cell = fresh.row.querySelectorAll(':scope > td')[taskTable().column['\u8c03\u63a7\u9884\u7b97(\u5143)']];
        const hoverTargets = [cell,...cell.querySelectorAll('[class*="promotion-data-card"],[class*="promotion-data-group-title"]')];
        for (const target of hoverTargets) {
          target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        }
        const icon = await wait(() => cell.querySelector('iconpark-icon[name="oc-icon-light-edit"]'),
          '\u9884\u7b97\u7f16\u8f91\u6309\u94ae\uff1b\u89e6\u5c4f\u5165\u53e3\u672a\u8bc6\u522b\uff0c\u8bf7\u786e\u8ba4\u8be5\u4efb\u52a1\u5141\u8bb8\u4fee\u6539\u9884\u7b97', 3000);
        assertLock();
        if(disabled(icon)||icon.closest('button:disabled,[aria-disabled="true"]'))throw new Error('\u9884\u7b97\u7f16\u8f91\u6309\u94ae\u4e0d\u53ef\u7528');
        icon.click();
        const pop = await wait(() => { try { return budgetPopover(); } catch (_) { return null; } },
          '\u9884\u7b97\u7f16\u8f91\u5f39\u5c42', 8000);
        let submitted = false;
        try {
          const current = parseMoney(pop.input.value);
          if (current !== old.budget) throw new Error('\u4efb\u52a1 ' + old.id + ' \u5f39\u5c42\u9884\u7b97\u4e0e\u5217\u8868\u4e0d\u4e00\u81f4');
          const match = text(pop.box).match(/\u5f53\u524d\u6700\u591a\u53ef\u518d\u8ffd\u52a0\u9884\u7b97\s*([\d,.]+)/);
          if (match && parseMoney(match[1]) < p.params.add) throw new Error('\u4efb\u52a1 ' + old.id + ' \u53ef\u8ffd\u52a0\u989d\u5ea6\u5c0f\u4e8e\u8bbe\u5b9a\u91d1\u989d');
          const target = old.budget + p.params.add;
          if (!Number.isSafeInteger(target)) throw new Error('\u65b0\u9884\u7b97\u91d1\u989d\u8d85\u51fa\u5b89\u5168\u8303\u56f4');
          setInput(pop.input, yuan(target));
          if (parseMoney(pop.input.value) !== target) throw new Error('\u4efb\u52a1 ' + old.id + ' \u7684\u65b0\u9884\u7b97\u8f93\u5165\u672a\u751f\u6548');
          if (state.stop) throw new Error('\u7528\u6237\u5df2\u505c\u6b62\uff1b\u672a\u63d0\u4ea4\u4efb\u52a1 ' + old.id);
          assertLock();
          const latest=taskById(old.id);
          if(!latest||!sameValues(old,latest)||!eligible(latest,p.params))throw new Error('\u786e\u8ba4\u524d\u4efb\u52a1\u6570\u636e\u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u68c0\u67e5');
          if(disabled(pop.confirm))throw new Error('\u9884\u7b97\u786e\u5b9a\u6309\u94ae\u4e0d\u53ef\u7528');
          submitted = true;
          pop.confirm.click();
          await wait(() => taskById(old.id)?.budget === target, '\u4efb\u52a1 ' + old.id + ' \u65b0\u9884\u7b97\u66f4\u65b0', 20000);
          count++;
          log('\u4efb\u52a1 ' + old.id + ' \u9884\u7b97 ' + yuan(old.budget) + ' \u2192 ' + yuan(target) + ' \u5143');
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
        phase('\u6b63\u5728\u6267\u884c\u7b2c ' + p.page + ' \u9875\uff0c\u5171 ' + p.targets.length + ' \u6761');
        log('\u5f00\u59cb\u6267\u884c ' + action + '\uff0c\u4efb\u52a1 ID\uff1a' + p.targets.map(x => x.id).join(', '));
        if (action === 'live-delete') await deleteLive(p);
        else if (action === 'product-delete') await deleteProduct(p);
        else await addBudget(p);
        state.preview = null;
        phase('\u672c\u9875\u64cd\u4f5c\u5b8c\u6210\uff0c\u8bf7\u7b49\u5f85\u5e73\u53f0\u5237\u65b0\u540e\u518d\u68c0\u67e5\u4e0b\u4e00\u9875');
        report('\u672c\u9875 ' + p.targets.length + ' \u6761\u4efb\u52a1\u5df2\u5b8c\u6210\uff1b\u53ef\u7ee7\u7eed\u68c0\u67e5\u5f53\u524d\u9875\u6216\u4e0b\u4e00\u9875');
      } catch (error) {
        state.preview = null;
        phase('\u5df2\u505c\u6b62\uff1a' + error.message);
        report(error.message + '\u3002\u82e5\u5e73\u53f0\u7ed3\u679c\u4e0d\u660e\u786e\uff0c\u8bf7\u4eba\u5de5\u6838\u5bf9\u4efb\u52a1 ID\uff0c\u52ff\u76f4\u63a5\u91cd\u8bd5\u3002');
      } finally { state.busy = false; render(); }
    }

    host.style.cssText = 'position:fixed;z-index:2147483646;inset:0;pointer-events:none';
    host.textContent = '';
    const shadow = host.attachShadow({ mode: 'open' });
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

  const launcherPlacement = createAndroidLauncherPosition(shadow, LAUNCHER_KEY, 3);
  function resizeTouchPanel() {
    const view=window.visualViewport;
    const touch=navigator.maxTouchPoints>0 || /Android/i.test(navigator.userAgent);
    const scale=touch && view ? Math.max(1,1/view.scale) : 1;
    const width=view?.width || innerWidth, height=view?.height || innerHeight;
    host.style.setProperty('--qc-ui-scale',String(scale));
    host.style.setProperty('--qc-panel-width',Math.max(120,Math.min(390,width/scale-24))+'px');
    host.style.setProperty('--qc-panel-height',Math.max(160,height/scale-24)+'px');
    host.style.setProperty('--qc-ui-top',((view?.offsetTop || 0)+12*scale)+'px');
    host.style.setProperty('--qc-ui-right',(Math.max(0,innerWidth-((view?.offsetLeft || 0)+width))+12*scale)+'px');
  }
  resizeTouchPanel();
  window.addEventListener('resize',resizeTouchPanel);
  window.visualViewport?.addEventListener('resize',resizeTouchPanel);
  window.visualViewport?.addEventListener('scroll',resizeTouchPanel);


    const css = `<style>
      :host{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#243047}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.48;cursor:not-allowed}
      .launcher{transform:scale(var(--qc-ui-scale,1));transform-origin:right center;pointer-events:auto;position:fixed;right:0;width:35px;min-height:122px;writing-mode:vertical-rl;letter-spacing:2px;background:#087bfa;color:white;border:1px solid #a7caff;border-right:0;border-radius:13px 0 0 13px;padding:10px 7px;box-shadow:0 8px 24px #064d9d40;font-size:12px;font-weight:700;cursor:grab;touch-action:none;user-select:none}
      .panel{pointer-events:auto;position:fixed;right:var(--qc-ui-right,12px);top:var(--qc-ui-top,12px);width:var(--qc-panel-width,390px);height:var(--qc-panel-height,calc(100vh - 24px));transform:scale(var(--qc-ui-scale,1));transform-origin:top right;display:flex;flex-direction:column;overflow:hidden;background:#f7f9fc;border:1px solid #dce4ee;border-radius:20px;box-shadow:0 18px 48px #23395233;font-size:13px;line-height:1.5}
      .head{flex:none;display:flex;align-items:center;justify-content:space-between;min-height:63px;padding:12px 16px;background:white;border-bottom:1px solid #e5eaf2}.head strong{font-size:15px}.head strong:before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:50%;background:#087bfa;box-shadow:0 0 0 4px #e8f2ff}.head small{display:block;margin:3px 0 0 18px;color:#8a95a7;font-size:11px}.head button{width:40px;height:40px;flex:none;border:0;border-radius:50%;background:#eff2f6;color:#607082;font-size:20px}
      .body{min-height:0;flex:1;overflow:auto;padding:14px 15px 18px;scrollbar-width:thin}.card{background:white;border:1px solid #e4eaf2;border-radius:14px;padding:12px;margin-bottom:12px;box-shadow:0 1px 4px #25344c08;overflow-wrap:anywhere}.eyebrow{font-size:12px;font-weight:700;color:#657387;margin-bottom:8px}.title{font-weight:700}.muted,.hint{color:#738196;font-size:11px;line-height:1.55}.hint{margin-top:8px}.warn{color:#ad5714}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field{display:block;margin:5px 0;color:#526177;font-size:12px}.field input,.field select{font-size:16px;display:block;width:100%;min-height:44px;margin-top:5px;padding:8px 10px;border:1px solid #d4deea;border-radius:10px;background:white;color:#243047}.field input:focus,.field select:focus{outline:none;border-color:#087bfa;box-shadow:0 0 0 3px #087bfa20}.row{display:flex;gap:8px;margin-top:10px}.btn{min-height:44px;touch-action:manipulation;flex:1;padding:9px 10px;border:1px solid #cbdfff;border-radius:10px;background:white;color:#086bd6;font-weight:700}.btn.primary{background:#087bfa;border-color:#087bfa;color:white}.btn.stop{flex:0 0 54px;color:#c93934;border-color:#ffd8d4}.status{padding:10px;border:1px solid #dcecff;border-radius:10px;background:#eaf4ff;color:#1459af;font-weight:700}.item{padding:8px 0;border-bottom:1px solid #edf0f4;font-size:11px}.item:last-child{border-bottom:0}.item b{display:block;font-size:12px}.pill{display:inline-block;margin:3px 5px 0 0;padding:2px 6px;border-radius:5px;background:#eef5ff;color:#2867b5}.check{min-height:36px;cursor:pointer;display:flex;align-items:flex-start;gap:7px;margin-top:10px;color:#9b4c17;font-size:11px}.check input{margin-top:2px}.log{height:105px;overflow:auto;border-radius:10px;background:#172236;color:#dceaff;padding:9px;white-space:pre-wrap;font:11px/1.5 Consolas,monospace}.report{max-height:150px;overflow:auto;white-space:pre-wrap;border:1px solid #e2e8ef;border-radius:10px;padding:9px;font:11px/1.5 Consolas,monospace}
    </style>`;
    function render() {
      const old = shadow.querySelector('.body');
      if (old) state.scrollTop = old.scrollTop;
      const lock = state.lock, p = state.preview;
      let current = null;
      try { current = urlInfo(); } catch (_) { /* \u9875\u9762\u5c1a\u672a\u5c31\u7eea */ }
      const kind = current?.kind || lock?.kind || '';
      const needsRelock = lock && current && (lock.accountId !== current.accountId ||
        lock.planId !== current.planId || lock.kind !== current.kind);
      const live = kind === 'live';
      const choices = live ? `<option value="live-delete">\u76f4\u64ad\u4f4e ROI \u6279\u91cf\u5220\u9664</option><option value="live-budget">\u76f4\u64ad\u9ad8 ROI \u8ffd\u52a0\u9884\u7b97</option>` :
        `<option value="product-delete">\u5546\u54c1\u4f4e ROI \u9010\u6761\u5220\u9664</option>`;
      const action = cfg.action && ((live && cfg.action.startsWith('live-')) || (!live && cfg.action === 'product-delete')) ? cfg.action : '';
      const fieldDisabled = state.busy ? 'disabled' : '';
      const conditionFields = action === 'live-delete' ?
        `<label class="field">\u8c03\u63a7\u652f\u4ed8 ROI \u4f4e\u4e8e<input id="live-delete-roi" type="number" min="0" step="0.01" value="${esc(cfg.liveDeleteRoi)}" ${fieldDisabled}></label>` :
        action === 'live-budget' ?
        `<div class="grid"><label class="field">\u8c03\u63a7\u652f\u4ed8 ROI \u4e0d\u4f4e\u4e8e<input id="live-budget-roi" type="number" min="0" step="0.01" value="${esc(cfg.liveBudgetRoi)}" ${fieldDisabled}></label><label class="field">\u9884\u7b97 \u2212 \u6d88\u8017\u4f4e\u4e8e\uff08\u5143\uff09<input id="gap" type="number" min="0" step="0.01" value="${esc(cfg.gap)}" ${fieldDisabled}></label><label class="field">\u6bcf\u6761\u8ffd\u52a0\u9884\u7b97\uff08\u5143\uff09<input id="add" type="number" min="0.01" step="0.01" value="${esc(cfg.add)}" ${fieldDisabled}></label></div>` :
        action === 'product-delete' ?
        `<div class="grid"><label class="field">\u8c03\u63a7\u7efc\u5408\u8425\u9500ROI \u4f4e\u4e8e<input id="product-marketing-roi" type="number" min="0" step="0.01" value="${esc(cfg.productMarketingRoi)}" ${fieldDisabled}></label><label class="field">\u8c03\u63a7\u652f\u4ed8ROI \u4f4e\u4e8e<input id="product-payment-roi" type="number" min="0" step="0.01" value="${esc(cfg.productPaymentRoi)}" ${fieldDisabled}></label></div>` :
        '<div class="hint">\u9009\u62e9\u64cd\u4f5c\u540e\uff0c\u586b\u5199\u8be5\u64cd\u4f5c\u9700\u8981\u7684\u6761\u4ef6\u3002</div>';
      const conditionHint = action === 'live-delete' ? '\u4ec5\u7b5b\u9009\u5f53\u524d\u9875\u201c\u8c03\u63a7\u4e2d\u201d\u4e14 ROI \u4f4e\u4e8e\u9608\u503c\u7684\u4efb\u52a1\u3002' :
        action === 'live-budget' ? 'ROI \u8fbe\u6807\u4e14\u6ee1\u8db3\u4efb\u4e00\u6761\u4ef6\uff1a\u8c03\u63a7\u4e2d\u4e14\u9884\u7b97\u4e0e\u6d88\u8017\u5dee\u503c\u4f4e\u4e8e\u9608\u503c\uff1b\u6216\u5df2\u6682\u505c\u4e14\u660e\u786e\u63d0\u793a\u201c\u4efb\u52a1\u9884\u7b97\u4e0d\u8db3\u201d\uff08\u6b64\u65f6\u4e0d\u518d\u8981\u6c42\u5dee\u503c\u4f4e\u4e8e\u9608\u503c\uff09\u3002\u5176\u4ed6\u6682\u505c\u539f\u56e0\u8df3\u8fc7\u3002' :
        action === 'product-delete' ? '\u4ec5\u5f53\u8c03\u63a7\u7efc\u5408\u6210\u672c\u548c\u8c03\u63a7\u6d88\u8017\u90fd\u5927\u4e8e 0 \u65f6\u5220\u9664\uff1a\u4efb\u4e00\u5df2\u663e\u793a\u7684 ROI \u4e3a\u201c\u2014\u201d\u6216\u4f4e\u4e8e\u5404\u81ea\u9608\u503c\u5373\u7b26\u5408\u6761\u4ef6\u3002\u6210\u672c\u6216\u6d88\u8017\u4e3a 0\u3001\u65e0\u6cd5\u8bfb\u53d6\u65f6\u8df3\u8fc7\uff1b\u672a\u663e\u793a\u7684 ROI \u5217\u4e0d\u53c2\u4e0e\u5224\u5b9a\u3002' : '';
      const targets = p?.targets || [];
      const missingProductRoi = p?.kind === 'product' ? ['\u8c03\u63a7\u7efc\u5408\u8425\u9500ROI', '\u8c03\u63a7\u652f\u4ed8ROI']
        .filter(label => !p.roiLabels.includes(label)) : [];
      const previewItems = targets.slice(0, 100).map(x => `<div class="item"><b>${esc(x.name || x.id)}</b><span class="pill">ID ${esc(x.id)}</span>${p.params.action === 'product-delete' ? `<span class="pill">\u8c03\u63a7\u7efc\u5408\u8425\u9500ROI ${Number.isFinite(x.marketingRoi) ? esc(x.marketingRoi) : x.marketingRoiDash ? '\u2014' : '\u4e0d\u53ef\u7528'}</span><span class="pill">\u8c03\u63a7\u652f\u4ed8ROI ${Number.isFinite(x.paymentRoi) ? esc(x.paymentRoi) : x.paymentRoiDash ? '\u2014' : '\u4e0d\u53ef\u7528'}</span><span class="pill">\u7efc\u5408\u6210\u672c ${yuan(x.comprehensiveCost)} \u5143</span><span class="pill">\u8c03\u63a7\u6d88\u8017 ${yuan(x.spend)} \u5143</span>` : `<span class="pill">ROI ${esc(x.roi)}</span>`}${Number.isInteger(x.budget) ? `<span class="pill">\u9884\u7b97 ${yuan(x.budget)}</span><span class="pill">\u6d88\u8017 ${yuan(x.spend)}</span>` : ''}${p.params.action === 'live-budget' ? `<span class="pill">\u62df\u6539\u4e3a ${yuan(x.budget + p.params.add)}</span>` : ''}</div>`).join('');
      shadow.innerHTML = css + `<button id="launch" class="launcher" style="display:${state.open ? 'none' : 'block'};top:${esc(state.launcherTop)}%" title="\u70b9\u51fb\u5c55\u5f00\uff0c\u62d6\u52a8\u8c03\u6574\u4f4d\u7f6e">\u8c03\u63a7\u52a9\u624b</button>
        <div class="panel" style="display:${state.open ? 'flex' : 'none'}"><div class="head"><div><strong>\u5343\u5ddd\u8c03\u63a7\u52a9\u624b</strong><small>v0.1.12 \u5b89\u5353\u7248 \u00b7 \u5148\u68c0\u67e5\u672c\u9875\u518d\u6267\u884c</small></div><button id="minimize" title="\u6700\u5c0f\u5316">\u2212</button></div><div class="body">
        <div class="card"><div class="eyebrow">\u9501\u5b9a\u5f53\u524d\u8ba1\u5212</div><div class="title">${esc(lock?.planName || '\u5c1a\u672a\u9501\u5b9a')}</div><div class="muted">\u8d26\u6237 ${esc(lock?.accountId || '\u2014')} \u00b7 \u8ba1\u5212 ${esc(lock?.planId || '\u2014')} \u00b7 ${lock?.kind === 'live' ? '\u63a8\u76f4\u64ad' : lock?.kind === 'product' ? '\u63a8\u5546\u54c1' : '\u672a\u8bc6\u522b'}</div>${needsRelock ? '<div class="hint warn">\u5f53\u524d\u9875\u9762\u4e0e\u5df2\u9501\u5b9a\u8ba1\u5212\u4e0d\u540c\uff0c\u8bf7\u91cd\u65b0\u9501\u5b9a\u5f53\u524d\u8ba1\u5212\u3002</div>' : ''}<div class="row"><button id="lock" class="btn" ${state.busy ? 'disabled' : ''}>\u9501\u5b9a\u5f53\u524d\u8ba1\u5212</button></div></div>
        <div class="card"><div class="eyebrow">\u7b5b\u9009\u6761\u4ef6</div><label class="field">\u672c\u6b21\u64cd\u4f5c<select id="action" ${fieldDisabled}><option value="">\u8bf7\u9009\u62e9</option>${choices}</select></label>${conditionFields}${conditionHint ? `<div class="hint">${conditionHint}</div>` : ''}</div>
        <div class="card"><div class="eyebrow">\u6267\u884c\u672c\u9875</div><div class="hint warn">\u5148\u68c0\u67e5\u5e76\u6838\u5bf9\u4efb\u52a1\u6e05\u5355\uff0c\u518d\u70b9\u51fb\u6267\u884c\u3002\u76f4\u64ad\u5220\u9664\u4ec5\u52fe\u9009\u672c\u9875\u5408\u683c\u4efb\u52a1\u5e76\u6279\u91cf\u5220\u9664\uff1b\u5546\u54c1\u5220\u9664\u9010\u6761\u6267\u884c\uff1b\u9884\u7b97\u9010\u6761\u6539\u4e3a\u5f53\u524d\u503c\u52a0\u8bbe\u5b9a\u91d1\u989d\u3002\u53ef\u5148\u5728\u5343\u5ddd\u9009 100 \u6761/\u9875\uff1b\u8de8\u9875\u8bf7\u9010\u9875\u68c0\u67e5\u3002\u5220\u9664\u540e\u4e0d\u53ef\u6062\u590d\u3002</div><div class="row"><button id="preview" class="btn" ${state.busy || !lock ? 'disabled' : ''}>\u68c0\u67e5\u672c\u9875</button><button id="execute" class="btn primary" ${state.busy || !p?.targets.length ? 'disabled' : ''}>\u6267\u884c\u672c\u9875 ${targets.length} \u6761</button><button id="stop" class="btn stop" ${state.busy ? '' : 'disabled'}>\u505c\u6b62</button></div>${p?.targets.length ? '<label class="check"><input id="ack" type="checkbox">\u6211\u5df2\u6838\u5bf9\u4e0b\u65b9\u4efb\u52a1 ID\u3001ROI \u548c\u91d1\u989d\uff0c\u786e\u8ba4\u6267\u884c\u672c\u9875\u64cd\u4f5c</label>' : ''}</div>
        <div class="card"><div class="eyebrow">\u6267\u884c\u72b6\u6001</div><div class="status">${esc(state.phase)}</div>${p ? `<div class="hint">\u7b2c ${esc(p.page)} \u9875 \u00b7 ${esc(p.size || '\u5f53\u524d\u6761\u6570')} \u00b7 ROI \u5217\uff1a${esc(p.roiLabels.join('\u3001'))} \u00b7 \u9884\u89c8\u4e8e ${new Date(p.at).toLocaleTimeString('zh-CN', { hour12: false })}</div>${missingProductRoi.length ? `<div class="hint warn">\u5f53\u524d\u8868\u683c\u672a\u663e\u793a\uff1a${esc(missingProductRoi.join('\u3001'))}\uff1b\u8fd9\u4e9b\u6307\u6807\u4e0d\u53c2\u4e0e\u5224\u5b9a\u3002</div>` : ''}<div style="max-height:240px;overflow:auto;margin-top:8px">${previewItems || '<div class="muted">\u672c\u9875\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u4efb\u52a1</div>'}</div>` : '<div class="hint">\u5c1a\u672a\u751f\u6210\u672c\u9875\u9884\u89c8</div>'}</div>
        <div class="card"><div class="eyebrow">\u6267\u884c\u8bb0\u5f55</div><div class="log">${esc(state.logs.join('\n') || '\u5c1a\u65e0\u8bb0\u5f55')}</div></div><div class="card"><div class="eyebrow">\u7ed3\u679c\u62a5\u544a</div><div class="report">${esc(state.report || '\u6267\u884c\u540e\u751f\u6210\u62a5\u544a')}</div><div class="row"><button id="copy" class="btn">\u590d\u5236\u62a5\u544a</button></div></div></div></div>`;
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
        if (!shadow.getElementById('ack')?.checked) { phase('\u8bf7\u5148\u6838\u5bf9\u5e76\u52fe\u9009\u786e\u8ba4\u672c\u9875\u6e05\u5355'); return; }
        executePage();
      };
      shadow.getElementById('stop').onclick = () => { state.stop = true; phase('\u5df2\u8bf7\u6c42\u505c\u6b62\uff1b\u5f53\u524d\u672a\u5b8c\u6210\u7684\u64cd\u4f5c\u4f1a\u6682\u505c'); };
      shadow.getElementById('copy').onclick = () => { if (state.report) GM_setClipboard(state.report); };
          launcherPlacement.bind(shadow.getElementById('launch'), () => { state.open = true; render(); });
      if (old) shadow.querySelector('.body').scrollTop = state.scrollTop;
    }
    render();
    window.addEventListener('pageshow', e => { if (e.persisted) { state.open = false; state.preview = null; render(); } });
  } catch (error) {
    host.style.cssText = 'position:fixed;right:0;top:50%;z-index:2147483646;max-width:320px;padding:12px;background:#fff0ee;color:#a32920;border:1px solid #f2b9b2;border-radius:10px 0 0 10px;font:12px/1.5 sans-serif;pointer-events:auto';
    const message = '\u8c03\u63a7\u52a9\u624b\u542f\u52a8\u5931\u8d25\uff1a' + (error && error.message || String(error));
    if (host.shadowRoot) host.shadowRoot.textContent = message;
    else host.textContent = message;
    console.error('\u5343\u5ddd\u8c03\u63a7\u52a9\u624b\u542f\u52a8\u5931\u8d25', error);
  }
})();
