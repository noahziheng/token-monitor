'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hermesPeriodRows, openclawEventRow } = require('../../src/shared/localUsage');
// The adapter buckets by the process-local calendar, not a fixed UTC offset.
const start = new Date(2026, 8, 10).getTime();
test('Hermes long-lived sessions are not moved wholesale into today; observed deltas retain actual model', () => {
  const row = { key: 'one', model: 'doubao-seed-evolving', firstSeen: start - 86400000, input: 100, output: 10, cacheRead: 20, cacheWrite: 0 };
  const ledger = {};
  assert.deepEqual(hermesPeriodRows([row], ledger, start + 1000, start), []);
  const result = hermesPeriodRows([{ ...row, input: 125, output: 12 }], ledger, start + 2000, start);
  assert.equal(result[0].model, row.model);
  assert.equal(result[0].input, 25);
  assert.equal(result[0].output, 2);
  assert.equal(hermesPeriodRows([{ ...row, input: 125, output: 12 }], ledger, start + 3000, start)[0].input, 25);
});
test('new Hermes model bucket within period is wholly attributable; older bucket is valid for month', () => {
  const row = { key: 'new', model: 'doubao', firstSeen: start + 1, input: 50 };
  assert.equal(hermesPeriodRows([row], {}, start + 1000, start)[0].input, 50);
  assert.equal(hermesPeriodRows([{ ...row, firstSeen: start - 86400000 }], {}, start + 1000, start - 86400000 * 9)[0].input, 50);
});
test('OpenClaw excludes Codex mirrors and counts native nonzero usage with source model', () => {
  const event = { id: 'e1', message: { role: 'assistant', model: 'doubao', timestamp: start + 1, usage: { input: 5, output: 2, cacheRead: 3, totalTokens: 10 } } };
  assert.equal(openclawEventRow(event, 's1').input, 5);
  assert.equal(openclawEventRow(event, 's1').client, 'openclaw');
  event.message.__openclaw = { mirrorOrigin: 'codex-app-server' };
  assert.equal(openclawEventRow(event, 's1'), null);
});
test('SQLite reads suppress repeated events, mirrored Codex, and old dates', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { readOpenclaw } = require('../../src/shared/localUsage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-local-usage-'));
  const file = path.join(dir, 'events.sqlite');
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE transcript_events (session_id TEXT, event_json TEXT)');
    const add = db.prepare('INSERT INTO transcript_events VALUES (?, ?)');
    const message = { role: 'assistant', model: 'doubao', timestamp: start + 1, usage: { input: 5, output: 2, cacheRead: 3 } };
    add.run('s', JSON.stringify({ id: 'a', message }));
    add.run('s', JSON.stringify({ id: 'a', message }));
    add.run('s', JSON.stringify({ id: 'b', message: { ...message, timestamp: start - 1 } }));
    add.run('s', JSON.stringify({ id: 'c', message: { ...message, __openclaw: { mirrorOrigin: 'codex-app-server' } } }));
    db.close();
    const result = readOpenclaw(file, start);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].model, 'doubao');
    assert.ok(result.sessions.has('s'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
