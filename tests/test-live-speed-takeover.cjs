const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const today = '2026-11-15';
const yesterday = '2026-11-14';
const lock = { accountId: '100', planId: '200' };

function takeoverFixture(platform, pendingDay, scan, capCents = 160000, options = {}) {
  const code = fs.readFileSync('qianchuan-live-speed-' + platform + '.user.js', 'utf8');
  const start = code.indexOf('  function localTakeoverSource(');
  const end = code.indexOf('  function requestStop(', start);
  const old = {
    ...lock, day: pendingDay, owner: 'original-tab', startedAt: Date.now() - 10000,
    status: options.submitting ? 'submitting' : 'needs_review', hours: 2,
    pending: { name: 'old-submission', budgetCents: 20000 }
  };
  const state = {
    lock,
    run: { ...lock, day: today, owner: 'new-tab', startedAt: Date.now() - 1000, status: 'needs_review',
      takeoverCheckPending: true, takeoverSource: old }
  };
  const tabToken = options.sameTab ? old.owner : 'new-tab';
  const originalRunKey = 'qc-live-speed-scheduler-run-v2-' + old.owner;
  const newRunKey = options.sameTab ? originalRunKey : 'new-run';
  if (options.submitting) state.run = options.sameTab ? old : null;
  const storage = new Map([['plan', options.submitting ? {
    owner: old.owner, startedAt: old.startedAt, day: old.day, status: old.status
  } : state.run]]);
  if (state.run) storage.set(newRunKey, state.run);
  if (options.submitting && !options.missingMetadata) storage.set(originalRunKey, old);
  const messages = [];
  let scans = 0;
  const context = {
    state, tabToken, RUN_KEY: newRunKey, LEGACY_RUN_KEY: 'legacy-run', Date,
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    render() {}, readCfg: () => ({ budgetCents: 20000, capCents, intervalMinutes: 120, hours: 2 }),
    assertIdentity() {}, planRunKey: () => 'plan',
    activeRun: run => ['needs_review', 'scheduled', 'submitting'].includes(run?.status),
    assertLease: () => assert.equal(storage.get('plan').owner, tabToken),
    saveRun: () => storage.set(newRunKey, state.run),
    localDay: () => today, runDay: run => run.day, firstSubmitKey: () => 'submitted-today',
    log: message => messages.push(message), report() {}, phase() {},
    setTimeout: callback => callback(), scanToday: async () => { scans++; return scan; },
    yuan: value => (value / 100).toFixed(2), timeText: String, LATE_MS: 300000,
    stopRun: (message, status) => { state.run.status = status; state.run.reason = message; }
  };
  vm.createContext(context);
  vm.runInContext(code.slice(start, end), context);
  return { state, storage, messages, originalRunKey, takeover: context.takeoverLocal, get scans() {return scans;} };
}

for (const platform of ['windows', 'android']) {
  const latest = {
    id: '321', name: 'today-task', day: today, mode: '一键起量',
    goal: '直播间购买', budgetCents: 20000, createdAt: Date.now()
  };
  const scan = { items: [latest], totalCents: 20000 };

  test(platform + ' takes over a confirmed task even when the old tab still says submitting', async () => {
    const matched = {...latest, name:'old-submission', hours:2, state:'调控中'};
    for (const sameTab of [false,true]) {
      const fixture = takeoverFixture(platform, today, {items:[matched],totalCents:20000},
        undefined, {submitting:true,sameTab});
      await fixture.takeover();
      assert.equal(fixture.scans, 1);
      assert.equal(fixture.state.run.status, 'scheduled');
      assert.equal(fixture.state.run.nextAt, matched.createdAt + 120*60000);
      assert.equal(fixture.state.run.confirmed[0].id, matched.id);
      assert.equal(fixture.state.run.lastTodayCents, 20000);
      assert.equal(fixture.storage.get('submitted-today'), true);
      assert.equal(fixture.storage.get(fixture.originalRunKey).status, sameTab ? 'scheduled' : 'stopped');
    }
  });

  test(platform + ' pauses takeover if the active task cannot be matched uniquely', async () => {
    const matched = {...latest, name:'old-submission', hours:2, state:'调控中'};
    for (const [items, missingMetadata] of [
      [[{...matched,name:'another-active-task'}],false],
      [[{...matched,hours:3}],false],
      [[matched,{...matched,id:'999'}],false],
      [[matched],true]
    ]) {
      const fixture = takeoverFixture(platform, today, {items,totalCents:20000},
        undefined, {submitting:true,missingMetadata});
      await fixture.takeover();
      assert.equal(fixture.scans, 1);
      assert.equal(fixture.state.run.status, 'needs_review');
      assert.equal(fixture.state.run.nextAt, 0);
      assert.equal(fixture.storage.has('submitted-today'), false);
    }
  });

  test(platform + ' stale callbacks cannot overwrite a replacement run with the same tab token', () => {
    const code = fs.readFileSync('qianchuan-live-speed-' + platform + '.user.js', 'utf8');
    const start = code.indexOf('  function saveRun()');
    const end = code.indexOf('  function saveCfg()', start);
    const prior = {owner:'shared-tab',startedAt:1,status:'submitting'};
    const replacement = {owner:'shared-tab',startedAt:2,status:'scheduled'};
    const state = {run:prior};
    const saved = new Map([['run',replacement],['lease',replacement]]);
    const saveRun = vm.runInNewContext(code.slice(start,end)+'saveRun', {
      state, RUN_KEY:'run', planRunKey:() => 'lease', render() {},
      GM_getValue:(key,fallback) => saved.get(key) ?? fallback,
      GM_setValue:(key,value) => saved.set(key,value), activeRun:() => true
    });
    saveRun();
    assert.equal(saved.get('run'),replacement);
    assert.equal(saved.get('lease'),replacement);
    state.run={...replacement,status:'stopped'};
    saveRun();
    assert.equal(saved.get('run').status,'stopped');
    assert.equal(saved.get('lease').status,'stopped');
  });

  test(platform + ' takeover uses today’s task after an unresolved prior-day submission', async () => {
    const { state, storage, messages, takeover } = takeoverFixture(platform, yesterday, scan);
    await takeover();
    assert.equal(state.run.status, 'scheduled');
    assert.equal(state.run.nextAt, latest.createdAt + 120 * 60000);
    assert.equal(state.run.lastTodayCents, 20000);
    assert.equal(state.run.confirmed[0].id, '321');
    assert.equal(storage.get('submitted-today'), true);
    assert.ok(messages.some(message => message.includes(yesterday)));
  });

  test(platform + ' takeover still checks an unresolved submission from today', async () => {
    const { state, storage, takeover } = takeoverFixture(platform, today, scan);
    await takeover();
    assert.equal(state.run.status, 'needs_review');
    assert.match(state.run.reason, /old-submission/);
    assert.equal(state.run.nextAt, 0);
    assert.equal(storage.has('submitted-today'), false);
  });

  test(platform + ' takeover counts today’s budget when enforcing the cap', async () => {
    const { state, takeover } = takeoverFixture(platform, yesterday, scan, 30000);
    await takeover();
    assert.equal(state.run.status, 'complete');
    assert.equal(state.run.lastTodayCents, 20000);
  });
}
