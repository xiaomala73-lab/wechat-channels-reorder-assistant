const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('视频号标准订单逐单加热助手.user.js','utf8');
const functions=source.slice(source.indexOf('  function clean('),source.indexOf('  // 关闭标签页期间'));
function environment(pages,startPage=1){
 let page=startPage,now=1000,saves=0,changedAccount=false,readHook=null;
 const jumps=[],logs=[];
 const state={queue:[],index:0,matches:[],account:'account',lastSourcePage:0};
 class Clock extends Date{static now(){return now;}}
 const c={state,Date:Clock,URL,Number,console,scanCancel:false,location:{href:'https://channels.weixin.qq.com/promote/pages/platform/order-list?tab=standard'}};
 vm.createContext(c);vm.runInContext(functions+`\nrender=()=>{};
  globalThis.api={locateSourceOrder,stableOrderPage,scanPages,queueApprovalKey,approvedFor,
   setup(mocks){onList=()=>true;ensureAccount=mocks.ensureAccount;pageNumber=mocks.pageNumber;maxPage=mocks.maxPage;
    readRows=mocks.readRows;gotoPage=mocks.gotoPage;waitUntil=mocks.waitUntil;save=mocks.save;log=mocks.log;},
   cancel(){scanCancel=true;}};`,c);
 c.api.setup({ensureAccount(){if(changedAccount)throw Error('账户已切换');},pageNumber:()=>page,maxPage:()=>pages.length,
  readRows(){readHook?.();return (pages[page-1]||[]).map(row=>({...row,page}));},
  gotoPage:async target=>{if(target!==page){jumps.push(target);page=target;}},
  waitUntil:async(check,label,ms=18000)=>{const end=now+ms;while(now<end){const value=check();if(value)return value;now+=250;}throw Error(label+'等待超时');},
  save:()=>saves++,log:message=>logs.push(message)});
 return {api:c.api,state,jumps,logs,page:()=>page,saves:()=>saves,accountChanged:()=>changedAccount=true,onRead:fn=>readHook=fn};
}
const row=(id,name=id,budget=100)=>({id,name,budget,status:'已结束'});
(async()=>{
 // Normal cached page: never jump to page 1 to begin a new source lookup.
 let e=environment([[row('new')],[row('A'),row('B')],[row('C')]]);
 const a={...row('A'),page:2},b={...row('B'),page:1};e.state.queue=[a,b];e.state.matches=[{...b}];
 e.state.approvedQueueKey=e.api.queueApprovalKey();
 assert.equal((await e.api.locateSourceOrder(a)).id,'A');assert.deepEqual(e.jumps,[2]);assert.equal(b.page,2);
 assert.equal(e.state.matches[0].page,2);assert.equal(e.api.approvedFor(a),true,'updating page hints must retain batch consent');
 e.state.index=1;assert.equal((await e.api.locateSourceOrder(b)).id,'B');assert.deepEqual(e.jumps,[2],'same-page next item avoids a jump');
 // New paid orders push the original source from page 2 to page 3. Cache all siblings found there.
 e=environment([[row('new-A','same-name')],[row('other')],[row('old-A','same-name'),row('old-B')]]);
 const oldA={...row('old-A','same-name'),page:2},oldB={...row('old-B'),page:2};e.state.queue=[oldA,oldB];
 assert.equal((await e.api.locateSourceOrder(oldA)).id,'old-A');assert.deepEqual(e.jumps,[2,3]);
 assert.equal(oldA.page,3);assert.equal(oldB.page,3);assert.equal(e.state.lastSourcePage,3);
 // Payment return may reset the platform to page 1: the next item now jumps straight to page 3.
 const restored=environment([[row('new')],[row('other')],[row('old-A','same-name'),row('old-B')]]);
 restored.state.queue=[oldB];assert.equal((await restored.api.locateSourceOrder(oldB)).id,'old-B');assert.deepEqual(restored.jumps,[3]);
 // Rows can move earlier after deletion/filter changes; forward search wraps only after a miss.
 e=environment([[row('unrelated')],[row('target')],[row('other')],[row('more')]],3);
 const target={...row('target'),page:3};e.state.queue=[target];
 assert.equal((await e.api.locateSourceOrder(target)).id,'target');assert.deepEqual(e.jumps,[4,1,2]);assert.equal(target.page,2);
 // An ID already present on the current page wins over a stale page hint.
 e=environment([[row('target')],[row('other')]]);const here={...row('target'),page:2};e.state.queue=[here];
 await e.api.locateSourceOrder(here);assert.deepEqual(e.jumps,[]);assert.equal(here.page,1);
 // A missing ID must never become a newer same-name source.
 e=environment([[row('new-id','same-name')],[row('newer-id','same-name')]]);
 assert.equal(await e.api.locateSourceOrder({...row('old-id','same-name'),page:2}),null);
 // Changed source data is not silently approved; transient placeholder data still gets a grace period.
 e=environment([[row('target','changed-name')]]);
 await assert.rejects(e.api.locateSourceOrder({...row('target'),page:1}),/锁定记录不符/);
 const changing=[[row('target','loading')]];e=environment(changing);let reads=0;
 e.onRead(()=>{if(++reads===6)changing[0]=[row('target')];});assert.equal((await e.api.locateSourceOrder({...row('target'),page:1})).name,'target');
 e=environment([[row('target','target',NaN)]]);await assert.rejects(e.api.locateSourceOrder({...row('target'),page:1}),/预算完整加载等待超时/);
 e=environment([[row('target')]]);e.accountChanged();await assert.rejects(e.api.locateSourceOrder({...row('target'),page:1}),/账户已切换/);
 e=environment([[row('target')]]);e.api.cancel();await assert.rejects(e.api.locateSourceOrder({...row('target'),page:1}),/已停止/);
 // Initial scan still starts from page 1, picks the foremost exact-name source, and stops when complete.
 e=environment([[row('fresh','A')],[row('old','A'),row('b','B')],[row('older','A')]],3);
 const found=new Map();await e.api.scanPages(['A','B'],found);assert.equal(found.get('A').id,'fresh');assert.deepEqual(e.jumps,[1,2]);
 console.log('通过：记录页直达、同页复用、新单插入向后定位、更新其他待投订单页码、支付返回后复用、必要时回查、精确ID及名称预算保护、延迟加载、账户变化、停止和首轮最靠前匹配。');
})().catch(error=>{console.error(error);process.exitCode=1;});
