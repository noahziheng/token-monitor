# Node Hub Persistence Throttle Design

## Summary

The Node Hub currently rewrites the complete `devices.json` document synchronously for every device ingest. Live collectors can post every few seconds, so a homelab Hub performs many redundant whole-file writes even though only the newest snapshot for each device matters.

Add a Hub-local leading-and-trailing persistence throttle. The first ingest after an idle period writes immediately. Further ingests inside the throttle window update the in-memory store and continue to broadcast live stats, but they are coalesced into one write at the end of the window. Continuous traffic therefore produces one write per interval rather than postponing persistence indefinitely.

This design deliberately does not add `fsync`. Losing at most the latest few seconds of observed usage after abrupt power loss is acceptable for the intended personal homelab deployment, and changing the shared `writeJsonAtomic()` durability contract would affect unrelated settings, history, credentials, and cache writers.

## Goals

- Reduce redundant whole-file writes caused by frequent `/api/ingest` calls.
- Keep in-memory stats, HTTP responses, and SSE notifications immediate.
- Bound the unpersisted ingest window under continuous traffic.
- Preserve synchronous persistence for manually maintained subscriptions and device deletion.
- Keep the implementation local to the Node Hub, backward compatible, and easy to extract into an upstream pull request.

## Non-goals

- Changing the Hub wire format or HTTP endpoints.
- Changing Cloudflare Worker persistence.
- Adding `fsync`, a journal, a database, or a new dependency.
- Delaying subscription edits or device deletion.
- Adding an embedded-Hub GUI setting.

## Considered Approaches

### 1. Hub-local leading-and-trailing throttle (selected)

Wrap the Node Hub's existing synchronous `persist()` operation with a small scheduler. This isolates the behavioral change to high-frequency device snapshots while preserving `writeJsonAtomic()` for every existing caller.

Advantages: small scope, no dependency, bounded loss window, continuous-traffic progress, and a simple compatibility escape hatch. The trade-off is that an ingest accepted during the window can be lost if the process or machine stops abruptly before the trailing flush.

### 2. Debounce all Hub writes

Reset one timer on every mutation and persist only after traffic becomes quiet. This is simple, but a continuously reporting device could prevent persistence forever. It also delays low-frequency user-authored data unless special cases are added. Rejected because the durability window would be unbounded.

### 3. Change shared atomic writes or add a journal

Add caching, `fsync`, or a write-ahead log beneath `writeJsonAtomic()`. This could improve durability or throughput for many callers, but it changes a shared compatibility surface and expands the review area well beyond the Hub ingest path. Rejected for this homelab use case.

## Architecture

Create a focused scheduler module under `src/hub/`. It owns only timing state:

- whether the store is dirty;
- the most recent successful write time;
- at most one trailing timer; and
- whether the scheduler has stopped.

The scheduler receives an injected synchronous `write` callback. It does not know the store shape or filesystem path. The Hub continues to own serialization through its existing `persist()` function and `writeJsonAtomic()`. Elapsed-time decisions use a monotonic clock by default; an injected clock that moves backward is treated as immediately due and re-anchored rather than extending the dirty window.

`markDirty()` is used by ingest. If no successful write exists or the configured interval has elapsed, it performs a leading write synchronously. Otherwise it arms one timer for the remaining window. Timer execution performs the trailing write. It does not reset the deadline for each ingest, so continuous traffic still reaches disk once per interval.

`flush()` is used by durable mutations. It cancels a pending timer and synchronously writes the latest combined store. A successful flush clears dirty state and starts a new throttle window.

`stop()` cancels the timer and synchronously attempts one final flush after the HTTP server has stopped accepting work and drained its active requests. The timer is unreferenced when the runtime supports `unref()`, so it cannot keep a process alive by itself.

## Data Flow

### Device ingest

1. Validate and merge the incoming record into the in-memory device map.
2. Mark the persistence scheduler dirty.
3. Perform a leading write immediately when due, or leave the existing trailing timer armed.
4. Broadcast stats immediately from memory and return the normal response.

The order matches current first-write behavior: if the leading synchronous write fails, ingest throws before broadcasting. An ingest coalesced behind a timer has already been accepted into memory; a later timer failure cannot be reported to that completed request.

### Subscription write

1. Validate concurrency, records, and currency exactly as today.
2. Replace the in-memory subscription document tentatively.
3. Call `flush()` synchronously, which also includes any pending device ingests.
4. On failure, restore the previous subscription document and `savedAt`, then rethrow.
5. Broadcast only after the flush succeeds.

This preserves the existing guarantee that a successful response means the only copy of user-entered subscription data reached the atomic file replacement path.

### Device deletion

Delete the device in memory and call `flush()` synchronously before broadcasting. Deletion remains immediately persistent and also commits any pending ingest snapshots.

### Shutdown

`createHub().stop()` starts `server.close()` first, which stops new connections and drains active requests while the scheduler remains usable. When the close callback runs, it asks the scheduler to stop and synchronously flushes the final state. This prevents a request already parsing its body from mutating the store after the last flush. A flush failure is logged and rejects `stop()`, but the listening server is already closed.

The existing Electron quit path deliberately calls embedded-Hub stop without awaiting it so a remote connection cannot hold application exit open. This feature does not weaken or broaden that pre-existing best-effort quit contract. Mode switches and callers that await `stop()` get the full drain-and-flush guarantee. The standalone entry point also keeps its existing process-signal behavior; an abrupt OS or power stop may lose at most the throttle window, which is the accepted homelab trade-off.

## Configuration and Compatibility

The throttle has one parameter, in milliseconds:

| Surface | Name |
|---|---|
| Programmatic `createHub` option | `persistIntervalMs` |
| Standalone Hub CLI | `--persistIntervalMs` |
| Standalone Hub environment | `TOKEN_MONITOR_HUB_PERSIST_INTERVAL_MS` |

Precedence remains `CLI -> environment -> built-in default`, matching the other standalone Hub options.

- Default: `5000` ms.
- Minimum: `0` ms.
- Maximum: `60000` ms.
- `0`: compatibility mode that performs every ingest write synchronously, matching the previous behavior.
- Non-finite, negative, or otherwise invalid input: fall back to `5000` ms.
- Positive values above `60000`: clamp to `60000` ms so a typo cannot create an unexpectedly large crash-loss window.

The option is intentionally absent from widget settings. The embedded Hub uses the default, keeping GUI and persisted settings schemas unchanged. Operators who require the previous standalone behavior can set the environment variable to `0`; tests and programmatic callers can do the same through `createHub()`.

The new variable is documented in `.env.example` and the headless Hub configuration section. This is an additive configuration surface; existing commands and environment files retain the new default without migration.

No HTTP route, response, SSE frame, device record, subscription document, data-file schema, or generated Worker source changes. Existing `devices.json` files load without migration.

## Error Handling

- A synchronous leading or forced write throws to its caller, as existing immediate writes do.
- Every failed write keeps dirty state. Unless the scheduler is stopping, it retains exactly one retry timer with a fixed positive `1000` ms delay. This retry delay is internal rather than another operator setting.
- A trailing or retry timer has no live request to fail. It logs through the Hub logger and schedules the bounded retry without using the unchanged last-success deadline, preventing a zero-delay loop.
- A failed forced subscription or deletion flush leaves the retry armed. Subscription rollback completes synchronously before that timer can observe the store, so the retry persists the rolled-back subscription document together with pending device snapshots.
- A failed write does not advance the last-success timestamp.
- `persist()` restores the previous `savedAt` on failure so in-memory metadata does not claim a save that did not occur.
- Only one timer exists. Repeated ingests coalesce without extending the current deadline.
- A forced successful flush cancels the trailing timer and clears dirty state.

## Testing

Use Node's built-in test runner and injected clock/timer functions for deterministic scheduler tests:

- the first dirty mark writes immediately;
- multiple marks inside one window produce one trailing write;
- continuous marks cannot postpone the trailing write;
- `0` writes every mark immediately;
- forced flush cancels the timer and writes the latest state;
- a trailing failure logs, remains dirty, and retries;
- a failed forced flush with pending ingest remains dirty and does not hot-loop;
- a backward clock movement makes the dirty state immediately due rather than extending the window;
- stop flushes pending state and prevents future scheduling;
- normalization covers defaults, zero, bounds, clamping, and invalid input.

Add Hub integration tests proving:

- coalesced ingests remain immediately visible in memory while disk contains the prior snapshot;
- the trailing write persists the latest snapshot;
- subscription edits and deletion force pending ingest state to disk;
- Hub stop drains an in-flight ingest before the final flush; and
- `persistIntervalMs: 0` preserves legacy per-ingest persistence.

Run the focused Hub tests during TDD, then `npm run verify`. Because `src/hub/server.js` contributes to the registered Node Hub build identity, run `npm run update:hub-build` once after the implementation stabilizes and include the generated registry update.
