import { rmSync } from 'node:fs';
import { LOG_FILE } from './apiLog';

/**
 * Clears the API call log once per run, before any worker starts.
 *
 * recordApiCall appends, so without this a second run in the same working tree
 * would leave the first run's calls in the file and the dashboard would credit
 * them all to the latest run. It used to be handled by accident: the log lived
 * under `test-results/`, which Playwright wipes at the start of every run. With
 * SUITE the log sits beside that directory rather than inside it, so the reset
 * has to be explicit — and it must happen here rather than in apiLog.ts, which
 * is imported once per worker and would have each worker truncate the others'
 * entries.
 *
 * CI never saw the bug (a fresh checkout each run) which is exactly why it is
 * worth keeping: local runs have to build the same dashboard CI does.
 */
export default function globalSetup(): void {
  rmSync(LOG_FILE, { force: true });
}
