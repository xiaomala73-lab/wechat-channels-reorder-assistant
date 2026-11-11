// ==UserScript==
// @name         视频号主页带货发布助手
// @namespace    local.channels.home-video-publisher
// @version      1.1.1
// @updateURL    https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/channels-home-video-publisher.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/channels-home-video-publisher.user.js
// @match        https://channels.weixin.qq.com/platform/post/create*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(() => {
  'use strict';
  if (location.pathname.replace(/\/$/, '') !== '/platform/post/create') return;

  // 以下非空选择器来自当前发布页 DOM（包括预渲染的隐藏弹窗）。
  const UI = {
    host: 'wujie-app',
    uploadButton: '.post-upload-wrap .ant-upload-btn',
    fileInput: '.post-upload-wrap input[type="file"]',
    description: '.input-editor[contenteditable]',
    title: 'input[placeholder="填写短标题有机会获得更多流量"]',
    location: '.position-display-wrap',
    locationOptions: '.location-item',
    link: '.link-display-wrap',
    linkOptions: '.link-option-item',
    productDialog: '.add-commodity-dialog:has(input[placeholder="请输入商品ID或关键词"])',
    productSearch: 'input[placeholder="请输入商品ID或关键词"]',
    productSearchButton: '.search-icon',
    productRows: '.ant-table-tbody tr',
    productLoading: '.common-table-loading',
    productCheckbox: 'input.ant-checkbox-input',
    button: 'button',
    confirmation: '.intercept-original-dialog .weui-desktop-dialog__wrp',
    success: '.create-success-dialog .weui-desktop-dialog__wrp',
    errors: '.weui-toptips_error, .post-check-dialog .weui-desktop-dialog__wrp',

    // 需要实测：全部在发布应用的 Shadow DOM 内。null 表示尚未校准。
    // 预览必须是本次视频生成的封面元素，排除模板图、占位图和 loading。
    coverPreview: null,
    uploadProgress: null, // 选择上传、处理或封面生成期间才显示的节点
    uploadError: null,
    validationError: null, // 匹配实际呈现错误的元素，排除空壳和静态说明
    removeFailedUpload: null,
    removeDialog: null,
    removeConfirm: null, // 相对 removeDialog 的按钮选择器
    openProductPicker: null, // 选中「商品」后真正打开选品框的可点击元素
    resultId: null, // 相对商品结果行，元素须展示完整 ID
    attachedItem: null, // 发布表单中已添加的商品项（匹配全部项）
    attachedId: null, // 相对已添加商品项，须展示完整 ID
    timingDialog: null,
    timingConfirm: null, // 相对 timingDialog；只点击确认，保留原选项
    // 若 ID 在属性上，例如 data-product-id，在此填写属性名，否则读取文本。
    resultIdAttribute: null,
    attachedIdAttribute: null,
  };
  const wording = {
    hideLocation: '不显示位置', product: '商品', publish: '发表',
    direct: '直接发表', timing: '选择商品出现时机',
    uploadError: /网络出错[，,、\s]*请重新上传|上传失败|视频上传出错/,
    uploadBusy: /取消上传|正在上传|正在生成封面/,
  };
  const DRAFT = 'publisher.draft.v1';
  const RECEIPTS = 'publisher.receipts.v1';
  const lockName = 'channels-home-video-publisher';
  let run = null;
  let fileObservation = null;
  let verifiedCover = null;
  let awaitingFile = false;
  let fileSelectionInvalidated = false;
  let inputRoot = null;
  let recoveryItem = null;
  let recovering = false;
  const host = document.createElement('aside');
  host.id = 'channels-home-video-publisher-panel';
  if (document.getElementById(host.id)) return;
  document.documentElement.append(host);
  const panel = host.attachShadow({mode:'open'});
  panel.innerHTML = `<style>
    :host{position:fixed;right:12px;top:12px;z-index:2147483647;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1d2939}
    *{box-sizing:border-box}[hidden]{display:none!important}
    section{display:flex;flex-direction:column;width:min(380px,calc(100vw - 24px));max-height:calc(100dvh - 24px);background:#f6f8fc;border:1px solid #d9e3f0;border-radius:17px;box-shadow:0 12px 42px #1f365c26;overflow:hidden}
    .head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#fff;border-bottom:1px solid #e5ebf4}
    .head strong{font-size:15px}.head strong::before{content:'';display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:#087bff}
    .head small{display:block;margin-left:16px;color:#65758b}.body{min-height:0;overflow:auto;padding:11px}
    .card{margin-bottom:9px;padding:11px;background:#fff;border:1px solid #e2e9f3;border-radius:12px}
    .card:last-child{margin-bottom:0}.card h2{font-size:13px;margin:0 0 7px}.hint{font-size:12px;color:#5d6d83;margin:4px 0 7px}
    .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.row select,.primary{flex:1;min-width:0}
    label{display:block;margin-top:7px;font-weight:550}.check{display:flex;align-items:center;gap:6px;margin:0 0 8px}
    input,textarea,select,button{font:inherit}input:not([type=checkbox]),textarea,select{width:100%;min-width:0;padding:7px 8px;border:1px solid #cdd9e9;border-radius:8px;background:#fff;color:#1d2939}
    textarea{resize:vertical;min-height:66px}button{padding:6px 9px;border:1px solid #cfe1fa;border-radius:8px;color:#0865c4;background:#fff;cursor:pointer}
    button:hover:not(:disabled){background:#edf5ff}button:disabled{opacity:.45;cursor:default}.primary{background:#087bff;color:#fff;border-color:#087bff}
    .primary:hover:not(:disabled){background:#0669da}.danger{color:#ad3737;border-color:#f1d4d4}
    :focus-visible{outline:2px solid #087bff;outline-offset:2px}summary{cursor:pointer;color:#0865c4}
    details{margin-top:8px}#status,#current{white-space:pre-wrap;overflow-wrap:anywhere}#status{padding:8px;background:#eaf3ff;border-radius:8px;color:#164d85}
    #current:empty{display:none}#current{font-size:12px;color:#52647b;margin:0 0 7px}
    #launch{position:fixed;right:0;top:47%;writing-mode:vertical-rl;min-height:104px;background:#087bff;color:white;border:0;border-radius:11px 0 0 11px;letter-spacing:2px}
    fieldset{border:0;padding:0;margin:0;min-width:0}.minor{margin-top:8px}
  </style>
  <button id="launch" hidden>发布助手</button>
  <section id="window" aria-label="主页带货发布助手">
    <header class="head"><div><strong>主页带货发布助手</strong><small>v1.1.0 · 逐条选视频</small></div><button id="min" title="收起面板" aria-label="收起面板">−</button></header>
    <div class="body">
      <div class="card"><h2>视频清单</h2>
        <fieldset id="editor">
          <div class="row"><select id="pick" aria-label="选择要编辑的视频"></select><button id="add" type="button">＋ 添加一条</button><button id="drop" type="button" class="danger">移除</button></div>
          <label for="path">视频文件路径</label><input id="path" placeholder="直接粘贴 Windows 文件路径">
          <label for="description">视频描述</label><textarea id="description" placeholder="粘贴完整描述，可换行"></textarea>
          <label for="title">短标题</label><input id="title" placeholder="填写短标题">
          <label for="productId">商品 ID</label><input id="productId" inputmode="numeric" placeholder="粘贴完整商品 ID">
          <details><summary>批量粘贴 / 导入旧清单</summary>
            <p class="hint">从表格复制四列，按「文件路径、视频描述、短标题、商品 ID」排列，无需复制表头。商品 ID 列请设为文本。</p>
            <textarea id="batch" aria-label="批量粘贴视频清单" placeholder="在这里粘贴表格里的多行"></textarea>
            <div class="row"><button id="paste" type="button">追加到清单</button><button id="load" type="button">导入 JSON 文件</button></div>
            <input id="import" type="file" accept=".json,application/json" hidden>
          </details>
          <div class="row minor"><button id="save" type="button">保存清单</button><button id="clear" type="button" class="danger">清空</button></div>
        </fieldset>
      </div>
      <div class="card"><h2>执行</h2>
        <label class="check"><input id="dry" type="checkbox" checked> 试跑（只填写和核验）</label>
        <div class="row"><button id="start" class="primary">开始发布</button><button id="stop" class="danger" disabled>停止/取消</button></div>
      </div>
      <div class="card"><h2>执行状态</h2><div id="current"></div><div id="status" role="status"></div>
        <div class="row minor"><button id="remove" disabled>删除失败上传</button><button id="copy" disabled>复制当前文件路径</button></div>
      </div>
    </div>
  </section>`;
  const $ = id => panel.getElementById(id);
  const fields = ['path','description','title','productId'];
  const fieldLabels = ['视频文件路径','视频描述','短标题','商品 ID'];
  const emptyRow = () => Object.fromEntries(fields.map(field => [field,'']));
  const empty = row => fields.every(field => !row[field].trim());
  let rows = [emptyRow()];
  let editing = 0;
  function status(message) { $('status').textContent = message; }
  function rowLabel(index) {
    const row = rows[index];
    return '第 ' + (index+1) + ' 条' + (row.path ? ' · ' + fileName(row.path) : row.title ? ' · ' + row.title : '');
  }
  function renderEditor() {
    $('pick').replaceChildren(...rows.map((_,index) => new Option(rowLabel(index),String(index))));
    $('pick').value = String(editing);
    for (const field of fields) $(field).value = rows[editing][field];
  }
  function listFromJson(value) {
    const parsed = JSON.parse(value.replace(/^\uFEFF/,''));
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  try {
    const draft = GM_getValue(DRAFT,'');
    if (draft) rows = validateJobs(listFromJson(draft));
    status('填好本条或添加多条，再点击开始。队列按清单顺序处理。');
  } catch { status('旧清单无法载入，可在批量区重新导入。'); }
  renderEditor();
  $('min').onclick = () => { $('window').hidden = true; $('launch').hidden = false; };
  $('launch').onclick = () => { $('launch').hidden = true; $('window').hidden = false; };
  $('pick').onchange = () => { editing = Number($('pick').value); renderEditor(); };
  for (const field of fields) $(field).oninput = () => {
    rows[editing][field] = $(field).value;
    $('pick').options[editing].textContent = rowLabel(editing);
  };
  $('add').onclick = () => {
    rows.push({...emptyRow(),productId:rows[editing].productId});
    editing = rows.length-1;
    renderEditor();
    $('path').focus();
  };
  $('drop').onclick = () => {
    rows.splice(editing,1);
    if (!rows.length) rows.push(emptyRow());
    editing = Math.min(editing,rows.length-1);
    renderEditor();
  };
  function working(active) {
    for (const id of ['editor','start','dry']) $(id).disabled = active;
    $('stop').disabled = !active;
  }

  function visible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
  function all(scope, selector) {
    return selector ? [...scope.querySelectorAll(selector)].filter(visible) : [];
  }
  function one(scope, selector, label) {
    const nodes = all(scope, selector);
    if (nodes.length > 1) throw Error(label + '匹配到多个控件，请校准选择器');
    return nodes[0] || null;
  }
  const labelText = e => (e?.innerText ?? e?.textContent ?? '').trim().replace(/\s+/g,' ');
  function exact(scope, selector, label) {
    const nodes = all(scope, selector).filter(e => labelText(e) === label);
    if (nodes.length > 1) throw Error('存在多个「' + label + '」控件');
    return nodes[0] || null;
  }
  function root() {
    const roots = [...document.querySelectorAll(UI.host)]
      .map(e => e.shadowRoot).filter(r => visible(r?.querySelector(UI.description)));
    if (roots.length > 1) throw Error('发现多个发布表单');
    return roots[0] || null;
  }
  function enabled(node) {
    return !!node && visible(node) && !node.disabled &&
      !node.closest('[aria-disabled="true"],.weui-desktop-btn_disabled,.disable-cursor');
  }
  function checkRun(signal) { if (signal.aborted) throw Error('已停止'); }
  function click(node, name, signal) {
    checkRun(signal);
    if (!enabled(node)) throw Error(name + '缺失或不可操作');
    node.scrollIntoView({block:'nearest'});
    if (!enabled(node)) throw Error(name + '位置或状态已变化');
    node.click();
  }
  function wait(probe, name, signal, timeout=12000, allowErrors=false) {
    return new Promise((resolve,reject) => {
      let settled = false;
      const observer = new MutationObserver(check);
      let observed;
      const interval = setInterval(check,180);
      const limit = setTimeout(() => done(Error(name + '等待超时')),timeout);
      function done(error,value) {
        if (settled) return;
        settled = true;
        observer.disconnect(); clearInterval(interval); clearTimeout(limit);
        signal.removeEventListener('abort',abort);
        if (error) reject(error); else resolve(value);
      }
      function abort() { done(Error('已停止')); }
      function check() {
        if (settled) return;
        try {
          checkRun(signal);
          const current = root();
          if (current !== observed) {
            observer.disconnect(); observed = current;
            if (current) observer.observe(current,{subtree:true,childList:true,attributes:true,characterData:true});
          }
          if (current && !allowErrors) errors(current);
          const value = probe(current);
          if (value) done(null,value);
        } catch (error) { done(error); }
      }
      signal.addEventListener('abort',abort,{once:true});
      check();
    });
  }
  function requireConfig(keys) {
    const missing = keys.filter(key => !UI[key]);
    if (missing.length) throw Error('请先校准选择器：' + missing.join('、'));
  }
  function uploadError(r) {
    return !!oneOrAny(r,UI.uploadError) || wording.uploadError.test(labelText(r.querySelector('.post-upload-wrap')));
  }
  function oneOrAny(r, selector) { return all(r,selector).length > 0; }
  function errors(r) {
    if (uploadError(r)) throw Error('上传出错。请删除失败项并确认删除，再选择原视频。');
    if (oneOrAny(r,UI.errors) || oneOrAny(r,UI.validationError)) throw Error('页面显示校验错误，请核对平台提示');
  }
  function coverReady(node) {
    if (!node) return false;
    if (node.tagName === 'IMG') return node.complete && node.naturalWidth > 0;
    return true; // 非 img 选择器须限定为封面已生成时的节点
  }
  function uploaded(r) {
    return !oneOrAny(r,UI.uploadProgress) &&
      !wording.uploadBusy.test(labelText(r.querySelector('.post-upload-wrap'))) &&
      coverReady(one(r,UI.coverPreview,'当前视频封面'));
  }
  function watchFile(r) {
    if (inputRoot === r) return;
    inputRoot?.removeEventListener('change',onFile,true);
    inputRoot?.removeEventListener('drop',onDrop,true);
    inputRoot = r;
    r.addEventListener('change',onFile,true);
    r.addEventListener('drop',onDrop,true);
  }
  function onDrop(event) {
    if (!recoveryItem || !event.dataTransfer?.types.includes('Files')) return;
    fileSelectionInvalidated = true;
    fileObservation = null;
    verifiedCover = null;
  }
  function onFile(event) {
    const input = event.composedPath()[0];
    if (!recoveryItem || !event.isTrusted || !input?.matches?.(UI.fileInput)) return;
    const files = input.files;
    if (!files?.length) return;
    if (!run || !awaitingFile) {
      fileSelectionInvalidated = true;
      fileObservation = null;
      verifiedCover = null;
      return;
    }
    awaitingFile = false;
    verifiedCover = null;
    fileObservation = {name:files[0].name, count:files.length};
  }
  function fileName(path) { return path.split(/[\\/]/).at(-1); }
  function norm(value) { return value.replace(/\r\n?/g,'\n'); }
  function readValue(node) {
    if (!node) throw Error('描述或短标题控件未找到');
    return norm(node.isContentEditable ? node.innerText : node.value);
  }
  function writeValue(node, value, signal) {
    checkRun(signal);
    if (!node || !visible(node) || node.disabled || node.readOnly) throw Error('填写控件不可用');
    if (readValue(node) === value) return;
    node.focus();
    if (node.isContentEditable) {
      const sel = node.getRootNode().getSelection?.() || node.ownerDocument.getSelection();
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node); sel.removeAllRanges(); sel.addRange(range);
      // 使用编辑器输入路径，便于框架接收 input 事件与同步内部状态。
      if (!node.ownerDocument.execCommand('insertText',false,value)) throw Error('描述编辑器不接受自动填写，请人工填写后继续');
      sel.removeAllRanges();
    } else {
      const win = node.ownerDocument.defaultView;
      const proto = node.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);
      node.dispatchEvent(new win.Event('input',{bubbles:true,composed:true}));
      node.dispatchEvent(new win.Event('change',{bubbles:true}));
    }
    node.blur();
  }
  function idFrom(node, attribute) {
    const text = (attribute ? node?.getAttribute(attribute) : labelText(node))?.trim() || '';
    return text.match(/^(?:(?:商品\s*ID|商品编号|商品编码|ID)\s*[：:]?\s*)?(\d+)$/i)?.[1] || '';
  }
  function attached(r) {
    return all(r,UI.attachedItem).map(item => {
      const node = item.matches(UI.attachedId) ? item : one(item,UI.attachedId,'已添加商品 ID');
      return idFrom(node,UI.attachedIdAttribute);
    });
  }
  async function setLocation(r,signal) {
    if (labelText(one(r,UI.location,'位置栏')) !== wording.hideLocation) {
      click(one(r,UI.location,'位置栏'),'位置栏',signal);
      const option = await wait(s => s && exact(s,UI.locationOptions,wording.hideLocation),'不显示位置选项',signal);
      click(option,wording.hideLocation,signal);
    }
    await wait(s => s && labelText(one(s,UI.location,'位置栏')) === wording.hideLocation,'位置回读',signal);
  }
  function timing(r) {
    return one(r,UI.timingDialog,'商品出现时机弹窗') ||
      [...all(r,'.weui-desktop-dialog__wrp')].find(node => labelText(node).includes(wording.timing));
  }
  async function attachProduct(r,item,signal) {
    requireConfig(['attachedItem','attachedId']);
    const old = attached(r);
    if (old.length === 1 && old[0] === item.productId && !timing(r)) return;
    if (old.length) throw Error('表单已有商品或商品 ID 无法读取，请在页面核对并移除多余商品');
    requireConfig(['openProductPicker','resultId','timingDialog','timingConfirm']);
    if (!one(r,UI.openProductPicker,'打开选品控件')) {
      click(one(r,UI.link,'链接栏'),'链接栏',signal);
      const product = await wait(s => s && all(s,UI.linkOptions).find(e =>
        labelText(e) === wording.product || labelText(e).startsWith(wording.product + ' ')),'商品菜单',signal);
      if (!enabled(product)) throw Error('商品入口不可用：' + labelText(product));
      click(product,'商品菜单',signal);
    }
    const picker = await wait(s => s && one(s,UI.openProductPicker,'打开选品控件'),'打开选品控件',signal);
    click(picker,'打开选品控件',signal);
    const dialog = await wait(s => s && one(s,UI.productDialog,'商品搜索弹窗'),'商品搜索弹窗',signal);
    const search = one(dialog,UI.productSearch,'商品搜索输入框');
    const previousRows = all(dialog,UI.productRows);
    const previousText = previousRows.map(labelText).join('\n');
    let resultsChanged = search?.value === item.productId;
    writeValue(search,item.productId,signal);
    click(one(dialog,UI.productSearchButton,'商品搜索'),'商品搜索',signal);
    const checked = await wait(s => {
      if (!s) return null;
      errors(s);
      const current = one(s,UI.productDialog,'商品搜索弹窗');
      if (!current || one(current,UI.productSearch,'商品搜索输入框')?.value !== item.productId) return null;
      if (oneOrAny(current,UI.productLoading)) { resultsChanged = true; return null; }
      const rows = all(current,UI.productRows);
      resultsChanged ||= rows.length !== previousRows.length || rows.some((row,i)=>row !== previousRows[i]) ||
        rows.map(labelText).join('\n') !== previousText;
      if (!resultsChanged) return null;
      const matches = rows.filter(row => {
        const node = row.matches(UI.resultId) ? row : one(row,UI.resultId,'结果商品 ID');
        return idFrom(node,UI.resultIdAttribute) === item.productId;
      });
      if (matches.length > 1) throw Error('搜索结果中存在多条相同 ID');
      return matches[0] && one(matches[0],UI.productCheckbox,'匹配商品的复选框');
    },'完全匹配的商品 ID 搜索结果',signal);
    if (!checked.checked) click(checked,'选择匹配商品',signal);
    const add = await wait(s => {
      const current = s && one(s,UI.productDialog,'商品搜索弹窗');
      if (!current) return null;
      const selected = all(current,UI.productRows).filter(row => one(row,UI.productCheckbox,'商品复选框')?.checked);
      if (selected.length !== 1) return null;
      const row = selected[0];
      const id = row.matches(UI.resultId) ? row : one(row,UI.resultId,'结果商品 ID');
      if (idFrom(id,UI.resultIdAttribute) !== item.productId) throw Error('选中的商品 ID 与清单不符');
      return all(current,UI.button).find(button => /^添加\s*[（(]1[）)]$/.test(labelText(button)) && enabled(button));
    },'唯一已选商品的添加按钮',signal);
    click(add,'添加(1)',signal);
    let stableSince = 0;
    let timingHandled = false;
    await wait(s => {
      if (!s) return null;
      errors(s);
      const modal = timing(s);
      if (modal) {
        stableSince = 0;
        if (!timingHandled) {
          click(one(modal,UI.timingConfirm,'时机确认'),'保留默认商品出现时机',signal);
          timingHandled = true;
        }
        return null;
      }
      const ids = attached(s);
      if (one(s,UI.productDialog,'商品搜索弹窗') || ids.length !== 1 || ids[0] !== item.productId) {
        stableSince = 0; return null;
      }
      stableSince ||= performance.now();
      return performance.now() - stableSince >= 500;
    },'确认商品已添加及其 ID',signal);
  }

  function validateJobs(list, offset=0) {
    if (!list.length) throw Error('清单为空');
    return list.map((row,index) => {
      const prefix = '第 ' + (index+offset+1) + ' 条';
      for (const [i,field] of fields.entries()) {
        if (typeof row?.[field] !== 'string' || !row[field].trim()) throw Error(prefix + '请填写' + fieldLabels[i]);
      }
      const path = row.path.trim().replace(/^"(.*)"$/,'$1'), productId = row.productId.trim();
      if (!/^[A-Za-z]:[\\/]|^\\\\/.test(path) || !fileName(path)) throw Error(prefix + '需要 Windows 视频完整路径');
      if (!/^\d+$/.test(productId)) throw Error(prefix + '的商品 ID 必须是完整数字，请检查表格是否转为科学计数法');
      return {path,description:norm(row.description),title:norm(row.title),productId};
    });
  }
  function parseJobs() {
    const last = rows.findLastIndex(row => !empty(row));
    return validateJobs(rows.slice(0,last+1));
  }
  // 识别表格剪贴板的制表符及双引号包裹的换行单元格。
  function parseTable(text) {
    const table = [];
    let row = [], cell = '', quoted = false, closed = false;
    for (let i=0;i<text.length;i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i+1] === '"') { cell += '"'; i++; }
        else if (ch === '"') { quoted = false; closed = true; }
        else cell += ch;
      } else if (ch === '\t' || ch === '\n' || ch === '\r') {
        row.push(cell); cell = ''; closed = false;
        if (ch !== '\t') {
          if (ch === '\r' && text[i+1] === '\n') i++;
          if (row.some(value => value.trim())) table.push(row);
          row = [];
        }
      } else if (!cell && !closed && ch === '"') quoted = true;
      else {
        if (closed) throw Error('表格引号格式异常，请从原表格重新复制四列');
        cell += ch;
      }
    }
    if (quoted) throw Error('表格单元格引号未闭合，请从原表格重新复制');
    row.push(cell);
    if (row.some(value => value.trim())) table.push(row);
    return table.map((cells,index) => {
      if (cells.length !== fields.length) throw Error('粘贴的第 ' + (index+1) + ' 行应有四列');
      return Object.fromEntries(fields.map((key,i)=>[key,cells[i]]));
    });
  }
  $('paste').onclick = () => {
    try {
      const base = rows.length === 1 && empty(rows[0]) ? [] : rows;
      const incoming = validateJobs(parseTable($('batch').value),base.length);
      rows = [...base,...incoming]; editing = base.length;
      renderEditor();
      $('batch').value = '';
      status('已追加 ' + incoming.length + ' 条。保存清单后可以跨页面继续。');
    } catch (error) { status('批量粘贴失败：' + error.message); }
  };
  async function fingerprint(item) {
    const bytes = new TextEncoder().encode(JSON.stringify([fileName(item.path).toLowerCase(),item.description,item.title,item.productId]));
    const digest = await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join('');
  }
  function receipts() { return GM_getValue(RECEIPTS,{}); }
  function record(key, stage) {
    GM_setValue(RECEIPTS,{...receipts(),[key]:{stage,at:Date.now()}});
    if (receipts()[key]?.stage !== stage) throw Error('无法验证提交记录已保存，已停止');
  }
  function verify(r,item) {
    errors(r);
    if (fileSelectionInvalidated || !uploaded(r) || !fileObservation || fileObservation.count !== 1 ||
        fileObservation.name.toLowerCase() !== fileName(item.path).toLowerCase()) throw Error('视频选择记录、上传完成状态或封面未通过核验');
    const cover = one(r,UI.coverPreview,'当前视频封面');
    if (verifiedCover?.node !== cover || verifiedCover.source !== (cover.currentSrc || cover.getAttribute('src')))
      throw Error('封面预览在核验后发生变化，请重新选择视频');
    if (readValue(one(r,UI.description,'视频描述')) !== item.description) throw Error('描述回读与清单不一致');
    if (readValue(one(r,UI.title,'短标题')) !== item.title) throw Error('短标题回读与清单不一致');
    if (labelText(one(r,UI.location,'位置栏')) !== wording.hideLocation) throw Error('位置未显示为「不显示位置」');
    const ids = attached(r);
    if (ids.length !== 1 || ids[0] !== item.productId) throw Error('表单中的商品 ID 未通过精确核验');
    if (timing(r) || one(r,UI.productDialog,'商品搜索弹窗')) throw Error('商品弹窗仍在打开，请完成确认');
    const radios = all(r,'input[type="radio"]:checked').map(e=>labelText(e.closest('label')));
    if (!radios.includes('不定时')) throw Error('请检查发表方式，当前未核实为不定时');
  }
  async function submit(r,item,key,signal) {
    if (!navigator.locks) throw Error('浏览器未提供跨标签提交锁，请改用人工发表');
    await navigator.locks.request(lockName,{ifAvailable:true,signal},async lock => {
      if (!lock) throw Error('另一个标签正在提交，请先核验该标签的结果');
      checkRun(signal);
      if (receipts()[key]) throw Error('此条有提交记录，请先核验视频列表');
      if (root() !== r) throw Error('发表表单已变化');
      verify(r,item);
      if (one(r,UI.confirmation,'发表确认弹窗')) throw Error('页面已有发表弹窗，请先核对当前状态');
      const publish = exact(r,UI.button,wording.publish);
      if (!enabled(publish)) throw Error('发表按钮不可用');
      record(key,'clicked_publish');
      click(publish,wording.publish,signal);
      const direct = await wait(s => {
        if (s !== r) return null;
        errors(s);
        const modal = one(s,UI.confirmation,'发表确认弹窗');
        return modal && exact(modal,UI.button,wording.direct);
      },'直接发表确认弹窗',signal);
      verify(r,item);
      if (root() !== r || !enabled(direct)) throw Error('直接发表按钮不可用或发布页已变化');
      record(key,'clicked_direct');
      const url = location.href;
      click(direct,wording.direct,signal);
      await wait(s => {
        if (location.origin === 'https://channels.weixin.qq.com' &&
            location.href !== url && !/^\/platform\/post\/create\/?$/.test(location.pathname)) return true;
        if (!s) return null;
        errors(s);
        return one(s,UI.success,'发表成功提示');
      },'发表结果（请到列表核验）',signal,25000);
      record(key,'submitted');
    });
  }
  function showItem(item,index,length) {
    $('current').textContent = '第 ' + (index+1) + ' / ' + length + ' 条\n' + item.path;
    $('copy').disabled = false;
  }
  async function start() {
    if (run || recovering) return;
    const controller = new AbortController();
    run = controller;
    const {signal} = controller;
    const dry = $('dry').checked;
    let key;
    working(true);
    try {
      const jobs = parseJobs();
      let index = 0;
      for (;index < jobs.length;index++) {
        key = await fingerprint(jobs[index]);
        const state = receipts()[key]?.stage;
        if (state === 'submitted') continue;
        if (state) throw Error('第 ' + (index+1) + ' 条有未核实的提交记录，请先检查视频管理列表');
        break;
      }
      if (index === jobs.length) { status('清单各条均已有提交记录，请到视频管理列表核验。'); return; }
      const item = jobs[index];
      const continuing = recoveryItem?.key === key;
      if (!continuing) { fileObservation = null; verifiedCover = null; }
      recoveryItem = {item,key};
      showItem(item,index,jobs.length);
      const r = await wait(s=>s,'发布表单',signal);
      errors(r);
      requireConfig(['coverPreview','uploadProgress','uploadError','validationError']);
      watchFile(r);
      if (oneOrAny(r,UI.uploadButton) && !oneOrAny(r,UI.coverPreview) && !oneOrAny(r,UI.uploadProgress)) {
        fileObservation = null;
        verifiedCover = null;
        fileSelectionInvalidated = false;
      }
      if (!fileObservation) {
        if (oneOrAny(r,UI.coverPreview) || oneOrAny(r,UI.uploadProgress) || !oneOrAny(r,UI.uploadButton))
          throw Error('当前不是空白上传区，请确认旧视频状态并打开空白发表页');
        const upload = one(r,UI.uploadButton,'上传入口');
        awaitingFile = true;
        upload.scrollIntoView({block:'center'});
        status('请点击平台上传区域，在 Windows 文件选择窗口中只选择清单所示的一条视频。');
      }
      await wait(s => {
        if (s !== r) throw Error('发布表单已变化，请检查当前页面');
        errors(s);
        if (fileSelectionInvalidated) throw Error('检测到额外选文件或拖放，请清空上传区后重新选择');
        if (!fileObservation) return null;
        if (fileObservation.count !== 1 || fileObservation.name.toLowerCase() !== fileName(item.path).toLowerCase())
          throw Error('所选文件数量或文件名与清单不符，请移除后重新选择');
        return uploaded(s);
      },'视频选择、上传完成与封面',signal,45*60*1000);
      const cover = one(r,UI.coverPreview,'当前视频封面');
      if (verifiedCover && (verifiedCover.node !== cover || verifiedCover.source !== (cover.currentSrc || cover.getAttribute('src'))))
        throw Error('视频封面与上次核验记录不同，请打开空白发表页后重新选择视频');
      verifiedCover = {node:cover,source:cover.currentSrc || cover.getAttribute('src')};
      status('视频上传完成，正在填写文案与位置。');
      writeValue(one(r,UI.description,'视频描述'),item.description,signal);
      writeValue(one(r,UI.title,'短标题'),item.title,signal);
      await wait(s=>s === r && readValue(one(s,UI.description,'视频描述')) === item.description &&
        readValue(one(s,UI.title,'短标题')) === item.title,'文案回读',signal,2500);
      await setLocation(r,signal);
      errors(r);
      await attachProduct(r,item,signal);
      verify(r,item);
      if (dry) { status('试跑通过。请核对平台表单，取消勾选试跑后点击开始发布可继续本条。'); return; }
      status('核验通过，正在发表。');
      await submit(r,item,key,signal);
      fileObservation = null; verifiedCover = null; recoveryItem = null;
      status('已提交 / 发表结果待列表核验。请返回发表页打开空白表单，再点击开始处理下一条。');
    } catch (error) {
      const entry = key && receipts()[key];
      status('已暂停：' + error.message + (entry ? '\n本条已有提交记录，请到视频管理列表核验。' : ''));
    } finally {
      awaitingFile = false;
      run = null;
      working(false);
      try { const r = root(); $('remove').disabled = !(recoveryItem && r && uploadError(r)); }
      catch { $('remove').disabled = true; }
    }
  }
  $('start').onclick = start;
  $('stop').onclick = () => { run?.abort(); if (!run) status('已停止。'); };
  $('copy').onclick = async () => {
    try { if (recoveryItem) await navigator.clipboard.writeText(recoveryItem.item.path); }
    catch { status('复制失败，可在面板选中文件路径后手动复制。'); }
  };
  $('remove').onclick = async () => {
    if (run || recovering) return;
    const r = root();
    if (!r || !uploadError(r)) { status('页面没有可确认的失败上传。'); return; }
    const controller = new AbortController();
    run = controller;
    recovering = true;
    working(true);
    try {
      requireConfig(['removeFailedUpload','removeDialog','removeConfirm']);
      click(one(r,UI.removeFailedUpload,'删除失败上传'),'删除失败上传',controller.signal);
      const modal = await wait(s=>s && one(s,UI.removeDialog,'删除确认弹窗'),'删除确认弹窗',controller.signal,12000,true);
      click(one(modal,UI.removeConfirm,'确认删除'),'确认删除',controller.signal);
      await wait(s=>s && !uploadError(s) && !oneOrAny(s,UI.coverPreview) &&
        !oneOrAny(s,UI.uploadProgress) && oneOrAny(s,UI.uploadButton),'失败项清除',controller.signal,12000,true);
      fileObservation = null;
      $('remove').disabled = true;
      status('失败项已删除。点击开始发布后，重新选择原视频。');
    } catch (error) { status('删除未核实：' + error.message + '。可在平台手动删除并确认，然后使用空白发表页重新开始。'); }
    finally { run = null; recovering = false; working(false); }
  };
  $('save').onclick = () => {
    if (run) return;
    try { const jobs = parseJobs(); GM_setValue(DRAFT,JSON.stringify(jobs)); status('已保存 ' + jobs.length + ' 条。返回发表页时会载入。'); }
    catch (error) { status('清单未保存：' + error.message); }
  };
  $('clear').onclick = () => {
    if (run) return;
    GM_deleteValue(DRAFT);
    rows = [emptyRow()]; editing = 0; renderEditor();
    $('batch').value = ''; $('current').textContent = '';
    recoveryItem = null; fileObservation = null;
    $('copy').disabled = true; $('remove').disabled = true;
    status('清单已清空。提交去重记录仍可用于核验。');
  };
  $('load').onclick = () => { if (!run) $('import').click(); };
  $('import').onchange = async () => {
    const file = $('import').files?.[0];
    if (!file || run) return;
    if (file.size > 1024*1024) { status('清单文件超过 1 MB。'); return; }
    try {
      const value = await file.text();
      if (run) return;
      const incoming = validateJobs(listFromJson(value));
      const base = rows.length === 1 && empty(rows[0]) ? [] : rows;
      rows = [...base,...incoming]; editing = base.length;
      renderEditor();
      status('已导入 ' + incoming.length + ' 条。需要跨页面保留时，请点击保存清单。');
    } catch (error) { status('导入失败：' + error.message); }
    finally { $('import').value = ''; }
  };
})();
