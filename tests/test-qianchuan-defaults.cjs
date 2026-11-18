const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const platform of ['windows', 'android']) {
  test(`${platform}: chase assistant defaults female targeting`, () => {
    const source = fs.readFileSync(`qianchuan-chase-${platform}.user.js`, 'utf8');
    const expected = platform === 'windows' ? "liveGender: '女'" : "liveGender: '\\u5973'";
    const reset = platform === 'windows' ? "state.config.liveGender = '女'" : "state.config.liveGender = '\\u5973'";
    assert.match(source, new RegExp(`@version\\s+0\\.4\\.${platform === 'windows' ? '40' : '42'}\\b`));
    assert.ok(source.includes(expected), 'initial gender targeting default should be female');
    assert.ok(source.includes(reset), 'changing plans should restore the female default');
  });

  test(`${platform}: live speed defaults and saved-value compatibility`, () => {
    const source = fs.readFileSync(`qianchuan-live-speed-${platform}.user.js`, 'utf8');
    const start = source.indexOf('  const storedCfg = GM_getValue(');
    const end = source.indexOf('  const state = {', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const setup = source.slice(start, end);
    const version = platform === 'windows' ? '1.2.10' : '1.2.14';
    assert.match(source, new RegExp(`@version\\s+${version.replaceAll('.', '\\.')}\\b`));

    function load(saved) {
      const context = { CFG_KEY: 'cfg', GM_getValue: (_key, fallback) => saved ?? fallback, Number, Object };
      vm.createContext(context);
      vm.runInContext(`${setup}\nglobalThis.result = cfg;`, context);
      return JSON.parse(JSON.stringify(context.result));
    }

    assert.deepEqual(load(null), { budget: 200, hours: 2, intervalHours: 2, dailyCap: 1600 });
    assert.deepEqual(load({ budget: '', hours: '', intervalHours: '', dailyCap: '' }),
      { budget: 200, hours: 2, intervalHours: 2, dailyCap: 1600 });
    assert.deepEqual(load({ budget: 300, hours: 3, intervalHours: '', intervalMinutes: 90, dailyCap: 2000 }),
      { budget: 300, hours: 3, intervalHours: 1.5, intervalMinutes: 90, dailyCap: 2000 });
  });
}
