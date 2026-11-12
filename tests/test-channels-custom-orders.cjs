const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('视频号标准订单逐单加热助手.user.js','utf8');
const functions=source.slice(source.indexOf('  function clean('),source.indexOf('  // 关闭标签页期间'));
const state={account:'测试账户',roiMinimum:'',queue:[],index:0,edits:{},logs:[],matches:[],choices:{}};
const messages=[],context={state,URL,location:{href:'https://channels.weixin.qq.com/promote/pages/platform/create-order?orderType=standard&sourcePromotionId=123'},Number,Date,console,busy:false,tabId:'test',STORE_KEY:'test',GM_setValue(){},window:{},document:{body:{innerText:''}}};
vm.createContext(context);
vm.runInContext(functions+`\nrender=()=>{};log=message=>messages.push(message);ensureAccount=()=>{};tick=()=>{};
  globalThis.api={state,targetName,targetBudget,orderDraft,validateTarget,selectedDraftTotal,queueApprovalKey,approvedFor,verifyReviewAmounts,guardNewForm,prepareNewForm,paidDetail,startQueue,
  mock(config){visible=el=>!!el&&el.visible!==false;reviewInfo=()=>config.info;
    waitUntil=async(check,label)=>{for(let i=0;i<4;i++){const result=check();if(result)return result;}throw Error(label+'等待超时');};
    onList=()=>false;paymentPrompt=()=>false;
  }};`,Object.assign(context,{messages}));
const {api}=context;
const old={id:'123',name:'原名称',budget:100};
assert.equal(api.targetName(old),'原名称');assert.equal(api.targetBudget(old),100);
assert.equal(api.orderDraft(old).name,'原名称');assert.equal(api.orderDraft(old).budget,'100');
for(const amount of [100,200,300,300000,'100.00'])assert.equal(api.validateTarget('新名称',amount).targetBudget,Number(amount));
for(const amount of [0,99,150,300100,NaN,Infinity,'1e3','',100.01])assert.throws(()=>api.validateTarget('新名称',amount));
assert.throws(()=>api.validateTarget('',100));assert.throws(()=>api.validateTarget('名'.repeat(26),100));
const item={...old,targetName:'新名称',targetBudget:300,result:'pending'};
state.queue=[item];state.names='原名称';state.matches=[old];state.choices={'原名称':'123'};
state.edits={'123':{name:'新名称',budget:'300'}};
assert.equal(api.selectedDraftTotal(),300);
state.approvedQueueKey=api.queueApprovalKey();assert.equal(api.approvedFor(item),true);
item.targetBudget=400;assert.equal(api.approvedFor(item),false);item.targetBudget=300;
item.targetName='修改后';assert.equal(api.approvedFor(item),false);item.targetName='新名称';
assert.equal(old.budget,100);assert.equal(old.name,'原名称');
assert.equal(api.verifyReviewAmounts({budget:300,amount:234.51,couponPresent:true,couponAmount:65.49},item),65.49);
assert.throws(()=>api.verifyReviewAmounts({budget:100,amount:100},item),/预算/);
api.guardNewForm(item,{sourceId:'123',name:'原名称',budget:100});
assert.throws(()=>api.guardNewForm(item,{sourceId:'456',name:'原名称',budget:100}),/来源订单 ID/);
assert.throws(()=>api.guardNewForm(item,{sourceId:'123',name:'其他名称',budget:100}),/名称/);
assert.throws(()=>api.guardNewForm(item,{sourceId:'123',name:'原名称',budget:900}),/预算/);
assert.throws(()=>api.guardNewForm({...item,submittedAt:1},{sourceId:'123',name:'原名称',budget:100}),/已经发起过提交/);
class Input{
  constructor(value,onInput){this._value=value;this.onInput=onInput;this.visible=true;}
  get value(){return this._value;}set value(value){this._value=value;}
  focus(){}blur(){}dispatchEvent(event){if(event.type==='input')this.onInput?.(this.value);}
}
context.HTMLInputElement=Input;context.Event=class{constructor(type){this.type=type;}};
(async()=>{
  const info={sourceId:'123',name:'原名称',budget:100,amount:100,couponPresent:false};let labelClicks=0,doneClicks=0,pendingBudget;
  const nameInput=new Input('原名称',value=>info.name=value),budgetInput=new Input('',value=>pendingBudget=Number(value));
  const label={click(){labelClicks++;}};
  const done={innerText:'完成',classList:{contains:()=>false},click(){doneClicks++;info.budget=pendingBudget;info.amount=pendingBudget;}};
  const custom={querySelectorAll:selector=>selector==='label'?[label]:selector==='button'?[done]:[budgetInput]};
  context.document.querySelectorAll=selector=>selector.includes('输入订单名称')?[nameInput]:[custom];
  api.mock({info});await api.prepareNewForm();
  assert.equal(info.name,'新名称');assert.equal(info.budget,300);assert.equal(labelClicks,1);assert.equal(doneClicks,1);
  assert.equal(item.name,'原名称');assert.equal(item.budget,100);
  await api.prepareNewForm();assert.equal(doneClicks,1); // 已按目标填写后不重复应用预算。
  context.document.body.innerText='加热详情 订单审核中 订单消耗 ¥0/¥300';state.reviewUrl='old';
  assert.equal(api.paidDetail(),true);
  context.document.body.innerText='加热详情 订单审核中 订单消耗 ¥0/¥100';assert.equal(api.paidDetail(),false);
  state.stage='ready';state.scanComplete=true;state.edits={'123':{name:'快照新名称',budget:'400'}};
  context.shadow={getElementById:id=>({value:state[id]})};
  await api.startQueue();assert.equal(state.queue[0].targetBudget,400);assert.equal(state.queue[0].targetName,'快照新名称');assert.equal(state.queue[0].budget,100);
  state.edits['123'].name='再次修改';assert.equal(state.queue[0].targetName,'快照新名称');
  assert.equal(api.approvedFor(state.queue[0]),true);
  console.log('通过：默认继承、逐单草稿、平台名称/金额限制、授权绑定自定义值、源订单隔离、实际表单填写与重复应用保护、优惠券及支付后目标预算核对、启动快照。');
})().catch(error=>{console.error(error);process.exitCode=1;});
