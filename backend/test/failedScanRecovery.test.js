import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Prisma } from '@prisma/client';

import {
  FAILED_SCAN_RECOVERY_DELAY_MS,
  FAILED_SCAN_RECOVERY_INTERVAL_MS,
  resumeFailedScans,
  startFailedScanRecovery,
} from '../src/lib/failedScanRecovery.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('automatic recovery resumes every failed scan through pending', async () => {
  const calls = [];
  const resumedAt = new Date('2026-08-13T12:00:00Z');
  const count = await resumeFailedScans({
    db: {
      scan: {
        updateMany: async (query) => {
          calls.push(query);
          return { count: 3 };
        },
      },
    },
    readSettings: async () => ({ settings: { autoResumeFailedScans: { value: true } } }),
    now: () => resumedAt,
  });

  assert.equal(count, 3);
  assert.deepEqual(calls, [
    {
      where: { status: 'failed', updatedAt: { lte: new Date('2026-08-13T11:59:59Z') } },
      data: {
        status: 'pending',
        reasoning: Prisma.DbNull,
        lastResumedAt: resumedAt,
      },
    },
  ]);
});

test('automatic recovery leaves failed scans untouched when disabled', async () => {
  let updates = 0;
  const count = await resumeFailedScans({
    db: {
      scan: {
        updateMany: async () => {
          updates += 1;
          return { count: 1 };
        },
      },
    },
    readSettings: async () => ({ settings: { autoResumeFailedScans: { value: false } } }),
  });

  assert.equal(count, 0);
  assert.equal(updates, 0);
});

test('automatic recovery reads the live setting before every recovery pass', async () => {
  let enabled = false;
  let reads = 0;
  let updates = 0;
  const dependencies = {
    db: {
      scan: {
        updateMany: async () => {
          updates += 1;
          return { count: 1 };
        },
      },
    },
    readSettings: async () => {
      reads += 1;
      return { settings: { autoResumeFailedScans: { value: enabled } } };
    },
  };

  assert.equal(await resumeFailedScans(dependencies), 0);
  enabled = true;
  assert.equal(await resumeFailedScans(dependencies), 1);
  assert.equal(reads, 2);
  assert.equal(updates, 1);
});

test('failed scan recovery checks twice per second without overlapping ticks', async () => {
  const firstUpdate = deferred();
  const calls = [];
  let scheduled;
  let cancelled;
  let unrefCount = 0;
  let updateCount = 0;
  const timer = { unref: () => (unrefCount += 1) };
  const monitor = startFailedScanRecovery({
    db: {
      scan: {
        updateMany: async () => {
          updateCount += 1;
          if (updateCount === 1) await firstUpdate.promise;
          return { count: 0 };
        },
      },
    },
    readSettings: async () => ({ settings: { autoResumeFailedScans: { value: true } } }),
    schedule: (callback, milliseconds) => {
      scheduled = { callback, milliseconds };
      return timer;
    },
    cancel: (value) => {
      cancelled = value;
    },
    log: {
      info: (...args) => calls.push(['info', ...args]),
      error: (...args) => calls.push(['error', ...args]),
    },
  });

  assert.equal(scheduled.milliseconds, FAILED_SCAN_RECOVERY_INTERVAL_MS);
  assert.equal(FAILED_SCAN_RECOVERY_DELAY_MS, 1_000);
  assert.equal(FAILED_SCAN_RECOVERY_INTERVAL_MS, 500);
  assert.equal(unrefCount, 1);

  const running = monitor.tick();
  await Promise.resolve();
  assert.equal(await monitor.tick(), 0);
  assert.equal(updateCount, 1);
  firstUpdate.resolve();
  await running;
  assert.equal(await monitor.tick(), 0);
  assert.equal(updateCount, 2);
  assert.deepEqual(calls, []);

  monitor.stop();
  assert.equal(cancelled, timer);
});

test('failed scan recovery logs an error and continues monitoring', async () => {
  const errors = [];
  let attempts = 0;
  const monitor = startFailedScanRecovery({
    db: {
      scan: {
        updateMany: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('database unavailable');
          return { count: 0 };
        },
      },
    },
    readSettings: async () => ({ settings: { autoResumeFailedScans: { value: true } } }),
    schedule: () => ({ unref() {} }),
    cancel: () => {},
    log: {
      info: () => {},
      error: (...args) => errors.push(args),
    },
  });

  assert.equal(await monitor.tick(), 0);
  assert.equal(await monitor.tick(), 0);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0][1], /failed scan recovery monitor failed/);
});
