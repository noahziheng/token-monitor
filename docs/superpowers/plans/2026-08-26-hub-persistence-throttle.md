# Node Hub Persistence Throttle Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coalesce frequent Node Hub device-ingest writes into a bounded five-second persistence cadence while keeping subscriptions, deletion, and graceful shutdown immediately durable.

**Architecture:** Add a dependency-free scheduler under `src/hub/` that wraps the existing synchronous atomic writer with leading-and-trailing throttling, positive-delay retry, and deterministic clock/timer injection. Integrate it only into the Node Hub; the in-memory API/SSE behavior stays live, durable mutations force a flush, and `0` restores legacy per-ingest writes.

**Tech Stack:** Node.js 22 CommonJS, `node:http`, `node:perf_hooks`, synchronous filesystem writes through the existing `writeJsonAtomic()`, and `node:test`.

---

## Chunk 1: Scheduler and Node Hub integration

### Task 1: Build the deterministic persistence scheduler

**Files:**
- Create: `src/hub/persistenceScheduler.js`
- Create: `tests/hub/persistenceScheduler.test.js`

- [ ] **Step 1: Write normalization tests**

Add table-driven tests for the public configuration contract:

```js
test('normalizePersistIntervalMs accepts zero and clamps finite values', () => {
  assert.equal(normalizePersistIntervalMs(undefined), DEFAULT_HUB_PERSIST_INTERVAL_MS);
  assert.equal(normalizePersistIntervalMs(0), 0);
  assert.equal(normalizePersistIntervalMs('2500'), 2500);
  assert.equal(normalizePersistIntervalMs(120000), MAX_HUB_PERSIST_INTERVAL_MS);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'nope']) {
    assert.equal(normalizePersistIntervalMs(value), DEFAULT_HUB_PERSIST_INTERVAL_MS);
  }
  for (const value of [true, false, null, '', '   ']) {
    assert.equal(normalizePersistIntervalMs(value), DEFAULT_HUB_PERSIST_INTERVAL_MS);
  }
  assert.equal(normalizePersistIntervalMs(0.1), 1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/hub/persistenceScheduler.test.js`

Expected: FAIL because `src/hub/persistenceScheduler.js` does not exist.

- [ ] **Step 3: Implement constants and normalization**

Create the CommonJS module with:

```js
const DEFAULT_HUB_PERSIST_INTERVAL_MS = 5000;
const MAX_HUB_PERSIST_INTERVAL_MS = 60000;
const HUB_PERSIST_RETRY_DELAY_MS = 1000;

function normalizePersistIntervalMs(value, fallback = DEFAULT_HUB_PERSIST_INTERVAL_MS) {
  const numeric = numericInterval(value);
  if (!Number.isFinite(numeric) || numeric < 0) return normalizeFallback(fallback);
  if (numeric === 0) return 0;
  return Math.min(Math.ceil(numeric), MAX_HUB_PERSIST_INTERVAL_MS);
}
```

Keep strict coercion and fallback normalization private: accept finite numbers and non-empty numeric strings only. Booleans, `null`, blank strings, negative values, and non-finite values are invalid. Round positive fractional milliseconds up so positive input cannot silently become legacy `0` mode. Ensure an invalid fallback resolves to the default rather than recursing.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/hub/persistenceScheduler.test.js`

Expected: PASS for normalization.

- [ ] **Step 5: Write scheduler behavior tests**

Build a fake monotonic clock/timer harness. Add one-behavior tests proving:

```js
test('writes the first mark immediately and coalesces the window into one trailing write', () => {});
test('continuous marks do not move the trailing deadline', () => {});
test('zero interval writes every mark synchronously', () => {});
test('flush cancels the trailing timer and writes the latest state', () => {});
test('flush writes unconditionally when durable state changed on a clean scheduler', () => {});
test('failed timer writes log and retry once after a positive delay', () => {});
test('failed forced flush preserves dirty state and its retry timer', () => {});
test('a backward clock movement makes a new mark immediately due', () => {});
test('stop flushes dirty state and rejects later marks', () => {});
```

The fake timer must expose due times and manually execute callbacks. Assert there is never more than one live timer, failed retries are scheduled exactly `1000` ms later, and fake timer handles receive `unref()`.

- [ ] **Step 6: Run the focused test and verify RED**

Run: `node --test tests/hub/persistenceScheduler.test.js`

Expected: FAIL because `createPersistenceScheduler` is not implemented.

- [ ] **Step 7: Implement the minimal scheduler**

Implement `createPersistenceScheduler({ write, intervalMs, now, setTimer, clearTimer, retryDelayMs, onError })` with these invariants:

```js
// State: dirty, stopped, lastSuccessfulWriteAt, timer, timerKind.
// timerKind is "trailing" or "retry" so a new mark never bypasses backoff.
// Default now: performance.now(), not Date.now().
// markDirty(): leading write when due, otherwise arm exactly one fixed-deadline timer.
// flush(): cancel any timer and synchronously force a write, even if previously clean.
// timer callback: clear its handle, attempt the write, report failure through onError.
// stop(): mark stopped, cancel the timer, synchronously write if dirty, never retry.
```

On success, clear `dirty` and set `lastSuccessfulWriteAt` after the write returns. A forced `flush()` marks the scheduler dirty before attempting its unconditional write, so a clean forced-write failure still arms a retry. On failure, retain `dirty`, do not move the success timestamp, and arm a retry only when not stopped. If `now() < lastSuccessfulWriteAt`, cancel a normal trailing timer and treat the write as due immediately. `markDirty()` after stop throws a stable error. `stop()` writes only when dirty, avoiding an unchanged shutdown rewrite.

Export only:

```js
module.exports = {
  DEFAULT_HUB_PERSIST_INTERVAL_MS,
  HUB_PERSIST_RETRY_DELAY_MS,
  MAX_HUB_PERSIST_INTERVAL_MS,
  createPersistenceScheduler,
  normalizePersistIntervalMs
};
```

- [ ] **Step 8: Run scheduler tests and verify GREEN**

Run: `node --test tests/hub/persistenceScheduler.test.js`

Expected: all scheduler tests PASS with no warnings.

- [ ] **Step 9: Commit the scheduler**

```bash
git add src/hub/persistenceScheduler.js tests/hub/persistenceScheduler.test.js
git commit -m "feat(hub): add bounded persistence scheduler"
```

### Task 2: Integrate throttled ingest persistence

**Files:**
- Modify: `src/hub/server.js`
- Modify: `tests/hub/server.test.js`

- [ ] **Step 1: Write Hub integration tests for coalescing and forced flushes**

Add tests using `persistIntervalMs: 60000`:

```js
test('coalesced ingest is live in memory before the trailing disk write', () => {});
test('subscription persistence also flushes the newest coalesced device record', () => {});
test('device deletion flushes pending ingest state immediately', () => {});
test('persistIntervalMs zero preserves per-ingest disk writes', () => {});
test('the trailing timer persists the latest coalesced device record', async () => {});
```

Use a unique temporary data file. The first ingest should create a disk baseline; the second should be visible through `getStats()` while the file still contains the first snapshot. Force a subscription write or deletion and assert the JSON file contains the latest combined store.

For the actual trailing-write integration, use a short positive interval and poll the temporary file up to a conservative bounded deadline rather than sleeping once. Assert the final file contains the second ingest. Pure scheduler tests remain responsible for exact timing; this integration test proves the Hub wiring reaches disk.

- [ ] **Step 2: Run the focused Hub tests and verify RED**

Run: `node --test tests/hub/server.test.js`

Expected: new tests FAIL because every ingest still calls `persist()`.

- [ ] **Step 3: Wire the scheduler into `createHub()`**

In `src/hub/server.js`:

- import the scheduler and default interval;
- add `persistIntervalMs = DEFAULT_HUB_PERSIST_INTERVAL_MS` to `createHub()`;
- make `persist()` restore the prior `savedAt` if `writeJsonAtomic()` throws;
- instantiate the scheduler with `write: persist` and an `onError` callback that uses `logger.error`;
- replace ingest's `persist()` with `persistence.markDirty()`;
- replace subscription and deletion persistence with `persistence.flush()`.

Do not alter merge order, broadcast order, response bodies, or the subscription rollback block.

- [ ] **Step 4: Run scheduler and Hub tests and verify GREEN**

Run: `node --test tests/hub/persistenceScheduler.test.js tests/hub/server.test.js`

Expected: all focused tests PASS.

- [ ] **Step 5: Write shutdown drain-and-flush test**

Add an HTTP integration test that:

1. starts the Hub and establishes a disk baseline;
2. opens a second `POST /api/ingest` request and sends only part of its JSON body;
3. calls `hub.stop()` while that request remains active;
4. completes the request body;
5. awaits both the response and `stop()`; and
6. asserts the file contains the in-flight ingest's latest record.

This must fail if the scheduler is stopped before `server.close()` drains the request.

Add a separate final-flush failure test: create pending dirty state, make the atomic temp path unwritable using the existing `${dataFile}.tmp` directory technique, call `hub.stop()`, assert its promise rejects, assert the logger saw the error, and assert `hub.server.listening === false`. Remove the blocking directory during cleanup.

- [ ] **Step 6: Run the shutdown test and verify RED**

Run: `node --test tests/hub/server.test.js`

Expected: both new shutdown tests FAIL until shutdown ordering owns the final flush and reports a failed final write after closing the server.

- [ ] **Step 7: Implement graceful stop ordering**

Change `stop()` to call `server.close()` first and invoke `persistence.stop()` inside the close callback. Close SSE responses before `server.close()` as today. If the final flush throws, log the error and reject the returned promise after the server is closed. The scheduler remains live while active HTTP requests drain.

Preserve Electron's existing fire-and-forget quit behavior; do not add new process signal handlers.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `node --test tests/hub/persistenceScheduler.test.js tests/hub/server.test.js`

Expected: all focused tests PASS and the process exits without referenced scheduler timers.

- [ ] **Step 9: Commit Hub integration**

```bash
git add src/hub/server.js tests/hub/server.test.js
git commit -m "feat(hub): throttle device snapshot persistence"
```

## Chunk 2: Configuration, build identity, and verification

### Task 3: Expose and document the compatibility parameter

**Files:**
- Modify: `src/hub/server.js`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Modify: `docs/configuration.md`
- Modify: `tests/hub/server.test.js`

- [ ] **Step 1: Write a CLI/env resolution test at the smallest existing seam**

Extract a pure `resolvePersistIntervalMs(args, env)` helper from the standalone-entry configuration if direct testing would otherwise require spawning the Hub. Assert CLI beats env, env beats default, `0` is retained, values above 60000 clamp, and invalid values fall back to 5000.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="persist interval" tests/hub/server.test.js`

Expected: FAIL because the standalone configuration does not resolve the new option.

- [ ] **Step 3: Implement CLI and environment wiring**

Resolve:

```js
const persistIntervalMs = resolvePersistIntervalMs(args, process.env);
const hub = createHub({ port, host, secret, staleAfterMs, dataFile, persistIntervalMs });
```

Use `args.persistIntervalMs` before `env.TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS`; normalize once through `normalizePersistIntervalMs`. Export the pure resolver beside `createHub` and `resolveBindHost` only if needed by the test.

- [ ] **Step 4: Document the setting**

Add near the Hub connection settings in `.env.example`:

```env
# Node Hub device-snapshot disk-write cadence. Optional — defaults to 5000 ms.
# 0 restores one synchronous write per ingest; accepted range: 0–60000 ms.
TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS=5000
```

Add the same operator-facing option to the headless agent & Hub block in `docs/configuration.md`. State that subscription edits and deletion still flush immediately and that the setting affects only the Node Hub, not Cloudflare Worker deployments.

Update the Node Hub architecture paragraph in `AGENTS.md` with the non-obvious invariant: only high-frequency device ingests are throttled; subscriptions and deletion force an immediate combined flush; `0` is the legacy per-ingest mode. Keep the note concise and avoid duplicating implementation details.

- [ ] **Step 5: Run focused tests and lint touched files**

Run: `node --test tests/hub/persistenceScheduler.test.js tests/hub/server.test.js`

Run: `npx eslint src/hub/persistenceScheduler.js src/hub/server.js tests/hub/persistenceScheduler.test.js tests/hub/server.test.js`

Expected: both commands exit 0.

- [ ] **Step 6: Commit configuration and docs**

```bash
git add src/hub/server.js tests/hub/server.test.js .env.example AGENTS.md docs/configuration.md
git commit -m "docs(hub): expose persistence interval setting"
```

### Task 4: Register the complete Node Hub build and verify the repository

**Files:**
- Modify: `scripts/hub-build-manifest.js`
- Modify: `tests/shared/hubBuild.test.js` only if a focused expectation is needed
- Modify: `src/shared/hubBuildRegistry.json` (generated)
- Modify: `worker/src/shared/hubBuildRegistry.json` (generated)

- [ ] **Step 1: Write or confirm the closure guard fails for the new module**

Run: `node --test tests/shared/hubBuild.test.js`

Expected: FAIL because `src/hub/persistenceScheduler.js` is in the transitive Node runtime dependency graph but not `NODE_RUNTIME_SOURCE_FILES`.

- [ ] **Step 2: Add the scheduler to the Node runtime manifest**

Add `src/hub/persistenceScheduler.js` to `NODE_RUNTIME_SOURCE_FILES`. Do not add it to the portable core or Worker manifest.

- [ ] **Step 3: Confirm only the stale registry assertion remains**

Run: `node --test tests/shared/hubBuild.test.js`

Expected: the dependency-closure assertion passes; the registry-current assertion still fails with the instruction to run `npm run update:hub-build`.

- [ ] **Step 4: Refresh generated Hub build metadata once**

Run: `npm run update:hub-build`

Expected: one new `node-hub` registry revision is added and copied into `worker/src/shared/hubBuildRegistry.json`; portable core and Worker build IDs do not move.

- [ ] **Step 5: Run the full verification gate**

Run: `npm run verify`

Expected: ESLint exits 0 and the complete `node:test` suite reports zero failures.

- [ ] **Step 6: Inspect final scope and whitespace**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat 1519ecf`

Expected: no whitespace errors; only the planned Hub scheduler, tests, Node Hub adapter, configuration/docs, and generated build-registry files are changed. The pre-existing user-owned `package.json` modification remains uncommitted and untouched.

- [ ] **Step 7: Commit build identity metadata**

```bash
git add scripts/hub-build-manifest.js src/shared/hubBuildRegistry.json worker/src/shared/hubBuildRegistry.json
git commit -m "chore(hub): register persistence throttle build"
```
