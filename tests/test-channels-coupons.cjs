const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('视频号标准订单逐单加热助手.user.js','utf8');
const block=source.slice(source.indexOf('  function reviewInfo()'),source.indexOf('  function verifyReview()'));
const rows={'订单预算':'订单预算 ¥200','需支付':'需支付 ¥134.51','优惠券':'优惠券 65.49元优惠券，抵扣 -¥65.49'};
const labels=Object.keys(rows).map(label=>({innerText:label,parentElement:{parentElement:{innerText:rows[label]}}}));
const card={innerText:'加热短视频 需支付 我已阅读并同意微信视频号企业账号加热功能服务协议',querySelectorAll:()=>labels};
const context={URL,targetBudget:item=>item.targetBudget??item.budget,location:{href:'https://channels.weixin.qq.com/promote/pages/platform/create-order?orderType=standard&sourcePromotionId=123'},visible:()=>true,text:el=>el?.innerText||'',document:{querySelectorAll:selector=>selector==='.finder-card'?[card]:[{value:'增香液-1'}]}};
vm.createContext(context);vm.runInContext(block+'\nglobalThis.api={reviewInfo,verifyReviewAmounts};',context);
const {reviewInfo,verifyReviewAmounts}=context.api,item={budget:200},info=reviewInfo();
assert.equal(info.name,'增香液-1');assert.equal(info.sourceId,'123');assert.equal(info.couponAmount,65.49);
assert.equal(verifyReviewAmounts(info,item),65.49);
assert.equal(verifyReviewAmounts({budget:200,amount:200,couponPresent:false},item),0);
assert.equal(verifyReviewAmounts({budget:200,amount:0,couponPresent:true,couponAmount:200},item),200);
assert.equal(verifyReviewAmounts({budget:100,amount:99.99,couponPresent:true,couponAmount:0.01},{budget:100}),0.01);
for(const bad of [
  {...info,budget:300}, {...info,amount:201}, {...info,amount:-1}, {...info,amount:NaN},
  {...info,amount:134.511}, {...info,couponPresent:false}, {...info,couponAmount:65},
  {...info,amount:200}, {...info,couponAmount:NaN},
])assert.throws(()=>verifyReviewAmounts(bad,item));
assert.throws(()=>verifyReviewAmounts({...info,budget:NaN},item));
console.log('通过：截图200元预算/65.49元券/实付134.51元、无券、全额券、分币精度及预算/实付/抵扣异常拦截。');
