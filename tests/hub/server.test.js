'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createHub, resolveBindHost, resolvePersistIntervalMs } = require('../../src/hub/server');
const { HUB_PERSIST_RETRY_DELAY_MS } = require('../../src/hub/persistenceScheduler');
const { codexAccountKey } = require('../../src/shared/codexAuth');

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-hub-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

function cleanupDataFile(dataFile) {
  fs.rmSync(`${dataFile}.tmp`, { recursive: true, force: true });
  fs.rmSync(dataFile, { force: true });
}

function flushForCleanup(hub) {
  const current = hub.getSubscriptions();
  try {
    hub.setSubscriptions(current.subscriptions, current.updatedAt);
  } catch (_) {
    // A stopped scheduler has already cleared its timer and needs no cleanup flush.
  }
}

function readStore(dataFile) {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

function usagePayload(deviceId, totalTokens) {
  return {
    deviceId,
    updatedAt: new Date().toISOString(),
    today: { totalTokens }
  };
}

function storedTodayTokens(dataFile, deviceId) {
  return readStore(dataFile).devices[deviceId].periods.today.totalTokens;
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${message} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('resolveBindHost keeps the requested host when a secret is set', () => {
  assert.equal(resolveBindHost('0.0.0.0', 's3cret'), '0.0.0.0');
  assert.equal(resolveBindHost('192.168.1.10', 's3cret'), '192.168.1.10');
});

test('resolveBindHost forces localhost when no secret and a non-loopback host is requested', () => {
  assert.equal(resolveBindHost('0.0.0.0', ''), '127.0.0.1');
  assert.equal(resolveBindHost('192.168.1.10', ''), '127.0.0.1');
  assert.equal(resolveBindHost('', ''), '127.0.0.1');
});

test('resolveBindHost leaves an already-loopback host unchanged without a secret', () => {
  assert.equal(resolveBindHost('127.0.0.1', ''), '127.0.0.1');
  assert.equal(resolveBindHost('localhost', ''), 'localhost');
  assert.equal(resolveBindHost('::1', ''), '::1');
});

test('resolvePersistIntervalMs prefers a present CLI value over the environment', () => {
  assert.equal(resolvePersistIntervalMs(
    { persistIntervalMs: '2500' },
    { TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS: '4000' }
  ), 2500);
  assert.equal(resolvePersistIntervalMs(
    { persistIntervalMs: 'invalid' },
    { TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS: '4000' }
  ), 5000);
});

test('resolvePersistIntervalMs uses the environment only when the CLI option is absent', () => {
  assert.equal(resolvePersistIntervalMs(
    {},
    { TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS: '3500' }
  ), 3500);
  assert.equal(resolvePersistIntervalMs({}, {}), 5000);
  assert.equal(resolvePersistIntervalMs(
    {},
    { TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS: 'invalid' }
  ), 5000);
});

test('resolvePersistIntervalMs retains zero from CLI and environment', () => {
  assert.equal(resolvePersistIntervalMs({ persistIntervalMs: '0' }, {}), 0);
  assert.equal(resolvePersistIntervalMs(
    {},
    { TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS: '0' }
  ), 0);
});

test('resolvePersistIntervalMs rejects invalid CLI and environment values', () => {
  const invalidValues = [true, null, '', '   ', -1, '-1', 'nope'];
  for (const value of invalidValues) {
    assert.equal(resolvePersistIntervalMs({ persistIntervalMs: value }, {}), 5000);
    assert.equal(resolvePersistIntervalMs(
      {},
      { TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS: value }
    ), 5000);
  }
});

test('resolvePersistIntervalMs rounds positive fractions up and clamps large values', () => {
  assert.equal(resolvePersistIntervalMs({ persistIntervalMs: '0.1' }, {}), 1);
  assert.equal(resolvePersistIntervalMs(
    {},
    { TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS: '60000.1' }
  ), 60000);
});

test('a hub without a secret binds to localhost only even when asked to bind every interface', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '0.0.0.0', secret: '', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    assert.equal(hub.bindHost, '127.0.0.1');
    assert.equal(hub.server.address().address, '127.0.0.1');
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('health exposes the Node Hub build identity without authentication', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.runtime, 'node-hub');
    assert.equal(health.hubBuild.runtime, 'node-hub');
    assert.match(health.hubBuild.coreBuildId, /^sha256:[a-f0-9]{64}$/);
    assert.match(health.hubBuild.runtimeBuildId, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest inserts a device and is visible in getStats', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    const record = hub.ingest({ deviceId: 'dev-a', today: { totalTokens: 5, costUsd: 0.1 } });
    assert.equal(record.deviceId, 'dev-a');
    assert.equal(hub.getStats().devices.length, 1);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('coalesced ingest is live in memory before the trailing disk write', () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error() {} }
  });
  try {
    hub.ingest(usagePayload('dev-a', 5));
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);

    hub.ingest(usagePayload('dev-a', 9));

    assert.equal(hub.getStats().periods.today.totalTokens, 9);
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);
  } finally {
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('a subscription write persists synchronously when the scheduler is clean', () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error() {} }
  });
  const subscription = { id: 'sub-clean', provider: 'codex', startDate: '2026-08-26' };
  try {
    hub.ingest(usagePayload('dev-a', 5));

    hub.setSubscriptions([subscription], '');

    assert.deepEqual(readStore(dataFile).subscriptions.subscriptions.map((entry) => entry.id), ['sub-clean']);
  } finally {
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('subscription persistence also flushes the newest coalesced device record', () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error() {} }
  });
  const subscription = { id: 'sub-dirty', provider: 'claude', startDate: '2026-08-26' };
  try {
    hub.ingest(usagePayload('dev-a', 5));
    hub.ingest(usagePayload('dev-a', 9));
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);

    hub.setSubscriptions([subscription], '');

    const stored = readStore(dataFile);
    assert.equal(stored.devices['dev-a'].periods.today.totalTokens, 9);
    assert.deepEqual(stored.subscriptions.subscriptions.map((entry) => entry.id), ['sub-dirty']);
  } finally {
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('device deletion flushes pending ingest state immediately', () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error() {} }
  });
  try {
    hub.ingest(usagePayload('delete-me', 3));
    hub.ingest(usagePayload('keep-me', 7));
    assert.equal(readStore(dataFile).devices['keep-me'], undefined);

    hub.deleteDevice('delete-me');

    const stored = readStore(dataFile);
    assert.equal(stored.devices['delete-me'], undefined);
    assert.equal(stored.devices['keep-me'].periods.today.totalTokens, 7);
  } finally {
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('persistIntervalMs zero preserves per-ingest disk writes', () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 0,
    logger: { error() {} }
  });
  try {
    hub.ingest(usagePayload('dev-a', 5));
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);

    hub.ingest(usagePayload('dev-a', 9));
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 9);
  } finally {
    cleanupDataFile(dataFile);
  }
});

test('the trailing timer persists the latest coalesced device record', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 100,
    logger: { error() {} }
  });
  try {
    hub.ingest(usagePayload('dev-a', 5));
    hub.ingest(usagePayload('dev-a', 9));
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);

    await waitFor(
      () => storedTodayTokens(dataFile, 'dev-a') === 9,
      'the Hub trailing write to reach disk'
    );
  } finally {
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('stop drains an in-flight ingest before the final persistence flush', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error() {} }
  });
  let request;
  await hub.start();
  try {
    hub.ingest(usagePayload('dev-a', 5));
    const payload = JSON.stringify(usagePayload('dev-a', 9));
    const requestSeen = new Promise((resolve) => hub.server.once('request', resolve));
    const responsePromise = new Promise((resolve, reject) => {
      const { port } = hub.server.address();
      request = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/ingest',
        method: 'POST',
        headers: {
          connection: 'close',
          'content-length': Buffer.byteLength(payload),
          'content-type': 'application/json'
        }
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ body, statusCode: response.statusCode }));
      });
      request.on('error', reject);
    });

    request.write(payload.slice(0, -1));
    await requestSeen;
    const stopPromise = hub.stop();
    request.end(payload.slice(-1));

    const [response] = await Promise.all([responsePromise, stopPromise]);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 9);
  } finally {
    request?.destroy();
    if (hub.server.listening) await hub.stop();
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('stop rejects a failed final flush after closing the server', async () => {
  const dataFile = tempDataFile();
  const errors = [];
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error(error) { errors.push(error); } }
  });
  const blocker = `${dataFile}.tmp`;
  await hub.start();
  try {
    hub.ingest(usagePayload('dev-a', 5));
    const baselineSavedAt = readStore(dataFile).savedAt;
    hub.ingest(usagePayload('dev-a', 9));
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);
    fs.mkdirSync(blocker);

    await assert.rejects(hub.stop());

    assert.equal(hub.server.listening, false);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(readStore(dataFile).savedAt, baselineSavedAt);
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
    if (hub.server.listening) await hub.stop();
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('stop memoizes concurrent and repeated calls through a failed final flush', async () => {
  const dataFile = tempDataFile();
  const errors = [];
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error(error) { errors.push(error); } }
  });
  const blocker = `${dataFile}.tmp`;
  const settle = (promise) => promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ reason, status: 'rejected' })
  );
  await hub.start();
  try {
    hub.ingest(usagePayload('dev-a', 5));
    hub.ingest(usagePayload('dev-a', 9));
    fs.mkdirSync(blocker);

    const first = hub.stop();
    const second = hub.stop();
    const [firstResult, secondResult] = await Promise.all([settle(first), settle(second)]);

    assert.strictEqual(second, first);
    assert.equal(firstResult.status, 'rejected');
    assert.equal(secondResult.status, 'rejected');
    assert.strictEqual(secondResult.reason, firstResult.reason);
    assert.strictEqual(hub.stop(), first);
    assert.equal(errors.length, 1);
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);
    assert.equal(hub.server.listening, false);
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
    if (hub.server.listening) await hub.stop().catch(() => {});
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('stop synchronously preflushes pending ingest state for fire-and-forget callers', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error() {} }
  });
  let stopPromise;
  await hub.start();
  try {
    hub.ingest(usagePayload('dev-a', 5));
    hub.ingest(usagePayload('dev-a', 9));
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);

    stopPromise = hub.stop();

    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 9);
    await stopPromise;
  } finally {
    if (stopPromise) await stopPromise.catch(() => {});
    if (hub.server.listening) await hub.stop();
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('a throwing logger cannot replace the final persistence rejection', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    dataFile,
    persistIntervalMs: 60000,
    logger: { error() { throw new Error('logger exploded'); } }
  });
  const blocker = `${dataFile}.tmp`;
  await hub.start();
  try {
    hub.ingest(usagePayload('dev-a', 5));
    hub.ingest(usagePayload('dev-a', 9));
    fs.mkdirSync(blocker);

    await assert.rejects(hub.stop(), (error) => {
      assert.notEqual(error.message, 'logger exploded');
      assert.match(error.message, /tm-hub-test/);
      return true;
    });

    assert.equal(hub.server.listening, false);
    assert.equal(storedTodayTokens(dataFile, 'dev-a'), 5);
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
    if (hub.server.listening) await hub.stop().catch(() => {});
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
  }
});

test('getStats exposes the effective staleness threshold', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', staleAfterMs: 123456, dataFile, logger: { error() {} } });
  try {
    assert.equal(hub.getStats().staleAfterMs, 123456);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('Hub keeps same-email Codex Personal and Team workspaces distinct across devices', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', staleAfterMs: 0, dataFile, logger: { error() {} } });
  const email = 'member@example.com';
  const personalKey = codexAccountKey(email, 'workspace-personal');
  const teamKey = codexAccountKey(email, 'workspace-team');
  const provider = (accountKey, remainingPercent, updatedAt) => ({
    provider: 'codex',
    accountKey,
    accountEmail: email,
    status: 'ok',
    source: 'rpc',
    sourceDetail: 'managed',
    updatedAt,
    windows: [{ kind: 'weekly', usedPercent: 100 - remainingPercent, remainingPercent }]
  });
  try {
    hub.ingest({
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-07-24T10:01:00.000Z',
        providers: [
          provider(personalKey, 18, '2026-07-24T10:00:00.000Z'),
          provider(teamKey, 72, '2026-07-24T10:01:00.000Z')
        ]
      }
    });
    hub.ingest({
      deviceId: 'desktop',
      limits: {
        updatedAt: '2026-07-24T10:05:00.000Z',
        providers: [
          provider(personalKey, 48, '2026-07-24T10:04:00.000Z'),
          provider(teamKey, 82, '2026-07-24T10:05:00.000Z')
        ]
      }
    });

    const codexProviders = hub.getStats().limits.providers.filter((entry) => entry.provider === 'codex');
    assert.equal(codexProviders.length, 2);
    assert.deepEqual(
      new Set(codexProviders.map((entry) => entry.accountKey)),
      new Set([personalKey, teamKey])
    );
    assert.equal(
      codexProviders.find((entry) => entry.accountKey === personalKey).windows[0].remainingPercent,
      48
    );
    assert.equal(
      codexProviders.find((entry) => entry.accountKey === teamKey).windows[0].remainingPercent,
      82
    );
    assert.ok(codexProviders.every((entry) => entry.sourceDeviceId === 'desktop'));
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest without a deviceId throws', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    assert.throws(() => hub.ingest({ today: { totalTokens: 1 } }), /deviceId/);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('onStats fires on ingest and on deleteDevice, and unsubscribe stops it', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    let calls = 0;
    let lastDeviceCount = -1;
    const unsub = hub.onStats((stats) => { calls += 1; lastDeviceCount = stats.devices.length; });
    hub.ingest({ deviceId: 'dev-a', today: { totalTokens: 5 } });
    assert.equal(calls, 1);
    assert.equal(lastDeviceCount, 1);
    hub.deleteDevice('dev-a');
    assert.equal(calls, 2);
    assert.equal(lastDeviceCount, 0);
    unsub();
    hub.ingest({ deviceId: 'dev-b', today: { totalTokens: 1 } });
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('a subscription write is announced on the stats stream, carrying the new version', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    const record = { id: 'sub_1', provider: 'codex', planName: 'Plus', amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31' };
    // A hub nobody has written to reports an empty version rather than omitting
    // the field, so a device holding nothing compares equal and asks for nothing.
    assert.equal(hub.getStats().subscriptionsUpdatedAt, '');

    const seen = [];
    hub.onStats((stats, reason) => seen.push({ reason, version: stats.subscriptionsUpdatedAt }));
    const written = hub.setSubscriptions([record], '');

    // Without the broadcast the other devices only find out on their next poll,
    // which is five minutes apart while the stream is up.
    assert.deepEqual(seen, [{ reason: 'subscriptions', version: written.updatedAt }]);
    assert.equal(hub.getStats().subscriptionsUpdatedAt, written.updatedAt);

    // The records themselves stay off the stats frame: the version is all a
    // device needs to tell its copy has been overtaken.
    assert.equal('subscriptions' in hub.getStats(), false);

    // A refused write moves nothing, so there is nothing to announce.
    assert.throws(() => hub.setSubscriptions([], 'not-the-version'));
    assert.equal(seen.length, 1);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('oversized ingest returns 413 without storing the device', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'oversized', padding: '🚀'.repeat(270_000) })
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers.get('connection'), 'close');
    assert.deepEqual(await response.json(), {
      error: 'payload_too_large',
      message: 'Request body too large'
    });
    assert.equal(hub.getStats().devices.length, 0);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest accepts payloads above the legacy 256 KiB limit', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'larger', padding: 'x'.repeat(300 * 1024) })
    });

    assert.equal(response.status, 200);
    assert.equal(hub.getStats().devices.length, 1);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('the hub stores one shared subscription list, not one per device', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const call = (method, body) => fetch(`http://127.0.0.1:${port}/api/subscriptions`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    // A hub nobody has written to reports an empty updatedAt, which is what lets
    // the very first write through the staleness check.
    const empty = await (await call('GET')).json();
    assert.deepEqual(empty.subscriptions, []);
    assert.equal(empty.updatedAt, '');

    const record = { id: 'sub_1', provider: 'codex', planName: 'Plus', amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31' };
    const written = await (await call('PUT', { subscriptions: [record], baseUpdatedAt: '' })).json();
    assert.equal(written.subscriptions.length, 1);
    assert.equal(written.subscriptions[0].id, 'sub_1');
    assert.notEqual(written.updatedAt, '');

    // Every device reads the same list back — it belongs to the account, not to
    // whichever machine happened to record it.
    const read = await (await call('GET')).json();
    assert.deepEqual(read.subscriptions, written.subscriptions);

    // A device writing from a stale copy would erase records added elsewhere
    // since it last looked, and they exist nowhere else.
    const stale = await call('PUT', { subscriptions: [], baseUpdatedAt: '' });
    assert.equal(stale.status, 409);
    const conflict = await stale.json();
    assert.equal(conflict.error, 'stale_write');
    assert.equal(conflict.subscriptions.length, 1);
    assert.deepEqual((await (await call('GET')).json()).subscriptions, written.subscriptions);

    // Writing from the copy it just read through does go in, including a delete.
    const cleared = await (await call('PUT', { subscriptions: [], baseUpdatedAt: written.updatedAt })).json();
    assert.deepEqual(cleared.subscriptions, []);

    // Malformed records are discarded rather than stored: this arrives over the
    // network from another device.
    const junk = await (await call('PUT', { subscriptions: [{ provider: '' }, 'nope', record], baseUpdatedAt: cleared.updatedAt })).json();
    assert.equal(junk.subscriptions.length, 1);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('the shared subscription list survives a hub restart and needs the secret', async () => {
  const dataFile = tempDataFile();
  const record = { id: 'sub_1', provider: 'claude', planName: 'Pro', amountMinor: 14600, currency: 'HKD', startDate: '2026-07-19' };
  const first = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await first.start();
  try {
    first.setSubscriptions([record], '');
  } finally {
    await first.stop();
  }

  const second = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await second.start();
  try {
    assert.equal(second.getSubscriptions().subscriptions[0].id, 'sub_1');
    const { port } = second.server.address();
    // Money the user recorded by hand is behind the same gate as account identity.
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/subscriptions`);
    assert.equal(unauthorized.status, 401);
    const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { authorization: 'Bearer shh' } })).json();
    // The version rides along, so a device can tell its copy has been overtaken
    // without asking. What the user pays does not.
    assert.equal(stats.subscriptionsUpdatedAt, second.getSubscriptions().updatedAt);
    assert.equal('subscriptions' in stats, false);
    assert.doesNotMatch(JSON.stringify(stats), /amountMinor|planName|sub_1/);
  } finally {
    await second.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('a malformed subscription write is refused instead of emptying the ledger', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const put = (body) => fetch(`http://127.0.0.1:${port}/api/subscriptions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
      body: JSON.stringify(body)
    });
    const record = { id: 'sub_1', provider: 'codex', planName: 'Plus', amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31' };
    const written = await (await put({ subscriptions: [record], baseUpdatedAt: '' })).json();

    // A non-array normalizes to [] and would store as a perfectly successful
    // replacement, wiping records that exist nowhere else.
    for (const bad of [undefined, null, 'oops', 42, { 0: record }]) {
      const response = await put({ subscriptions: bad, baseUpdatedAt: written.updatedAt });
      assert.equal(response.status, 400, `subscriptions: ${JSON.stringify(bad)} should be refused`);
    }
    assert.equal(hub.getSubscriptions().subscriptions.length, 1);

    // An intentional clear still goes through.
    assert.equal((await (await put({ subscriptions: [], baseUpdatedAt: written.updatedAt })).json()).subscriptions.length, 0);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('the hub advertises PUT so a browser preflight does not block the write', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    // The endpoint existing is not enough: a browser-origin client is stopped at
    // the preflight if the method is not advertised.
    const preflight = await fetch(`http://127.0.0.1:${port}/api/subscriptions`, { method: 'OPTIONS' });
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /\bPUT\b/);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('back-to-back writes each get their own concurrency token', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  try {
    const record = (id) => ({ id, provider: 'codex', startDate: '2026-05-31' });
    const first = hub.setSubscriptions([record('a')], '');
    const second = hub.setSubscriptions([record('a'), record('b')], first.updatedAt);
    // Same millisecond is entirely possible here; if the token repeated, a third
    // write holding `first` would sail through and drop record b.
    assert.ok(second.updatedAt > first.updatedAt);
    assert.throws(() => hub.setSubscriptions([], first.updatedAt), /stale_write/);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('a subscription write that cannot reach disk does not take effect in memory', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  try {
    const record = (id) => ({ id, provider: 'codex', startDate: '2026-05-31', currency: 'USD' });
    const written = hub.setSubscriptions([record('a')], '');

    // A directory where the temp file belongs makes the atomic write fail. If
    // memory moved anyway, this process would serve a record the file does not
    // have and a restart would silently revert it.
    fs.mkdirSync(`${dataFile}.tmp`, { recursive: true });
    try {
      assert.throws(() => hub.setSubscriptions([record('a'), record('b')], written.updatedAt));
    } finally {
      fs.rmSync(`${dataFile}.tmp`, { recursive: true, force: true });
    }
    assert.deepEqual(hub.getSubscriptions().subscriptions.map((entry) => entry.id), ['a']);
    assert.equal(hub.getSubscriptions().updatedAt, written.updatedAt);
    // And the file still agrees, so a restart lands on the same list.
    assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).subscriptions.subscriptions.map((e) => e.id), ['a']);
  } finally {
    flushForCleanup(hub);
    cleanupDataFile(dataFile);
    await new Promise((resolve) => setTimeout(resolve, HUB_PERSIST_RETRY_DELAY_MS + 50));
    const recreatedAfterRetry = fs.existsSync(dataFile);
    cleanupDataFile(dataFile);
    assert.equal(recreatedAfterRetry, false);
  }
});

test('a currency the app carries no rate for is refused, not rewritten', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const put = (body) => fetch(`http://127.0.0.1:${port}/api/subscriptions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
      body: JSON.stringify(body)
    });
    // Coercing EUR to USD reports an amount the user never entered, and the
    // endpoint documents this as validation.
    const refused = await put({
      subscriptions: [{ id: 'a', provider: 'codex', startDate: '2026-05-31', amountMinor: 10000, currency: 'EUR' }],
      baseUpdatedAt: ''
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).message, /EUR/);
    assert.deepEqual(hub.getSubscriptions().subscriptions, []);

    for (const code of ['USD', 'TWD', 'HKD', 'CNY']) {
      const ok = await put({
        subscriptions: [{ id: 'a', provider: 'codex', startDate: '2026-05-31', currency: code }],
        baseUpdatedAt: hub.getSubscriptions().updatedAt
      });
      assert.equal(ok.status, 200, `${code} should be accepted`);
    }
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});
