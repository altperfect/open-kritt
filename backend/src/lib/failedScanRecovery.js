import { Prisma } from '@prisma/client';

import { prisma } from '../db.js';
import { logger } from './logger.js';
import { readRuntimeSettings } from './runtimeSettings.js';

export const FAILED_SCAN_RECOVERY_DELAY_MS = 1_000;
export const FAILED_SCAN_RECOVERY_INTERVAL_MS = 500;

export function resumedScanData(now = new Date()) {
  return {
    status: 'pending',
    reasoning: Prisma.DbNull,
    lastResumedAt: now,
  };
}

export async function resumeFailedScans({
  db = prisma,
  readSettings = readRuntimeSettings,
  now = () => new Date(),
} = {}) {
  const runtime = await readSettings();
  if (runtime.settings?.autoResumeFailedScans?.value !== true) return 0;

  const resumedAt = now();
  const failedBefore = new Date(resumedAt.getTime() - FAILED_SCAN_RECOVERY_DELAY_MS);
  const result = await db.scan.updateMany({
    where: { status: 'failed', updatedAt: { lte: failedBefore } },
    data: resumedScanData(resumedAt),
  });
  return result.count;
}

export function startFailedScanRecovery({
  intervalMs = FAILED_SCAN_RECOVERY_INTERVAL_MS,
  schedule = setInterval,
  cancel = clearInterval,
  log = logger,
  ...dependencies
} = {}) {
  let running = false;
  const tick = async () => {
    if (running) return 0;
    running = true;
    try {
      const count = await resumeFailedScans(dependencies);
      if (count > 0) log.info({ count }, 'automatically resumed failed scans');
      return count;
    } catch (error) {
      log.error({ err: error }, 'failed scan recovery monitor failed');
      return 0;
    } finally {
      running = false;
    }
  };

  const timer = schedule(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    tick,
    stop: () => cancel(timer),
  };
}
