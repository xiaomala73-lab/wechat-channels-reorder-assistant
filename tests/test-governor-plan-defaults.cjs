const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const products={
 '1852467269069907':'1.5','1867759385277658':'1.5','1874562792641564':'1.5',
 '1871602977211450':'1.5','1867205504686219':'1.5','1861549677969523':'2.2',
 '1840851764337800':'2','1832800495529143':'2.3','1832698672535955':'2.3','1832698376359401':'2.3'};
const lives={'1832698106712151':'2.3','1837421927864619':'1.5'};
function load(platform,saved={},lock=null){
 const source=fs.readFileSync(`qianchuan-task-governor-${platform}.user.js`,'utf8');
 const store=new Map([['qc-task-governor-config-v1',saved],['qc-task-governor-lock-v1-test',lock]]);
 const context={console,sessionStorage:{getItem:()=> 'test'},GM_getValue:(k,f)=>store.has(k)?structuredClone(store.get(k)):f,
 GM_setValue:(k,v)=>store.set(k,structuredClone(v)),source};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('    const CFG_KEY'),source.indexOf("    host.style.cssText = 'position:fixed;z-index"))+`
 const shadow={getElementById:()=>null};
 function render(){};
 globalThis.api={cfg,state,lockCurrent,settings,PLAN_ROI_DEFAULTS,
 lock(kind,planId,accountId='123'){detailIdentity=()=>({kind,planId,accountId,planName:'test'});lockCurrent();},
 select(action){changeAction(action);}};`,context);
 return {api:context.api,store,source};
}
for(const platform of ['windows','android']){
 test(`${platform}: exact preset maps and version/update metadata`,()=>{
  const {api,source}=load(platform);
  assert.deepEqual(JSON.parse(JSON.stringify(api.PLAN_ROI_DEFAULTS)),{product:products,live:lives});
  for(const id of [...Object.keys(products),...Object.keys(lives)])assert.match(id,/^\d{16}$/);
  const version=platform==='windows'?'0.1.13':'0.1.18';
  assert.match(source,new RegExp('@version\\s+'+version.replaceAll('.','\\.')));
  for(const key of ['updateURL','downloadURL']) {
   const line=source.split('\n').find(line=>line.startsWith('// @'+key+' '));
   assert.equal(line.trim().split(/\s+/).at(-1),`https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-${platform}.user.js`);
  }
 });
 test(`${platform}: busy operations cannot change plan or defaults`,()=>{
  const {api}=load(platform);api.lock('product','1852467269069907');api.cfg.productRoi='1.9';
  api.state.busy=true;api.lock('product','1861549677969523');api.select('live-delete');
  assert.equal(api.state.lock.planId,'1852467269069907');assert.equal(api.cfg.productRoi,'1.9');
  assert.equal(api.cfg.action,'product-delete');
 });
 test(`${platform}: changed account binding resets even with identical plan ID`,()=>{
  const h=load(platform);h.api.lock('product','1852467269069907');h.api.cfg.productRoi='99';h.api.settings();
  const next=load(platform,h.store.get('qc-task-governor-config-v1'),{...h.api.state.lock,accountId:'456'});
  assert.equal(next.api.cfg.productRoi,'1.5');
 });
 test(`${platform}: all ten product plan defaults and default action`,()=>{
  const {api}=load(platform,{action:'live-budget',productRoi:'99'});
  for(const [id,roi] of Object.entries(products)){
   api.lock('product',id);
   assert.equal(api.cfg.action,'product-delete');assert.equal(api.cfg.productRoi,roi);
   assert.equal(api.settings().marketingRoi,Number(roi));
   assert.equal(api.state.preview,null);
  }
 });
 test(`${platform}: both live deletion defaults apply on selection`,()=>{
  const {api}=load(platform,{action:'live-budget',liveBudgetRoi:'4',gap:'10',add:'20'});
  for(const [id,roi] of Object.entries(lives)){
   api.select('live-budget');api.lock('live',id); assert.equal(api.cfg.action,'live-budget');
   api.select('live-delete');assert.equal(api.cfg.liveDeleteRoi,roi);
   assert.equal(api.settings().roi,Number(roi));
   assert.equal(api.cfg.liveBudgetRoi,'4');
  }
 });
 test(`${platform}: unknown or wrong-kind IDs clear ROI and require manual entry`,()=>{
  const {api}=load(platform,{productRoi:'99',liveDeleteRoi:'99'});
  for(const id of ['9999999999999999',...Object.keys(lives)]){
   api.lock('product',id);assert.equal(api.cfg.productRoi,'');assert.throws(()=>api.settings(),/ROI/);
  }
  for(const id of ['9999999999999999',...Object.keys(products)]){
   api.lock('live',id);api.select('live-delete');assert.equal(api.cfg.liveDeleteRoi,'');
   assert.throws(()=>api.settings(),/ROI/);
  }
 });
 test(`${platform}: relock restores preset, edits survive settings and matching reload`,()=>{
  const h=load(platform);h.api.lock('product','1852467269069907');h.api.cfg.productRoi='1.8';
  assert.equal(h.api.settings().marketingRoi,1.8);
  const reloaded=load(platform,h.store.get('qc-task-governor-config-v1'),h.api.state.lock);
  assert.equal(reloaded.api.cfg.productRoi,'1.8');
  h.api.lock('product','1852467269069907');assert.equal(h.api.cfg.productRoi,'1.5');
 });
 test(`${platform}: old restored lock cannot inherit another plan's threshold`,()=>{
  const {api}=load(platform,{action:'product-delete',productRoi:'99',liveDeleteRoi:'99'},
   {kind:'product',planId:'9999999999999999',accountId:'123',planName:'test'});
  assert.equal(api.cfg.productRoi,'');
 });
 test(`${platform}: choosing action invalidates preview and saves preset`,()=>{
  const h=load(platform);h.api.lock('live','1832698106712151');h.api.state.preview={targets:[1]};
  h.api.select('live-delete');assert.equal(h.api.state.preview,null);
  assert.equal(h.store.get('qc-task-governor-config-v1').liveDeleteRoi,'2.3');
  assert.match(h.source,/onchange = e => \{ changeAction\(e.target.value\); \}/);
 });
}
