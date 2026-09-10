'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hermesPeriodRows, openclawEventRow } = require('../../src/shared/localUsage');
const start = new Date('2026-09-10T00:00:00+08:00').getTime();
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
test('Codex activity uses last token event rather than session creation or file modification', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { codexActivity } = require('../../src/shared/localUsage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-activity-'));
  try {
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(path.join(dir, 'sessions', 'rollout-test.jsonl'), [
      { timestamp: '2026-09-09T01:00:00Z', type: 'session_meta' },
      { timestamp: '2026-09-10T04:33:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 20 } } } },
      { timestamp: '2026-09-10T04:35:00Z', type: 'response_item' }
    ].map(JSON.stringify).join('\n'));
    assert.equal(codexActivity(dir).get('rollout-test'), '2026-09-10T04:33:00Z');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
