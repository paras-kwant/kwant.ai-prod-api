import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_FILE = process.env.API_LOG_FILE ?? 'test-results/api-calls.ndjson';
const MAX_BODY_CHARS = 800;

export type ApiCall = {
  endpoint: string;
  project: string;
  projectId: string;
  /** Plan id the call was scoped to. Resolved per project, so it varies run to run. */
  floorId?: number | string;
  variant?: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  body: string;
};

/**
 * Appends one line per API call for the history dashboard to consume.
 * Bodies are truncated — a successful getPins response is several megabytes.
 */
export function recordApiCall(call: ApiCall): void {
  const record = {
    ...call,
    ok: call.status >= 200 && call.status < 300,
    bytes: call.body.length,
    body: call.body.slice(0, MAX_BODY_CHARS),
    at: new Date().toISOString(),
  };

  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`);
  } catch {
    // Logging must never fail a test.
  }
}
