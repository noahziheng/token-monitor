'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_HUB_PERSIST_INTERVAL_MS,
  HUB_PERSIST_RETRY_DELAY_MS,
  MAX_HUB_PERSIST_INTERVAL_MS,
  createPersistenceScheduler,
  normalizePersistIntervalMs
} = require('../../src/hub/persistenceScheduler');

function createManualClock(initialNow = 0) {
  let nowMs = initialNow;
  let nextTimerId = 1;
  let maxTimerCount = 0;
  const timers = new Map();
  const handles = [];

  function setTimer(callback, delayMs) {
    const handle = {
      id: nextTimerId++,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1;
      }
    };
    timers.set(handle, { callback, dueAt: nowMs + delayMs, delayMs });
    handles.push(handle);
    maxTimerCount = Math.max(maxTimerCount, timers.size);
    return handle;
  }

  function clearTimer(handle) {
    timers.delete(handle);
  }

  function runDueTimers() {
    for (;;) {
      const due = Array.from(timers.entries())
        .filter(([, timer]) => timer.dueAt <= nowMs)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      if (due.length === 0) return;
      const [handle, timer] = due[0];
      timers.delete(handle);
      timer.callback();
    }
  }

  return {
    now: () => nowMs,
    setTimer,
    clearTimer,
    advance(ms) {
      nowMs += ms;
      runDueTimers();
    },
    setNow(value) {
      nowMs = value;
    },
    timerCount: () => timers.size,
    maxTimerCount: () => maxTimerCount,
    nextTimer() {
      return Array.from(timers.values()).sort((left, right) => left.dueAt - right.dueAt)[0];
    },
    handles
  };
}

function schedulerOptions(clock, overrides = {}) {
  return {
    intervalMs: 5000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides
  };
}

test('normalizePersistIntervalMs accepts zero and bounded finite intervals', () => {
  assert.equal(normalizePersistIntervalMs(0), 0);
  assert.equal(normalizePersistIntervalMs('0'), 0);
  assert.equal(normalizePersistIntervalMs(2500), 2500);
  assert.equal(normalizePersistIntervalMs(' 2500 '), 2500);
  assert.equal(normalizePersistIntervalMs(0.1), 1);
  assert.equal(normalizePersistIntervalMs('1.01'), 2);
  assert.equal(normalizePersistIntervalMs(120000), MAX_HUB_PERSIST_INTERVAL_MS);
});

test('normalizePersistIntervalMs rejects non-finite and non-numeric values', () => {
  const invalidValues = [
    undefined,
    null,
    true,
    false,
    '',
    '   ',
    -1,
    '-1',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    'Infinity',
    'nope',
    [],
    {},
    Object(5)
  ];

  for (const value of invalidValues) {
    assert.equal(normalizePersistIntervalMs(value), DEFAULT_HUB_PERSIST_INTERVAL_MS);
  }
});

test('normalizePersistIntervalMs strictly normalizes its fallback', () => {
  assert.equal(normalizePersistIntervalMs(undefined, '2500'), 2500);
  assert.equal(normalizePersistIntervalMs(null, 0), 0);
  assert.equal(normalizePersistIntervalMs(false, 0.1), 1);
  assert.equal(normalizePersistIntervalMs('', 120000), MAX_HUB_PERSIST_INTERVAL_MS);

  for (const fallback of [undefined, null, true, '', ' ', -1, Number.NaN, 'nope', []]) {
    assert.equal(normalizePersistIntervalMs(undefined, fallback), DEFAULT_HUB_PERSIST_INTERVAL_MS);
  }
});

test('persistence scheduler constants expose bounded defaults', () => {
  assert.equal(DEFAULT_HUB_PERSIST_INTERVAL_MS, 5000);
  assert.equal(MAX_HUB_PERSIST_INTERVAL_MS, 60000);
  assert.equal(HUB_PERSIST_RETRY_DELAY_MS, 1000);
});

test('writes the first mark immediately and coalesces the window into one trailing write', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 'first';
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => writes.push(current)
  }));

  scheduler.markDirty();
  clock.advance(1000);
  current = 'second';
  scheduler.markDirty();
  current = 'latest';
  scheduler.markDirty();

  assert.deepEqual(writes, ['first']);
  assert.equal(clock.timerCount(), 1);
  assert.equal(clock.nextTimer().dueAt, 5000);

  clock.advance(3999);
  assert.deepEqual(writes, ['first']);
  clock.advance(1);

  assert.deepEqual(writes, ['first', 'latest']);
  assert.equal(clock.timerCount(), 0);
  assert.equal(clock.maxTimerCount(), 1);
  assert.deepEqual(clock.handles.map((handle) => handle.unrefCalls), [1]);
});

test('continuous marks do not move the trailing deadline', () => {
  const clock = createManualClock();
  const writes = [];
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => writes.push(clock.now())
  }));

  scheduler.markDirty();
  for (let index = 1; index <= 4; index += 1) {
    clock.advance(1000);
    scheduler.markDirty();
    assert.equal(clock.nextTimer().dueAt, 5000);
  }

  clock.advance(1000);

  assert.deepEqual(writes, [0, 5000]);
  assert.equal(clock.maxTimerCount(), 1);
});

test('zero interval writes every mark synchronously', () => {
  const clock = createManualClock();
  let writes = 0;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    intervalMs: 0,
    write: () => { writes += 1; }
  }));

  scheduler.markDirty();
  scheduler.markDirty();
  scheduler.markDirty();

  assert.equal(writes, 3);
  assert.equal(clock.timerCount(), 0);
});

test('flush cancels the trailing timer and writes the latest state', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 'baseline';
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => writes.push(current)
  }));

  scheduler.markDirty();
  clock.advance(100);
  current = 'pending';
  scheduler.markDirty();
  current = 'forced-latest';
  scheduler.flush();

  assert.deepEqual(writes, ['baseline', 'forced-latest']);
  assert.equal(clock.timerCount(), 0);

  clock.advance(5000);
  assert.deepEqual(writes, ['baseline', 'forced-latest']);
});

test('flush writes unconditionally when the scheduler is clean', () => {
  const clock = createManualClock();
  let writes = 0;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => { writes += 1; }
  }));

  scheduler.flush();
  scheduler.flush();

  assert.equal(writes, 2);
  assert.equal(clock.timerCount(), 0);
});

test('flushPending does not force a clean write', () => {
  const clock = createManualClock();
  let writes = 0;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => { writes += 1; }
  }));

  scheduler.flushPending();
  assert.equal(writes, 0);

  scheduler.markDirty();
  scheduler.flushPending();

  assert.equal(writes, 1);
  assert.equal(clock.timerCount(), 0);
});

test('flushPending synchronously drains dirty state and leaves the scheduler usable', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 'baseline';
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => writes.push(current)
  }));

  scheduler.markDirty();
  clock.advance(100);
  current = 'first pending';
  scheduler.markDirty();
  assert.equal(clock.timerCount(), 1);

  scheduler.flushPending();

  assert.deepEqual(writes, ['baseline', 'first pending']);
  assert.equal(clock.timerCount(), 0);

  clock.advance(100);
  current = 'second pending';
  scheduler.markDirty();
  scheduler.flushPending();

  assert.deepEqual(writes, ['baseline', 'first pending', 'second pending']);
  assert.equal(clock.timerCount(), 0);
});

test('reentrant flushPending drains only a newer dirty generation without recursion', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 'baseline';
  let reenter = true;
  let writeDepth = 0;
  let maxWriteDepth = 0;
  let scheduler;
  scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      writeDepth += 1;
      maxWriteDepth = Math.max(maxWriteDepth, writeDepth);
      writes.push(current);
      if (reenter) {
        reenter = false;
        scheduler.flushPending();
        current = 'reentrant latest';
        scheduler.markDirty();
        scheduler.flushPending();
      }
      writeDepth -= 1;
    }
  }));

  scheduler.markDirty();

  assert.deepEqual(writes, ['baseline', 'reentrant latest']);
  assert.equal(maxWriteDepth, 1);
  assert.equal(clock.timerCount(), 0);
  scheduler.flushPending();
  assert.deepEqual(writes, ['baseline', 'reentrant latest']);
});

test('failed timer writes log and retry once after a positive delay', () => {
  const clock = createManualClock();
  const errors = [];
  const writes = [];
  let current = 'baseline';
  let failNext = false;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      writes.push(current);
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
    },
    onError: (error) => errors.push(error.message)
  }));

  scheduler.markDirty();
  clock.advance(1);
  current = 'pending';
  scheduler.markDirty();
  failNext = true;
  clock.advance(4999);

  assert.deepEqual(writes, ['baseline', 'pending']);
  assert.deepEqual(errors, ['disk full']);
  assert.equal(clock.timerCount(), 1);
  assert.equal(clock.nextTimer().delayMs, HUB_PERSIST_RETRY_DELAY_MS);
  assert.equal(clock.nextTimer().dueAt, 6000);

  current = 'latest during retry';
  scheduler.markDirty();
  assert.deepEqual(writes, ['baseline', 'pending']);
  assert.equal(clock.timerCount(), 1);
  assert.equal(clock.nextTimer().dueAt, 6000);

  clock.advance(1000);

  assert.deepEqual(writes, ['baseline', 'pending', 'latest during retry']);
  assert.equal(clock.timerCount(), 0);
  assert.equal(clock.maxTimerCount(), 1);
  assert.deepEqual(clock.handles.map((handle) => handle.unrefCalls), [1, 1]);
});

test('failed forced flush preserves dirty state and its retry timer', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 'baseline';
  let failNext = false;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      writes.push(current);
      if (failNext) {
        failNext = false;
        throw new Error('cannot replace');
      }
    }
  }));

  scheduler.markDirty();
  clock.advance(100);
  current = 'pending';
  scheduler.markDirty();
  failNext = true;

  assert.throws(() => scheduler.flush(), /cannot replace/);
  assert.equal(clock.timerCount(), 1);
  assert.equal(clock.nextTimer().delayMs, HUB_PERSIST_RETRY_DELAY_MS);

  current = 'latest after rollback';
  scheduler.markDirty();
  assert.deepEqual(writes, ['baseline', 'pending']);

  clock.advance(HUB_PERSIST_RETRY_DELAY_MS);

  assert.deepEqual(writes, ['baseline', 'pending', 'latest after rollback']);
  assert.equal(clock.timerCount(), 0);
});

test('a clean forced flush failure becomes dirty and retries without a zero-delay spin', () => {
  const clock = createManualClock();
  let attempts = 0;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    retryDelayMs: 0,
    write: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
    }
  }));

  assert.throws(() => scheduler.flush(), /offline/);
  assert.equal(attempts, 1);
  assert.equal(clock.nextTimer().delayMs, HUB_PERSIST_RETRY_DELAY_MS);

  clock.advance(HUB_PERSIST_RETRY_DELAY_MS - 1);
  assert.equal(attempts, 1);
  clock.advance(1);

  assert.equal(attempts, 2);
  assert.equal(clock.timerCount(), 0);
});

test('a backward clock movement makes a new mark immediately due', () => {
  const clock = createManualClock(100);
  const writes = [];
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => writes.push(clock.now())
  }));

  scheduler.markDirty();
  clock.advance(20);
  scheduler.markDirty();
  assert.equal(clock.timerCount(), 1);

  clock.setNow(90);
  scheduler.markDirty();

  assert.deepEqual(writes, [100, 90]);
  assert.equal(clock.timerCount(), 0);
});

test('stop flushes dirty state, never retries, and rejects later marks', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 'baseline';
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => writes.push(current)
  }));

  scheduler.markDirty();
  clock.advance(100);
  current = 'pending at stop';
  scheduler.markDirty();
  scheduler.stop();

  assert.deepEqual(writes, ['baseline', 'pending at stop']);
  assert.equal(clock.timerCount(), 0);
  assert.throws(
    () => scheduler.markDirty(),
    { message: 'Persistence scheduler has been stopped' }
  );

  scheduler.stop();
  assert.deepEqual(writes, ['baseline', 'pending at stop']);
});

test('stop does not arm a retry when its final dirty write fails', () => {
  const clock = createManualClock();
  let fail = false;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      if (fail) throw new Error('shutdown write failed');
    }
  }));

  scheduler.markDirty();
  clock.advance(1);
  scheduler.markDirty();
  fail = true;

  assert.throws(() => scheduler.stop(), /shutdown write failed/);
  assert.equal(clock.timerCount(), 0);
});

test('a reentrant mark during the initial write stays dirty until the trailing deadline', () => {
  const clock = createManualClock();
  const writes = [];
  let scheduler;
  let reenter = true;
  scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      writes.push(clock.now());
      if (!reenter) return;
      reenter = false;
      scheduler.markDirty();
    }
  }));

  scheduler.markDirty();

  assert.deepEqual(writes, [0]);
  assert.equal(clock.timerCount(), 1);
  assert.equal(clock.nextTimer().dueAt, 5000);

  clock.advance(5000);

  assert.deepEqual(writes, [0, 5000]);
  assert.equal(clock.timerCount(), 0);
});

test('stop persists a reentrant mutation created during flush', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 'baseline';
  let reenterDuringFlush = false;
  let scheduler;
  scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      writes.push(current);
      if (!reenterDuringFlush) return;
      reenterDuringFlush = false;
      current = 'reentrant latest';
      scheduler.markDirty();
    }
  }));

  scheduler.markDirty();
  clock.advance(100);
  current = 'forced snapshot';
  reenterDuringFlush = true;
  scheduler.flush();
  scheduler.stop();

  assert.deepEqual(writes, ['baseline', 'forced snapshot', 'reentrant latest']);
  assert.equal(clock.timerCount(), 0);
});

test('stop drains a newer reentrant mutation without recursive writes', () => {
  const clock = createManualClock();
  const writes = [];
  let writeDepth = 0;
  let maxWriteDepth = 0;
  let reenter = true;
  let scheduler;
  scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      writeDepth += 1;
      maxWriteDepth = Math.max(maxWriteDepth, writeDepth);
      writes.push(clock.now());
      if (reenter) {
        reenter = false;
        scheduler.markDirty();
        scheduler.stop();
      }
      writeDepth -= 1;
    }
  }));

  scheduler.markDirty();

  assert.deepEqual(writes, [0, 0]);
  assert.equal(maxWriteDepth, 1);
  assert.equal(clock.timerCount(), 0);
  assert.throws(
    () => scheduler.markDirty(),
    { message: 'Persistence scheduler has been stopped' }
  );
});

test('each repeated timer failure is reported and re-arms one positive retry', () => {
  const clock = createManualClock();
  const errors = [];
  let attempts = 0;
  let failuresRemaining = 0;
  const scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      attempts += 1;
      if (failuresRemaining === 0) return;
      const failureNumber = 4 - failuresRemaining;
      failuresRemaining -= 1;
      throw new Error(`failure ${failureNumber}`);
    },
    onError: (error) => errors.push(error.message)
  }));

  scheduler.markDirty();
  clock.advance(1);
  scheduler.markDirty();
  failuresRemaining = 3;
  clock.advance(4999);

  for (let failureNumber = 1; failureNumber <= 3; failureNumber += 1) {
    assert.deepEqual(errors, Array.from(
      { length: failureNumber },
      (_, index) => `failure ${index + 1}`
    ));
    assert.equal(clock.timerCount(), 1);
    assert.equal(clock.nextTimer().delayMs, HUB_PERSIST_RETRY_DELAY_MS);
    assert.ok(clock.nextTimer().delayMs > 0);
    clock.advance(HUB_PERSIST_RETRY_DELAY_MS);
  }

  assert.equal(attempts, 5);
  assert.equal(clock.timerCount(), 0);
  assert.equal(clock.maxTimerCount(), 1);
  assert.deepEqual(clock.handles.map((handle) => handle.unrefCalls), [1, 1, 1, 1]);
});

test('a reentrant flush writes the forced mutation sequentially before returning', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 0;
  let writeDepth = 0;
  let maxWriteDepth = 0;
  let forceLatest = true;
  let scheduler;
  scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      writeDepth += 1;
      maxWriteDepth = Math.max(maxWriteDepth, writeDepth);
      writes.push(current);
      if (forceLatest) {
        forceLatest = false;
        current = 1;
        scheduler.flush();
      }
      writeDepth -= 1;
    }
  }));

  scheduler.markDirty();

  assert.deepEqual(writes, [0, 1]);
  assert.equal(maxWriteDepth, 1);
  assert.equal(clock.timerCount(), 0);
});

test('a failed reentrant forced write keeps the latest state dirty for retry', () => {
  const clock = createManualClock();
  const writes = [];
  let current = 0;
  let attempts = 0;
  let forceLatest = true;
  let scheduler;
  scheduler = createPersistenceScheduler(schedulerOptions(clock, {
    write: () => {
      attempts += 1;
      writes.push(current);
      if (forceLatest) {
        forceLatest = false;
        current = 1;
        scheduler.flush();
        return;
      }
      if (attempts === 2) throw new Error('forced write failed');
    }
  }));

  assert.throws(() => scheduler.markDirty(), /forced write failed/);
  assert.deepEqual(writes, [0, 1]);
  assert.equal(clock.timerCount(), 1);
  assert.equal(clock.nextTimer().delayMs, HUB_PERSIST_RETRY_DELAY_MS);

  clock.advance(HUB_PERSIST_RETRY_DELAY_MS);

  assert.deepEqual(writes, [0, 1, 1]);
  assert.equal(clock.timerCount(), 0);
});
