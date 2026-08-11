#!/usr/bin/env node
/**
 * Posts a Slack message listing failed API tests.
 * Reads test-results/results.json (Playwright JSON reporter) and exits quietly
 * when everything passed. Requires SLACK_WEBHOOK_URL.
 */
import { readFileSync } from 'node:fs';

const RESULTS_FILE = process.env.RESULTS_FILE ?? 'test-results/results.json';
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const MAX_FAILURES_SHOWN = 12;

const {
  GITHUB_SERVER_URL = 'https://github.com',
  GITHUB_REPOSITORY = '',
  GITHUB_RUN_ID = '',
  GITHUB_REF_NAME = '',
  GITHUB_SHA = '',
  REPORT_URL = '',
} = process.env;

const runUrl =
  GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : '';

let report;
try {
  report = JSON.parse(readFileSync(RESULTS_FILE, 'utf8'));
} catch (error) {
  console.error(`Cannot read ${RESULTS_FILE}: ${error.message}`);
  process.exit(1);
}

/** Walk the suite tree, yielding every spec with the titles of its ancestors. */
function* walk(suite, trail = []) {
  const here = suite.title ? [...trail, suite.title] : trail;
  for (const spec of suite.specs ?? []) yield { spec, trail: here };
  for (const child of suite.suites ?? []) yield* walk(child, here);
}

const clean = (text) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const failures = [];
let total = 0;

for (const { spec, trail } of walk({ suites: report.suites ?? [] })) {
  total += 1;
  if (spec.ok) continue;

  const result = spec.tests?.[0]?.results?.at(-1);
  const message = [result?.error?.message, ...(result?.errors ?? []).map((e) => e.message)]
    .filter(Boolean)
    .join('\n');

  // The file name is the endpoint under test; the trailing titles carry the
  // project name and id, e.g. "RSW Terminal E (7005132808)".
  const endpoint = (trail[0] ?? '').replace(/^tests\//, '').replace(/\.spec\.ts$/, '');
  const label = [...trail.slice(1).filter((t) => t !== endpoint), spec.title].join(' › ');
  const [, name = label, id = ''] = label.match(/^(.*?)\s*\(([^)]+)\)\s*(.*)$/) ?? [];
  const variant = label.includes(' › ') ? label.split(' › ').at(-1) : '';

  failures.push({
    endpoint,
    project: name.trim() || label,
    projectId: id,
    variant: variant && variant !== label ? variant : '',
    status: message.match(/HTTP (\d{3})/)?.[1] ?? '',
    url: message.match(/https?:\/\/\S+/)?.[0] ?? '',
    reason: clean(message.split('\n').slice(1).join(' ')).slice(0, 180),
  });
}

const stats = report.stats ?? {};
const passed = stats.expected ?? total - failures.length;
const duration = stats.duration ? `${(stats.duration / 1000).toFixed(1)}s` : '—';

if (failures.length === 0) {
  console.log(`All ${total} tests passed — no Slack message sent.`);
  process.exit(0);
}

const now = new Date();
const stamp = (timeZone) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(now);

/** Group failures under their endpoint so repeated APIs read as one entry. */
const byEndpoint = new Map();
for (const failure of failures) {
  if (!byEndpoint.has(failure.endpoint)) byEndpoint.set(failure.endpoint, []);
  byEndpoint.get(failure.endpoint).push(failure);
}

const shown = [];
let remaining = 0;
for (const [endpoint, items] of byEndpoint) {
  const room = MAX_FAILURES_SHOWN - shown.reduce((n, g) => n + g.items.length, 0);
  if (room <= 0) {
    remaining += items.length;
    continue;
  }
  shown.push({ endpoint, items: items.slice(0, room) });
  remaining += Math.max(0, items.length - room);
}

const endpointBlocks = shown.flatMap(({ endpoint, items }) => {
  const rows = items.map((f) => {
    const who = f.projectId ? `${f.project}  \`${f.projectId}\`` : f.project;
    const variant = f.variant ? `  ·  ${f.variant}` : '';
    const status = f.status ? `  ·  \`${f.status}\`` : '';
    const reason = f.reason ? `\n>_${f.reason}_` : '';
    return `${who}${variant}${status}${reason}`;
  });

  const url = items[0].url ? `\n\`${items[0].url}\`` : '';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${endpoint}*${url}\n${rows.join('\n')}`.slice(0, 2900),
      },
    },
  ];
});

const actions = [
  ...(REPORT_URL
    ? [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '📊  Open report', emoji: true },
          url: REPORT_URL,
        },
      ]
    : []),
  ...(runUrl
    ? [
        {
          type: 'button',
          text: { type: 'plain_text', text: '⚙️  View CI run', emoji: true },
          url: runUrl,
        },
      ]
    : []),
];

const payload = {
  text: `${failures.length} of ${total} Kwant API tests failed`,
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔴  Kwant API — test failures', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Failed*\n${failures.length}` },
        { type: 'mrkdwn', text: `*Passed*\n${passed}` },
        { type: 'mrkdwn', text: `*Total*\n${total}` },
        { type: 'mrkdwn', text: `*Duration*\n${duration}` },
      ],
    },
    { type: 'divider' },
    ...endpointBlocks,
    ...(remaining
      ? [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `_…and ${remaining} more failure(s)_` }],
          },
        ]
      : []),
    ...(actions.length ? [{ type: 'divider' }, { type: 'actions', elements: actions }] : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            `🕒 ${stamp('Asia/Kathmandu')} NPT  ·  ${stamp('UTC')} UTC`,
            GITHUB_REF_NAME ? `🌿 ${GITHUB_REF_NAME}` : '',
            GITHUB_SHA ? `⎇ ${GITHUB_SHA.slice(0, 7)}` : '',
          ]
            .filter(Boolean)
            .join('  ·  '),
        },
      ],
    },
  ],
};

console.log(`${failures.length} of ${total} API tests failed (${passed} passed, ${duration}):`);
for (const { endpoint, items } of shown) {
  console.log(`  ${endpoint}`);
  for (const f of items) {
    console.log(
      `    ${f.project}${f.projectId ? ` (${f.projectId})` : ''}` +
        `${f.variant ? ` · ${f.variant}` : ''}${f.status ? ` · HTTP ${f.status}` : ''}`
    );
    if (f.url) console.log(`      ${f.url}`);
  }
}

if (!WEBHOOK) {
  console.error('SLACK_WEBHOOK_URL is not set — message not sent.');
  process.exit(0);
}

const response = await fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  console.error(`Slack rejected the message: ${response.status} ${await response.text()}`);
  process.exit(1);
}

console.log('Slack notified.');
