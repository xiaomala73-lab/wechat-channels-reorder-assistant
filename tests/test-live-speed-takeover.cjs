const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const today = '2026-11-15';
const yesterday = '2026-11-14';
const lock = { accountId: '100', planId: '200' };

function takeoverFixture(platform, pendingDay, scan, capCents = 160000) {
  const code = fs.readFileSync('qianchuan-live-speed-' + platform + '.user.js', 'utf8');
  const start = code.indexOf('  function localTakeoverSource(');
  const end = code.indexOf('  function requestStop(', start);
  const old = {
    ...lock, day: pendingDay, owner: 'original-tab', startedAt: Date.now() - 10000,
    status: 'needs_review', hours: 2, pending: { name: 'old-submission', budgetCents: 20000 }
  };
  const state = {
    lock,
    run: { ...lock, day: today, owner: 'new-tab', startedAt: Date.now() - 1000, status: 'needs_review',
      takeoverCheckPending: true, takeoverSource: old }
  };
  const storage = new Map([['plan', state.run], ['new-run', state.run]]);
  const messages = [];
  const context = {
    state, tabToken: 'new-tab', RUN_KEY: 'new-run', Date,
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    render() {}, readCfg: () => ({ budgetCents: 20000, capCents, intervalMinutes: 120, hours: 2 }),
    assertIdentity() {}, planRunKey: () => 'plan',
    activeRun: run => ['needs_review', 'scheduled', 'submitting'].includes(run?.status),
    assertLease: () => assert.equal(storage.get('plan').owner, 'new-tab'),
    saveRun: () => storage.set('new-run', state.run),
    localDay: () => today, runDay: run => run.day, firstSubmitKey: () => 'submitted-today',
    log: message => messages.push(message), report() {}, phase() {},
    setTimeout: callback => callback(), scanToday: async () => scan,
    yuan: value => (value / 100).toFixed(2), timeText: String, LATE_MS: 300000,
    stopRun: (message, status) => { state.run.status = status; state.run.reason = message; }
  };
  vm.createContext(context);
  vm.runInContext(code.slice(start, end), context);
  return { state, storage, messages, takeover: context.takeoverLocal };
}

for (const platform of ['windows', 'android']) {
  const latest = {
    id: '321', name: 'today-task', day: today, mode: '一键起量',
    goal: '直播间购买', budgetCents: 20000, createdAt: Date.now()
  };
  const scan = { items: [latest], totalCents: 20000 };

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
