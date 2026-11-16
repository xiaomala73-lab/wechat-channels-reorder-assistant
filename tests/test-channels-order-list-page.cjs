const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('视频号标准订单逐单加热助手.user.js','utf8');
const functions=source.slice(source.indexOf('  function clean('),source.indexOf('  // 关闭标签页期间'));

function element(text='', extra={}){
  const children=extra.children||[];
  return {
    isConnected:extra.connected!==false, innerText:text, value:extra.value||'', className:extra.className||'',
    getBoundingClientRect:()=>({width:extra.width??10,height:extra.height??10}),
    getAttribute:name=>extra.attrs?.[name]||null,
    querySelectorAll:selector=>selector===':scope > td' ? children : (extra.querySelectorAll?.(selector)||[]),
    querySelector:selector=>extra.querySelector?.(selector)||null,
    closest:()=>extra.closest||null,
    classList:{contains:name=>!!extra.classes?.includes(name)}
  };
}

function pageApi({direct=null,pager=null,rows=[]}={}){
  const document={
    querySelector:selector=>selector==='.finder-ui-desktop-pagination__num_current'?direct:
      selector==='.finder-ui-desktop-pagination'?pager:null,
    querySelectorAll:selector=>selector==='tr'?rows:[]
  };
  const c={document,getComputedStyle:()=>({display:'block',visibility:'visible'}),
    URL,Number,location:{href:'https://channels.weixin.qq.com/promote/pages/platform/order-list'}};
  vm.createContext(c);
  vm.runInContext(functions+'\nglobalThis.api={pageNumber,standardOrderRowCount,orderTable,orderTotal};',c);
  return c.api;
}

const idCell=element('增香液-20 短视频加热 1794758400_626438');
const dataRow=element('',{children:[idCell,element(''),element(''),element('')]});
// A one-page result may omit the pagination component entirely; visible rows mean page 1.
assert.equal(pageApi({rows:[dataRow]}).pageNumber(),1);
// A rendered active-page marker remains authoritative, including when the old current selector is absent.
const active=element('2',{className:'finder-ui-desktop-pagination__num is-active'});
const pager=element('',{querySelectorAll:selector=>selector.includes('active')?[active]:[],
  querySelector:selector=>selector.includes('__input')?element('',{value:''}):null});
assert.equal(pageApi({pager,rows:[dataRow]}).pageNumber(),2);
// Keep using the platform's existing current-page marker when available.
assert.equal(pageApi({direct:element('3'),rows:[dataRow]}).pageNumber(),3);
// Do not invent page 1 before any order rows have rendered.
assert.equal(pageApi().pageNumber(),0);
console.log('通过：单页无分页控件回退第1页、活动页码识别、原页码优先及空列表不误判。');
