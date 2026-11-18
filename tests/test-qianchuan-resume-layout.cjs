const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function extract(name, start, end) {
  const src = fs.readFileSync('qianchuan-' + name + '.user.js', 'utf8');
  const a = src.indexOf(start), b = src.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, name);
  return src.slice(a, b);
}

function storage() {
  const entries = new Map();
  return {getItem: k => entries.get(k), setItem: (k, value) => entries.set(k, value),
    removeItem: k => entries.delete(k)};
}

for (const os of ['windows', 'android']) {
  test(os + ': chase uses exact plan defaults and skips only groups confirmed in this round', async () => {
    const state = {config:{accountId:'10001', planId:'1840851764337800'}, currentRun:{id:'round-1'}};
    const cleared = [];
    const page = {number:3, count:2, ids:['9','10']};
    const vmCtx = {
      state, sessionStorage:storage(), selectedCount:d => d.count, pageNumber:d => d.number,
      materialSelection:d => ({ids:d.ids, count:d.count}),
      clearAttemptSelection:async (...args) => {cleared.push(args);}
    };
    const api = vm.runInNewContext(
      extract('chase-'+os, '  function chasePlanDefaults(', '  async function captureCurrent(') +
      extract('chase-'+os, '  const CHASE_CONTINUE_PREFIX', '  async function restoreChasePage(') +
      '({chasePlanDefaults, chaseCheckpoint, setChaseCheckpoint, rememberChasePage, consumedChaseIds, clearChaseResumeSelection})', vmCtx);
    const plain = v => JSON.parse(JSON.stringify(v));
    assert.deepEqual(plain(api.chasePlanDefaults('1832800495529143')), {maxGroups:20, roiGroupSize:1, dateGroupSize:1, tailMin:1});
    assert.deepEqual(plain(api.chasePlanDefaults('1840851764337800')), {maxGroups:20, roiGroupSize:2, dateGroupSize:2, tailMin:2});
    assert.deepEqual(plain(api.chasePlanDefaults('999')), {maxGroups:20, roiGroupSize:10, dateGroupSize:20, tailMin:5});
    assert.deepEqual([...api.consumedChaseIds({groups:[
      {uiSuccess:true,ids:['1'],platformSkippedIds:['2']}, {uiSuccess:false,ids:['3']}
    ]})], ['1','2']);
    api.setChaseCheckpoint(state.config,{runId:'round-1',page:null,selected:[]});
    api.rememberChasePage(3, ['9','10']);
    const saved = api.chaseCheckpoint();
    assert.equal(saved.page,3);
    assert.equal(api.chaseCheckpoint({...state.config, accountId:'other'}), null);
    assert.equal(api.chaseCheckpoint({...state.config, planId:'other'}), null);
    await assert.rejects(api.clearChaseResumeSelection(saved,{...page,ids:['9','999']}), /手动取消/);
    await assert.rejects(api.clearChaseResumeSelection(saved,{...page,number:4}), /手动取消/);
    await api.clearChaseResumeSelection(saved,page);
    assert.deepEqual(plain(cleared), [[['9','10'],3]]);
  });

  test(os + ': governor reconciles the pending write and only resumes eligible original IDs', async () => {
    const p = {accountId:'a',planId:'x',kind:'live',page:'2',size:'100条/页',
      roiLabels:['支付 ROI'],params:{action:'live-budget',add:300},scope:'["today",[]]'};
    const row = (id,budget,allowed=true) => ({id,budget,allowed,row:{querySelector:() => null}});
    const table = {d:{accountId:'a',planId:'x',kind:'live',drawer:{innerText:'共 101 条任务',querySelectorAll:() => []}},
      page:'2',size:p.size,roiLabels:p.roiLabels,rows:[]};
    const state = {lock:table.d,continuation:{'a:x:live':{
      preview:p,pending:{ids:['1'],budget:1300},
      remaining:[row('1',1000),row('2',1000),row('3',1000),row('4',1000)]
    }}};
    let items = [row('1',1000),row('2',1000),row('3',1000,false),row('4',1300),row('999',1000)];
    const api = vm.runInNewContext(
      extract('task-governor-'+os,'    function continuationKey(', '    async function deleteLive(') +
      '({resumePreview, actionConfirmed, checkpoint})', {
        state,tabToken:'',URL,location:{href:'https://example.test/?dateRange=today'},
        settings:() => p.params, assertLock:() => table.d, document:{querySelectorAll:() => []},
        taskTable:() => table, rowsById:() => new Map(items.map(x => [x.id,x])),
        text:el => el.innerText, log:() => {}, visible:() => true, eligible:x => x.allowed
      });
    await assert.rejects(api.resumePreview(api.checkpoint()), /不会重提/);
    assert.equal(api.checkpoint().remaining.length,4);
    items[0].budget=1300;
    const resumed = await api.resumePreview(api.checkpoint());
    assert.deepEqual([...resumed.targets.map(x => x.id)],['2']);
    assert.equal(api.checkpoint().pending,null);
    assert.equal(api.actionConfirmed(p,{ids:['99'],budget:null,total:103},true),false);
    table.page='1'; table.d.drawer.innerText='共 100 条任务';
    assert.equal(api.actionConfirmed(p,{ids:['99'],budget:null,total:101},true),true);
    assert.equal(api.actionConfirmed(p,{ids:['2'],budget:null,total:101},true),false);
  });

  test(os + ': cleaner keeps the deletion quota and does not replay unconfirmed operations', async () => {
    const state = {lock:{accountId:'a', planId:'p',planKind:'product'},deleted:['1'],tagged:[],
      protectedTailIds:['keep'],logs:[]};
    const acted = [];
    let confirmed = false, label = '';
    const vmCtx = {
      state,sessionStorage:storage(),context:() => ({drawer:{}}),document:{querySelectorAll:() => []},
      deletionDialog:() => null,text:() => '',table:() => ({body:{querySelectorAll:() => []}}),
      ensureFilter:async () => {},ensureSizeSort:async () => {},
      restoreScanPage:async page => acted.push(page),
      deletionEvidence:async (ids,total) => ({confirmed,observed:'total '+total+': '+ids.join(',')}),
      rows:() => [{id:'7',label}],log:() => {}
    };
    const api = vm.runInNewContext(
      extract('zero-cost-cleaner-'+os, '  const CLEANER_CONTINUE_PREFIX', '  function closePausedRun(') +
      '({cleanerCheckpoint, saveCleanerCheckpoint, stageCleanerAction, recoverCleanerCheckpoint})', vmCtx);
    api.saveCleanerCheckpoint({quota:5,page:4,fallbackIds:['7','8'],pending:null});
    api.stageCleanerAction({kind:'delete',ids:['2','3'],total:80});
    assert.throws(() => api.stageCleanerAction({kind:'delete',ids:['6'],total:80}), /未再次提交/);
    await assert.rejects(api.recoverCleanerCheckpoint(api.cleanerCheckpoint()), /不会重复删除/);
    assert.deepEqual([...state.deleted],['1']);
    confirmed=true;
    await api.recoverCleanerCheckpoint(api.cleanerCheckpoint());
    const saved = api.cleanerCheckpoint();
    assert.equal(saved.quota-saved.deleted.length,2);
    assert.equal(saved.pending,null);
    assert.deepEqual([...saved.tailIds],['keep']);
    assert.deepEqual([...saved.fallbackIds],['7','8']);
    api.stageCleanerAction({kind:'tag',id:'7'});
    await assert.rejects(api.recoverCleanerCheckpoint(api.cleanerCheckpoint()), /不会重复添加/);
    label='AIGC跑量';
    await api.recoverCleanerCheckpoint(api.cleanerCheckpoint());
    assert.deepEqual([...state.tagged],['7']);
    assert.equal(api.cleanerCheckpoint().fallbackIds.length,0);
    assert.ok(acted.every(page => page===4));
  });
}

for (const [name,width] of Object.entries({'chase':380,'live-speed':390,'task-governor':390,'zero-cost-cleaner':380})) {
  test(name+': Android panel and launcher keep their rendered size while pinching and panning', () => {
    const style = new Map(), launcher = {isConnected:true,style:{},dataset:{}};
    const host = {style:{setProperty:(k,v) => style.set(k,v)},dataset:{}};
    const shadow = {host};
    const viewport = {width:1200,height:900,scale:1,offsetLeft:0,offsetTop:0,addEventListener(){}};
    const window = {visualViewport:viewport,innerWidth:1200,innerHeight:900,addEventListener(){}};
    const create = vm.runInNewContext(
      extract(name+'-android', 'function createAndroidLauncherPosition(', '  const launcherPlacement') +
      'createAndroidLauncherPosition', {
        GM_getValue:(_key,fallback) => fallback, window,
        document:{querySelectorAll:() => [],addEventListener(){},dispatchEvent() {}}, Event
      });
    const ui = create(shadow,'slot',0);
    const property = key => parseFloat(style.get('--qc-panel-'+key));
    ui.bind(launcher,() => {});
    assert.equal(property('width'),width);
    assert.equal(property('scale'),1);
    const normalHeight = parseFloat(launcher.style.height);
    Object.assign(viewport,{width:600,height:450,scale:2,offsetLeft:140,offsetTop:60});
    ui.bind(launcher,() => {});
    assert.equal(property('width'),width);
    assert.equal(property('scale')*viewport.scale,1);
    assert.equal(property('top'),66);
    assert.equal(property('right'),466);
    assert.equal(launcher.style.width,'34px');
    assert.equal(parseFloat(launcher.style.height),normalHeight);
    assert.equal(launcher.style.transform,'scale(0.5)');
    Object.assign(viewport,{width:160,height:380});
    ui.bind(launcher,() => {});
    assert.equal(property('width'),296);
    assert.equal(property('height'),736);
  });
}
