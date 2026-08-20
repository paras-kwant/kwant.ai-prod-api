#!/usr/bin/env node
/**
 * Re-emits the retired production archive under /prod/ so a QA deploy does not
 * delete it. A Pages deploy replaces the whole site, so this has to run on
 * every QA build, not once.
 *
 * Reads <root>/prod/history.json, falling back to <root>/history.json for the
 * first run (before /prod/ exists). Missing archive is fine — nothing to keep.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_URL = (process.env.SITE_ROOT_URL ?? '').replace(/\/$/, '');
const OUT_DIR = process.env.PROD_ARCHIVE_DIR ?? 'site/prod';

if (!ROOT_URL) {
  console.log('SITE_ROOT_URL not set — skipping the production archive.');
  process.exit(0);
}

async function fetchArchive(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

let archive = null;
try {
  archive =
    (await fetchArchive(`${ROOT_URL}/prod/history.json`)) ??
    (await fetchArchive(`${ROOT_URL}/history.json`));
} catch (error) {
  // Never fail the QA deploy over the frozen copy; the previous one stays live
  // only if this build republishes it, so say so loudly instead.
  console.error(`Could not read the production archive: ${error.message}`);
  console.error('Publishing without /prod/ — it will be missing from this deploy.');
  process.exit(0);
}

if (!archive) {
  console.log('No production archive to preserve.');
  process.exit(0);
}

const runs = Array.isArray(archive) ? archive : (archive.runs ?? []);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, 'history.json'),
  JSON.stringify({
    ...(Array.isArray(archive) ? {} : archive),
    runs,
    frozen: true,
    frozenReason: 'Production monitoring retired — this archive no longer updates.',
  })
);
copyFileSync(join(HERE, '..', 'dashboard', 'index.html'), join(OUT_DIR, 'index.html'));

console.log(`Preserved ${runs.length} production run(s) at /prod/.`);
