const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'qianchuan-live-speed-windows.user.js'), 'utf8');
const start = source.indexOf('  function isEmptyTaskText(');
const end = source.indexOf('\n  function emptyTaskList', start);
function load() {
  if (start < 0 || end < 0) throw new Error('empty-state helper not found');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.isEmptyTaskText = isEmptyTaskText;', context);
  return context.isEmptyTaskText;
}
test('windows: recognizes platform empty-state copy with intervening qualification', () => {
  const isEmpty = load();
  assert.equal(isEmpty('暂无符合条件的数据'), true);
  assert.equal(isEmpty('未查询到符合条件的任务'), true);
  assert.equal(isEmpty('未查询到相关记录'), true);
  assert.equal(isEmpty('共 0 条'), true);
  assert.equal(isEmpty('任务名称 任务预算 任务状态'), false);
});
