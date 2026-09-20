'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runAgent, runAgentOnce } = require('../../src/agent/runtime');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

function runtimeHarness() {
  let usageOptions;
  let limitsDeps;
  const limitsRefresh = deferred();
  const deps = {
    deviceRuntimeDeps: {
      createUsageRuntime(options) {
        usageOptions = options;
        return { stop() {}, tick() {}, refreshClient() {} };
      },
      createLimitsRuntime(_options, nextDeps) {
        limitsDeps = nextDeps;
        return {
          clear() {},
          getSnapshot() { return { providers: [] }; },
          reconfigure() {},
          refresh() { return limitsRefresh.promise; },
          stop() {}
        };
      }
    }
  };
  return {
    deps,
    limitsRefresh,
    limitsUpdate: (summary) => limitsDeps.onUpdate(summary),
    usageError: (error) => usageOptions.onError(error, 'startup'),
    usageUpdate: (summary) => usageOptions.onUpdate(summary, 'startup')
  };
}

function usageSummary(tokens = 1) {
  return {
    deviceId: 'device-1',
    updatedAt: 'usage-time',
    today: { totalTokens: tokens },
    month: { totalTokens: tokens },
    allTime: { totalTokens: tokens }
  };
}

test('long-running agent posts usage before hung limits and never overlaps posts', async () => {
  const harness = runtimeHarness();
  const firstSend = deferred();
  const delivered = [];
  let active = 0;
  let maxActive = 0;
  const runtime = runAgent({
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    async deliver(record) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      delivered.push(record);
      if (delivered.length === 1) await firstSend.promise;
      active -= 1;
    }
  }, harness.deps);

  harness.usageUpdate(usageSummary(10));
  await new Promise(setImmediate);
  assert.equal(delivered.length, 1);
  harness.limitsUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  await new Promise(setImmediate);
  assert.equal(delivered.length, 1);
  firstSend.resolve();
  await runtime.flush();

  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].today.totalTokens, 10);
  assert.equal(delivered[1].limits.updatedAt, 'limits-time');
  assert.equal(maxActive, 1);
  runtime.stop();
});

test('long-running agent reports one owned error for a failed delivery', async () => {
  const harness = runtimeHarness();
  const expected = new Error('post failed');
  const errors = [];
  const runtime = runAgent({
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async () => { throw expected; },
    onError: (...args) => errors.push(args)
  }, harness.deps);

  harness.usageUpdate(usageSummary(9));
  await runtime.flush();
  assert.deepEqual(errors, [[expected, 'sink']]);
  runtime.stop();
});

test('normal once posts usage immediately and a changed limits record second', async () => {
  const harness = runtimeHarness();
  const delivered = [];
  const running = runAgentOnce({
    uploadIntervalMs: 600000,
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async (record) => delivered.push(record)
  }, harness.deps);

  harness.usageUpdate(usageSummary(11));
  await new Promise(setImmediate);
  assert.equal(delivered.length, 1);
  harness.limitsUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  harness.limitsRefresh.resolve();
  const final = await running;

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].today.totalTokens, 11);
  assert.equal(delivered[1].limits.updatedAt, 'limits-time');
  assert.deepEqual(final, delivered[1]);
});

test('dry-run once waits for bounded limits and emits one final JSON record', async () => {
  const harness = runtimeHarness();
  const delivered = [];
  const running = runAgentOnce({
    uploadIntervalMs: 600000,
    dryRun: true,
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async (record) => delivered.push(record)
  }, harness.deps);

  harness.usageUpdate(usageSummary(12));
  await new Promise(setImmediate);
  assert.deepEqual(delivered, []);
  harness.limitsUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  harness.limitsRefresh.resolve();
  await running;

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].today.totalTokens, 12);
  assert.equal(delivered[0].limits.updatedAt, 'limits-time');
});

test('once does not duplicate when the initial limits pass has no new publish', async () => {
  const harness = runtimeHarness();
  const delivered = [];
  const running = runAgentOnce({
    uploadIntervalMs: 600000,
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async (record) => delivered.push(record)
  }, harness.deps);

  harness.usageUpdate(usageSummary(13));
  harness.limitsRefresh.resolve();
  await running;
  assert.equal(delivered.length, 1);
});

test('once rejects and stops when the initial usage collection fails', async () => {
  const harness = runtimeHarness();
  const running = runAgentOnce({
    uploadIntervalMs: 600000,
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async () => {}
  }, harness.deps);
  harness.usageError(new Error('usage failed'));
  await assert.rejects(running, /usage failed/);
});


test('agent coalesces usage and limits together without slowing local updates', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const harness = runtimeHarness();
  const delivered = [];
  const runtime = runAgent({
    envelope: { deviceId: 'device-1' },
    uploadIntervalMs: 600000,
    deliver: async record => { delivered.push(record); }
  }, harness.deps);
  harness.usageUpdate(usageSummary(1));
  await runtime.flush();
  harness.usageUpdate(usageSummary(2));
  harness.limitsUpdate({ updatedAt: 'new-limits', refreshMs: 300000, providers: [] });
  harness.usageUpdate(usageSummary(3));
  t.mock.timers.tick(599999);
  assert.equal(delivered.length, 1);
  t.mock.timers.tick(1);
  await runtime.flush();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].today.totalTokens, 3);
  assert.equal(delivered[1].limits.updatedAt, 'new-limits');
  runtime.stop();
});

// The Hub must not replace a newer throttled agent observation with an older
// desktop observation (or its notConfigured row) between agent uploads.
test('throttled agent keeps its newer quotas eligible through the upload interval', async () => {
  const { aggregateDevices } = require('../../src/shared/usage');
  const harness = runtimeHarness();
  const delivered = [];
  const observedAt = '2026-09-20T13:00:00.000Z';
  const runtime = runAgent({
    envelope: { deviceId: 'device-1' },
    uploadIntervalMs: 600000,
    deliver: async (record) => delivered.push(record)
  }, harness.deps);
  try {
    harness.limitsUpdate({ updatedAt: observedAt, refreshMs: 300000, providers: [
      { provider: 'deepseek', status: 'ok', updatedAt: observedAt, windows: [] },
      { provider: 'volcengine', status: 'ok', updatedAt: observedAt, windows: [] }
    ] });
    harness.usageUpdate({ ...usageSummary(), updatedAt: observedAt });
    await runtime.flush();
    const agent = { ...delivered[0], receivedAt: '2026-09-20T13:05:00.000Z' };
    const desktop = {
      ...usageSummary(), deviceId: 'desktop', syncUploadIntervalMs: 1800000,
      receivedAt: '2026-09-20T12:46:00.000Z',
      limits: { refreshMs: 300000, providers: [
        { provider: 'deepseek', status: 'ok', updatedAt: '2026-09-20T12:46:00.000Z', windows: [] },
        { provider: 'volcengine', status: 'notConfigured', updatedAt: '2026-09-20T12:46:00.000Z', windows: [] }
      ] }
    };
    const stats = aggregateDevices([agent, desktop], 600000, Date.parse('2026-09-20T13:11:00.000Z'));
    for (const provider of ['deepseek', 'volcengine']) {
      const row = stats.limits.providers.find((entry) => entry.provider === provider);
      assert.equal(row.sourceDeviceId, 'device-1', provider);
      assert.equal(row.status, 'ok');
      assert.equal(row.stale, false);
    }
    assert.equal(delivered[0].syncUploadIntervalMs, 600000);
  } finally {
    runtime.stop();
  }
});

for (const [configured, expected] of [[0, 0], [undefined, 0], ['1200000', 1200000], [1800000, 1800000], [-1, 0], [12345, 0]]) {
  test(`agent advertises normalized upload interval for ${configured}`, async () => {
    const harness = runtimeHarness();
    const delivered = [];
    const runtime = runAgent({
      envelope: { deviceId: 'device-1', syncUploadIntervalMs: 1800000 },
      uploadIntervalMs: configured,
      deliver: async (record) => delivered.push(record)
    }, harness.deps);
    try {
      harness.usageUpdate(usageSummary());
      await runtime.flush();
      assert.equal(delivered[0].syncUploadIntervalMs, expected);
    } finally {
      runtime.stop();
    }
  });
}

test('one-shot agent does not advertise throttling that it bypasses', async () => {
  const harness = runtimeHarness();
  const delivered = [];
  const running = runAgentOnce({
    envelope: { deviceId: 'device-1' }, uploadIntervalMs: 600000,
    deliver: async (record) => delivered.push(record)
  }, harness.deps);
  harness.usageUpdate(usageSummary());
  harness.limitsRefresh.resolve();
  await running;
  assert.equal(delivered[0].syncUploadIntervalMs, 0);
});
