#!/usr/bin/env node
/**
 * Publishes production's frozen dashboard and report at the site root, beside
 * the live QA ones at /qa/. A Pages deploy replaces the whole site, so every QA
 * build re-emits this — once is not enough.
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
const SOURCE = join(HERE, '..', 'dashboard', 'prod-report');
const OUT_DIR = process.env.PROD_ARCHIVE_DIR ?? 'site';

if (!existsSync(join(SOURCE, 'history.json'))) {
  console.log('No vendored production archive — skipping.');
  process.exit(0);
}

mkdirSync(join(OUT_DIR, 'report'), { recursive: true });
copyFileSync(join(SOURCE, 'history.json'), join(OUT_DIR, 'history.json'));
copyFileSync(join(HERE, '..', 'dashboard', 'index.html'), join(OUT_DIR, 'index.html'));
copyFileSync(join(SOURCE, 'index.html'), join(OUT_DIR, 'report', 'index.html'));

const { runs = [] } = JSON.parse(readFileSync(join(OUT_DIR, 'history.json'), 'utf8'));
writeFileSync(
  join(OUT_DIR, 'history.json'),
  JSON.stringify({
    ...JSON.parse(readFileSync(join(SOURCE, 'history.json'), 'utf8')),
    frozen: true,
    frozenReason: 'Production monitoring retired — this archive no longer updates.',
  })
);

console.log(`Published ${runs.length} frozen production run(s) at the site root.`);
