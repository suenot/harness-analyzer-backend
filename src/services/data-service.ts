import * as path from 'node:path';
import { collect, getDirectoryFingerprint, type CollectorResult } from '@harness-analyzer/core';

export {
  filterSessions,
  getSessionById,
  getProjectStats,
  formatLocalDay,
  getHistoryChart,
  getDailyChart,
  getDailyModelChart,
  getHeatmapData,
  getModelUsage,
  getModelStats,
  getHourlyStats,
  getCacheExpiryStats,
  getCacheStats,
  getSourceStats,
  getSourceUsage,
} from '@harness-analyzer/core';
export type {
  ProjectEntry,
  HistoryTimeframe,
  HistoryGroupBy,
  HistoryValue,
  HistoryBucket,
  HistoryChart,
  UsageStat,
  HourlyStat,
  CacheModelRow,
  CacheStats,
  CacheExpiryBreakdown,
  CacheExpiryIncident,
  CacheExpiryStats,
} from '@harness-analyzer/core';

let cachedResult: CollectorResult | null = null;
let lastFingerprint = '';
let collecting = false;

const WATCHED_DIRS = [
  path.join(process.env.HOME || '', '.claude/projects'),
  path.join(process.env.HOME || '', '.codex/sessions'),
  path.join(process.env.HOME || '', 'Library/Application Support/Claude/local-agent-mode-sessions'),
];

function computeFingerprint(): string {
  let fingerprint = '';
  for (const dir of WATCHED_DIRS) fingerprint += getDirectoryFingerprint(dir) + '||';
  return fingerprint;
}

function collectSync(): CollectorResult {
  const start = Date.now();
  console.log(cachedResult ? 'Files changed, re-collecting...' : 'Collecting data...');
  const result = collect();
  cachedResult = result;
  lastFingerprint = computeFingerprint();
  console.log(`Loaded ${result.sessions.length} sessions in ${Date.now() - start}ms`);
  return result;
}

export function isReady(): boolean {
  return cachedResult !== null;
}

export function startBackgroundCollect(): void {
  if (collecting) return;
  collecting = true;
  setImmediate(() => {
    collectSync();
    collecting = false;
  });
}

export function getData(): CollectorResult | null {
  if (!cachedResult) return null;
  if (computeFingerprint() !== lastFingerprint) collectSync();
  return cachedResult;
}

export function refreshData(): CollectorResult {
  lastFingerprint = '';
  return collectSync();
}
