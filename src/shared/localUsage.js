'use strict';
// Compatibility for SQLite-backed OpenClaw and long-lived Hermes sessions.
// Source databases are read-only. No prompts, credentials or response bodies
// enter this adapter's records or its checkpoint file.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'];
const number = (v) => Math.max(0, Number(v) || 0);
function dayStart(value) { const d = new Date(value); d.setHours(0, 0, 0, 0); return d.getTime(); }
function periodStart(flags, now) {
  if (flags.includes('--today')) return dayStart(now);
  if (flags.includes('--month')) { const d = new Date(now); d.setDate(1); return dayStart(d); }
  const since = flags.indexOf('--since');
  return since >= 0 ? new Date(`${flags[since + 1]}T00:00:00`).getTime() : 0;
}
function hermesPeriodRows(rows, ledger, now, start) {
  const result = [];
  for (const row of rows) {
    const previous = ledger[row.key];
    const days = previous?.days || {};
    const today = dayStart(now);
    // A cross-midnight observation cannot safely be assigned to either day.
    if (previous && dayStart(previous.at) === today) {
      const bucket = days[today] ||= {};
      for (const field of FIELDS) bucket[field] = number(bucket[field]) + Math.max(0, number(row[field]) - number(previous[field]));
    }
    ledger[row.key] = { ...Object.fromEntries(FIELDS.map((f) => [f, number(row[f])])), at: now, days };
    const values = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    if (row.firstSeen >= start) {
      for (const f of FIELDS) values[f] = number(row[f]);
    } else {
      for (const [date, bucket] of Object.entries(days)) if (Number(date) >= start) {
        for (const f of FIELDS) values[f] += number(bucket[f]);
      }
    }
    if (FIELDS.some((f) => values[f] > 0)) result.push({ client: 'hermes', model: row.model,
      sessionId: row.sessionId, ...values, lastUsedAt: new Date(row.lastSeen || now).toISOString() });
  }
  return result;
}
function openclawEventRow(event, sessionId) {
  const m = event.message;
  if (!m || m.role !== 'assistant' || m.__openclaw?.mirrorOrigin === 'codex-app-server') return null;
  const u = m.usage;
  if (!u || !FIELDS.some((f) => number(u[f]) > 0)) return null;
  return { client: 'openclaw', model: m.model || 'unknown', sessionId,
    ...Object.fromEntries(FIELDS.filter((f) => f !== 'cost').map((f) => [f, number(u[f])])),
    cost: number(u.cost?.total), messageCount: 1, lastUsedAt: new Date(m.timestamp || event.timestamp).toISOString() };
}
function dirs(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function readOpenclaw(dbPath, start) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = new Set(db.prepare('SELECT DISTINCT session_id FROM transcript_events').all().map((r) => r.session_id));
    // Project only accounting metadata in SQLite; never materialize content.
    const records = db.prepare(`SELECT session_id, json_extract(event_json, '$.id') AS eventId,
      json_extract(event_json, '$.message.role') AS role,
      json_extract(event_json, '$.message.model') AS model,
      json_extract(event_json, '$.message.usage') AS usage,
      json_extract(event_json, '$.message.timestamp') AS timestamp,
      json_extract(event_json, '$.message.__openclaw.mirrorOrigin') AS mirrorOrigin
      FROM transcript_events WHERE json_extract(event_json, '$.message.timestamp') >= ?
      AND json_extract(event_json, '$.message.usage') IS NOT NULL`).all(start);
    const seen = new Set(); const entries = [];
    for (const r of records) {
      const key = `${r.session_id}:${r.eventId}`;
      if (r.eventId && seen.has(key)) continue;
      seen.add(key);
      const entry = openclawEventRow({ message: { ...r, usage: JSON.parse(r.usage), __openclaw: { mirrorOrigin: r.mirrorOrigin } } }, r.session_id);
      if (entry) entries.push(entry);
    }
    return { sessions, entries };
  } finally { db.close(); }
}
function readHermes(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT smu.session_id AS sessionId, smu.model,
      smu.billing_provider AS provider, smu.billing_base_url AS endpoint, smu.billing_mode AS mode, smu.task,
      COALESCE(smu.first_seen, s.started_at) * 1000 AS firstSeen,
      COALESCE(smu.last_seen, s.started_at) * 1000 AS lastSeen,
      smu.input_tokens AS input, smu.output_tokens AS output,
      smu.cache_read_tokens AS cacheRead, smu.cache_write_tokens AS cacheWrite,
      COALESCE(NULLIF(smu.actual_cost_usd, 0), smu.estimated_cost_usd, 0) AS cost
      FROM session_model_usage smu JOIN sessions s ON s.id=smu.session_id`).all().map((r) => {
      // Hash provider/endpoint identity so the observation file contains no URLs.
      const key = require('node:crypto').createHash('sha256').update(JSON.stringify([dbPath, r.sessionId, r.model, r.provider, r.endpoint, r.mode, r.task])).digest('hex');
      return { key, sessionId: r.sessionId, model: r.model, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
        ...Object.fromEntries(FIELDS.map((f) => [f, number(r[f])])) };
    });
  } finally { db.close(); }
}
const activityCache = new Map();
function codexActivity(home) {
  const result = new Map();
  function visit(root) {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const stat = fs.statSync(file);
      let cached = activityCache.get(file);
      if (!cached || cached.size !== stat.size || cached.mtime !== stat.mtimeMs) {
        const fd = fs.openSync(file, 'r');
        let timestamp;
        try {
          // Bounded tail read; an absent usage event is not replaced with mtime.
          const length = Math.min(stat.size, 512 * 1024);
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, stat.size - length);
          for (const line of buffer.toString('utf8').split('\n').reverse()) {
            if (!line.includes('"token_count"')) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'event_msg' && event.payload?.type === 'token_count'
                && event.payload.info?.total_token_usage && Number.isFinite(Date.parse(event.timestamp))) {
                timestamp = event.timestamp; break;
              }
            } catch { /* The first tail line may be truncated. */ }
          }
        } finally { fs.closeSync(fd); }
        cached = { size: stat.size, mtime: stat.mtimeMs, timestamp };
        activityCache.set(file, cached);
      }
      if (cached.timestamp) result.set(path.basename(file, '.jsonl'), cached.timestamp);
    }
  }
  visit(path.join(home, 'sessions'));
  visit(path.join(home, 'archived_sessions'));
  return result;
}
function withCodexActivity(entries, home) {
  const activity = codexActivity(home);
  return entries.map((entry) => {
    const timestamp = activity.get(entry.sessionId || entry.session);
    return timestamp ? { ...entry, lastUsedAt: timestamp } : entry;
  });
}
async function augmentLocalUsage(base, { clients, flags, scanCodex, home = os.homedir(), now = Date.now(), stateFile }) {
  const selected = new Set(clients.split(','));
  let entries = base.entries || [];
  if (selected.has('codex')) {
    const updated = withCodexActivity(entries.filter((e) => e.client === 'codex'), process.env.CODEX_HOME || path.join(home, '.codex'));
    entries = entries.filter((e) => e.client !== 'codex').concat(updated);
  }
  const start = periodStart(flags, now);
  if (selected.has('openclaw')) {
    for (const agent of dirs(path.join(home, '.openclaw', 'agents'))) {
      const dbPath = path.join(agent, 'agent', 'openclaw-agent.sqlite');
      if (fs.existsSync(dbPath)) {
        const data = readOpenclaw(dbPath, start);
        entries = entries.filter((e) => e.client !== 'openclaw' || !data.sessions.has(e.sessionId || e.session));
        entries.push(...data.entries);
      }
      const codexHome = path.join(agent, 'agent', 'codex-home');
      if (fs.existsSync(path.join(codexHome, 'sessions')) || fs.existsSync(path.join(codexHome, 'archived_sessions'))) {
        const data = await scanCodex(codexHome);
        entries.push(...withCodexActivity(data.entries || [], codexHome).map((e) => ({ ...e, client: 'openclaw',
          output: number(e.output) + number(e.reasoning), reasoning: 0 }))); 
      }
    }
  }
  if (selected.has('hermes') && stateFile) {
    const hermesHome = process.env.HERMES_HOME || path.join(home, '.hermes');
    const databases = [hermesHome, ...dirs(path.join(hermesHome, 'profiles'))].map((p) => path.join(p, 'state.db')).filter((p) => fs.existsSync(p));
    if (databases.length) {
      let ledger = {};
      try { ledger = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const rows = databases.flatMap(readHermes);
      const adjusted = hermesPeriodRows(rows, ledger, now, start);
      // Lifetime remains the upstream per-model cumulative report. Calendar
      // periods use first_seen plus observed deltas, never session start dates.
      if (flags.includes('--today') || flags.includes('--month')) entries = entries.filter((e) => e.client !== 'hermes').concat(adjusted);
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
      fs.renameSync(temporary, stateFile);
    }
  }
  return { entries };
}
module.exports = { codexActivity, augmentLocalUsage, hermesPeriodRows, openclawEventRow, readOpenclaw, readHermes };
