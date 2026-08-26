'use strict';

const { performance } = require('node:perf_hooks');

const DEFAULT_HUB_PERSIST_INTERVAL_MS = 5000;
const MAX_HUB_PERSIST_INTERVAL_MS = 60000;
const HUB_PERSIST_RETRY_DELAY_MS = 1000;
const STOPPED_ERROR_MESSAGE = 'Persistence scheduler has been stopped';

function numericInterval(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

function normalizeFiniteInterval(numeric) {
  if (numeric === 0) return 0;
  return Math.min(Math.ceil(numeric), MAX_HUB_PERSIST_INTERVAL_MS);
}

function normalizeFallback(fallback) {
  const numeric = numericInterval(fallback);
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_HUB_PERSIST_INTERVAL_MS;
  return normalizeFiniteInterval(numeric);
}

function normalizePersistIntervalMs(value, fallback = DEFAULT_HUB_PERSIST_INTERVAL_MS) {
  const numeric = numericInterval(value);
  if (!Number.isFinite(numeric) || numeric < 0) return normalizeFallback(fallback);
  return normalizeFiniteInterval(numeric);
}

function normalizeRetryDelayMs(value) {
  const numeric = numericInterval(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return HUB_PERSIST_RETRY_DELAY_MS;
  return Math.ceil(numeric);
}

function createPersistenceScheduler(options = {}) {
  const write = options.write;
  const intervalMs = normalizePersistIntervalMs(options.intervalMs);
  const now = typeof options.now === 'function' ? options.now : () => performance.now();
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const retryDelayMs = normalizeRetryDelayMs(options.retryDelayMs);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let dirty = false;
  let stopped = false;
  let lastSuccessfulWriteAt = null;
  let timer = null;
  let timerKind = null;
  let mutationGeneration = 0;
  let writeInProgress = false;
  let pendingForce = false;

  if (typeof write !== 'function') throw new TypeError('write must be a function');

  function clearScheduledTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
    timerKind = null;
  }

  function armTimer(kind, delayMs) {
    if (stopped || timer !== null) return;
    timerKind = kind;
    timer = setTimer(() => {
      timer = null;
      timerKind = null;
      if (stopped) return;
      try {
        attemptWrite();
      } catch (error) {
        onError(error);
      }
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function armRetry() {
    armTimer('retry', retryDelayMs);
  }

  function attemptWrite() {
    if (writeInProgress) return;
    writeInProgress = true;
    try {
      do {
        pendingForce = false;
        const writeGeneration = mutationGeneration;
        dirty = false;
        write();
        lastSuccessfulWriteAt = now();
        dirty = mutationGeneration !== writeGeneration;
      } while (dirty && (pendingForce || stopped || intervalMs === 0));
    } catch (error) {
      dirty = true;
      if (!stopped) armRetry();
      throw error;
    } finally {
      writeInProgress = false;
    }

    if (dirty && !stopped) armTimer('trailing', intervalMs);
  }

  function markDirty() {
    if (stopped) throw new Error(STOPPED_ERROR_MESSAGE);
    mutationGeneration += 1;
    dirty = true;
    if (writeInProgress) return;
    if (timerKind === 'retry') return;

    const currentTime = now();
    const clockMovedBackward = lastSuccessfulWriteAt !== null && currentTime < lastSuccessfulWriteAt;
    const writeIsDue = lastSuccessfulWriteAt === null ||
      clockMovedBackward ||
      currentTime - lastSuccessfulWriteAt >= intervalMs;

    if (intervalMs === 0 || writeIsDue) {
      clearScheduledTimer();
      attemptWrite();
      return;
    }

    armTimer('trailing', intervalMs - (currentTime - lastSuccessfulWriteAt));
  }

  function flush() {
    if (stopped) throw new Error(STOPPED_ERROR_MESSAGE);
    clearScheduledTimer();
    mutationGeneration += 1;
    dirty = true;
    if (writeInProgress) {
      pendingForce = true;
      return;
    }
    attemptWrite();
  }

  function flushPending() {
    if (stopped) throw new Error(STOPPED_ERROR_MESSAGE);
    if (!dirty) return;
    clearScheduledTimer();
    if (writeInProgress) {
      pendingForce = true;
      return;
    }
    attemptWrite();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearScheduledTimer();
    if (dirty && !writeInProgress) attemptWrite();
  }

  return { flush, flushPending, markDirty, stop };
}

module.exports = {
  DEFAULT_HUB_PERSIST_INTERVAL_MS,
  HUB_PERSIST_RETRY_DELAY_MS,
  MAX_HUB_PERSIST_INTERVAL_MS,
  createPersistenceScheduler,
  normalizePersistIntervalMs
};
