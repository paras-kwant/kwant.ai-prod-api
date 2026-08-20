#!/usr/bin/env node
/**
 * Publishes production's frozen dashboard and report at /prod/, beside the live
 * QA ones at /qa/, plus the index page that lists both at the root. A Pages
 * deploy replaces the whole site, so every QA build re-emits this — once is not
 * enough.
 *
 * Both files are vendored under .github/dashboard/prod-report/ rather than
 * re-fetched from the live site. The archive stopped changing when production
 * monitoring was retired, and fetching it would mean one failed request could
 * erase 85 runs permanently: the deploy would ship without them, and the next
 * build would find nothing to copy.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, '..', 'dashboard');
const SOURCE = join(DASHBOARD, 'prod-report');
const SITE_DIR = process.env.SITE_ROOT_DIR ?? 'site';
const OUT_DIR = process.env.PROD_ARCHIVE_DIR ?? join(SITE_DIR, 'prod');

// The root index lists both dashboards; it is not tied to the archive existing.
mkdirSync(SITE_DIR, { recursive: true });
copyFileSync(join(DASHBOARD, 'root.html'), join(SITE_DIR, 'index.html'));

if (!existsSync(join(SOURCE, 'history.json'))) {
  console.log('No vendored production archive — published the root index only.');
  process.exit(0);
}

const archive = JSON.parse(readFileSync(join(SOURCE, 'history.json'), 'utf8'));

mkdirSync(join(OUT_DIR, 'report'), { recursive: true });
writeFileSync(
  join(OUT_DIR, 'history.json'),
  JSON.stringify({
    ...archive,
    frozen: true,
    frozenReason: 'Production monitoring retired — this archive no longer updates.',
  })
);
copyFileSync(join(DASHBOARD, 'index.html'), join(OUT_DIR, 'index.html'));
copyFileSync(join(SOURCE, 'index.html'), join(OUT_DIR, 'report', 'index.html'));

console.log(`Published ${(archive.runs ?? []).length} frozen production run(s) at /prod/.`);
