const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load(platform, saved = {}, input = '2.5') {
  const source = fs.readFileSync(`qianchuan-task-governor-${platform}.user.js`, 'utf8');
  const start = source.indexOf('    const CFG_KEY');
  const end = source.indexOf("    host.style.cssText = 'position:fixed;z-index");
  const context = {console, sessionStorage:{getItem:()=> 'test'}, GM_getValue:(key,fallback)=>key.includes('config')?saved:fallback,
    GM_setValue(){}, input};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end)+`
    const shadow = {getElementById: id => id === 'product-roi' ? {value:input} : null};
    function render() {}
    actionKind = () => 'product-delete';
    globalThis.api = {cfg, settings, eligible, setAction(action) {actionKind = () => action;}};
  `,context);
  return {api:context.api, source};
}
for (const platform of ['windows','android']) {
  test(`${platform}: live deletion and budget settings remain independent`,()=>{
    const {api} = load(platform,{liveDeleteRoi:'2',liveBudgetRoi:'3',gap:'5',add:'20'},'');
    api.setAction('live-delete');
    assert.equal(api.settings().roi,2);
    assert.equal(api.eligible({roi:1,status:'调控中',spend:10},api.settings()),true);
    assert.equal(api.eligible({roi:1,status:'调控中',spend:0},api.settings()),false);
    assert.equal(api.eligible({roi:1,status:'调控中',spend:NaN},api.settings()),false);
    api.setAction('live-budget');
    const p = api.settings();
    assert.equal(p.roi,3); assert.equal(p.gap,500); assert.equal(p.add,2000);
    assert.equal(api.eligible({roi:4,status:'调控中',budget:10000,spend:9900},p),true);
    assert.equal(api.eligible({roi:2,status:'调控中',budget:10000,spend:9900},p),false);
  });
  test(`${platform}: form exposes exactly one product ROI input`,()=>{
    const {source} = load(platform);
    assert.equal((source.match(/<input id="product-roi"/g)||[]).length,1);
    assert.doesNotMatch(source, /product-marketing-roi|product-payment-roi/);
  });
  test(`${platform}: budget-paused tasks are eligible only after exhausting the current budget`, () => {
    const {api} = load(platform, {liveBudgetRoi:'1.5', gap:'99', add:'300'}, '');
    api.setAction('live-budget');
    const params = api.settings();
    const paused = {roi:1.66, status:'已暂停 任务预算不足', budget:100000, spend:100000};
    assert.equal(api.eligible(paused, {...params, gap:0}), true);
    assert.equal(api.eligible({...paused, budget:160000}, params), false);
    assert.equal(api.eligible({...paused, budget:105000}, params), false);
    assert.equal(api.eligible({...paused, budget:160000, spend:160000}, params), true);
    assert.equal(api.eligible({...paused, roi:1.49}, params), false);
    assert.equal(api.eligible({...paused, spend:NaN}, params), false);
    assert.equal(api.eligible({...paused, budget:0, spend:0}, params), false);
    assert.equal(api.eligible({...paused, status:'已暂停 手动暂停 任务预算不足'}, params), false);
    assert.equal(api.eligible({...paused, status:'已暂停 账户余额不足'}, params), false);
    assert.equal(api.eligible({...paused, status:'调控中', budget:105000}, params), true);
    assert.equal(api.eligible({...paused, status:'调控中', budget:109900}, params), false);
  });
  test(`${platform}: migrate equal or single old values, never guess unequal values`,()=>{
    for(const [old,expected] of [
      [{productMarketingRoi:'2.5',productPaymentRoi:'2.50'},'2.5'],
      [{productMarketingRoi:'3'},'3'], [{productPaymentRoi:0},'0'],
      [{productDeleteRoi:'4'},'4'], [{productMarketingRoi:'2',productPaymentRoi:'3'},''],
      [{productRoi:'5',productMarketingRoi:'2',productPaymentRoi:'3'},'5'],
      [{productRoi:'',productMarketingRoi:'2',productPaymentRoi:'2'},'']]) {
      assert.equal(String(load(platform,old).api.cfg.productRoi),expected);
    }
  });
  test(`${platform}: invalid shared ROI is rejected, zero remains valid`,()=>{
    for(const value of ['', '-1', '2.555', 'Infinity', 'x']) assert.throws(()=>load(platform,{},value).api.settings(),/ROI/);
    assert.equal(load(platform,{},'0').api.settings().marketingRoi,0);
  });
  test(`${platform}: one threshold populates both detected ROI comparisons`,()=>{
    const {api} = load(platform);
    const p = api.settings();
    assert.equal(p.marketingRoi,2.5); assert.equal(p.paymentRoi,2.5);
    const row = {comprehensiveCost:100, spend:100, marketingRoi:NaN, paymentRoi:NaN};
    assert.equal(api.eligible({...row,marketingRoi:2},p),true);
    assert.equal(api.eligible({...row,paymentRoi:2},p),true);
    assert.equal(api.eligible({...row,marketingRoi:3,paymentRoi:2},p),true);
    assert.equal(api.eligible({...row,marketingRoi:2.5,paymentRoi:2.5},p),false);
    assert.equal(api.eligible({...row,marketingRoi:3},p),false);
    assert.equal(api.eligible(row,p),false);
    assert.equal(api.eligible({...row,marketingRoiDash:true},p),true);
    assert.equal(api.eligible({...row,paymentRoiDash:true},p),true);
    assert.equal(api.eligible({...row,marketingRoi:1,comprehensiveCost:0},p),false);
    assert.equal(api.eligible({...row,paymentRoi:1,spend:0},p),false);
  });
}
