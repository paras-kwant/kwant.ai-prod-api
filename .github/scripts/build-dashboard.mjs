#!/usr/bin/env node
/**
 * Builds the published dashboard: merges this run into history.json (last N runs)
 * and copies the static page into the site directory.
 *
 * Previous history is fetched from the live Pages URL, so no branch juggling is
 * needed. A 404 starts a fresh history; any other fetch failure aborts rather
 * than silently discarding the archive.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = process.env.RESULTS_FILE ?? 'test-results/results.json';
const CALLS_FILE = process.env.API_LOG_FILE ?? 'test-results/api-calls.ndjson';
const SITE_DIR = process.env.SITE_DIR ?? 'site';
const MAX_RUNS = Number(process.env.MAX_RUNS ?? 200);
/** Newest runs keep every call and body; older ones are thinned (see compact). */
const DETAIL_RUNS = Number(process.env.DETAIL_RUNS ?? 30);

const {
  GITHUB_SERVER_URL = 'https://github.com',
  GITHUB_REPOSITORY = '',
  GITHUB_RUN_ID = '',
  GITHUB_RUN_NUMBER = '',
  GITHUB_REF_NAME = 'local',
  GITHUB_SHA = '',
  PAGES_URL = '',
} = process.env;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const report = readJson(RESULTS_FILE, null);
if (!report) {
  console.error(`Cannot read ${RESULTS_FILE}`);
  process.exit(1);
}

const calls = existsSync(CALLS_FILE)
  ? readFileSync(CALLS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : [];

const stats = report.stats ?? {};
const failed = stats.unexpected ?? 0;
const passed = stats.expected ?? 0;

const run = {
  number: GITHUB_RUN_NUMBER || null,
  id: GITHUB_RUN_ID || null,
  url:
    GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : null,
  at: new Date().toISOString(),
  branch: GITHUB_REF_NAME,
  sha: GITHUB_SHA ? GITHUB_SHA.slice(0, 7) : '',
  total: passed + failed,
  passed,
  failed,
  flaky: stats.flaky ?? 0,
  durationMs: stats.duration ?? 0,
  calls: calls.map((c) => ({
    endpoint: c.endpoint,
    project: c.project,
    projectId: c.projectId,
    floorId: c.floorId ?? '',
    variant: c.variant ?? '',
    method: c.method,
    url: c.url,
    status: c.status,
    ok: c.ok,
    ms: c.ms,
    bytes: c.bytes,
    body: c.body,
  })),
};

/** Previously published history, or an empty archive on a first deploy. */
async function loadHistory() {
  if (!PAGES_URL) {
    console.log('PAGES_URL not set — starting a fresh history.');
    return [];
  }
  const url = `${PAGES_URL.replace(/\/$/, '')}/history.json`;
  try {
    const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (response.status === 404) {
      console.log('No published history yet — starting fresh.');
      return [];
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const previous = await response.json();
    const runs = Array.isArray(previous) ? previous : (previous.runs ?? []);
    console.log(`Loaded ${runs.length} previous run(s) from ${url}`);
    return runs;
  } catch (error) {
    console.error(`Could not load existing history from ${url}: ${error.message}`);
    console.error('Refusing to overwrite the archive with a single run.');
    process.exit(1);
  }
}

/**
 * Keeping every response body for every run would make history.json tens of MB.
 * The newest DETAIL_RUNS keep everything; past that a run keeps only its failed
 * calls, and a fully green old run keeps none. Counts always survive, so the
 * chart and stats stay accurate however far back the archive goes.
 */
function compact(runs) {
  return runs.map((r, i) => {
    if (i < DETAIL_RUNS) return { ...r, trimmed: false };
    const calls = r.calls ?? [];
    return {
      ...r,
      calls: calls.filter((c) => !c.ok),
      callCount: r.callCount ?? calls.length,
      trimmed: true,
    };
  });
}

const history = compact([run, ...(await loadHistory())].slice(0, MAX_RUNS));

mkdirSync(SITE_DIR, { recursive: true });
writeFileSync(
  join(SITE_DIR, 'history.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    detailRuns: DETAIL_RUNS,
    maxRuns: MAX_RUNS,
    runs: history,
  })
);
copyFileSync(join(HERE, '..', 'dashboard', 'index.html'), join(SITE_DIR, 'index.html'));

const bytes = readFileSync(join(SITE_DIR, 'history.json')).length;
console.log(
  `Dashboard built: ${history.length} run(s), ${run.calls.length} API call(s) this run, ` +
    `history.json ${(bytes / 1024).toFixed(0)} KB`
);
