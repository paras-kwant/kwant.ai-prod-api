import { test, expect, request as apiRequest, APIRequestContext } from '@playwright/test';
import { recordApiCall } from './apiLog';

// The QA spec pointed at https://uat.kwant.ai. UAT is a clone of the same
// environment, so the project and plan ids are identical to the QA ones
// (confirmed against the live API: projects/7801174067 resolves to "Frontier
// Data Center Project", and plan/mostActiveToday returns 7819255146). Only BASE
// and the credentials differ, which is why this is a copy rather than a flag.

const BASE = (process.env.UAT_BASE_URL ?? 'https://uat.kwant.ai').replace(/\/+$/, '');
const LOGIN_URL = `${BASE}/api/login`;
const FLOOR_DETAIL_URL = `${BASE}/api/floorDetail`;
const PROJECT_ZONE_URL = `${BASE}/api/project-zone`;

// The QA pair is the default: the same account is authorised for the project
// below on both environments, so UAT needs no secrets of its own. UAT_KWANT_*
// overrides it. Still never falls back to KWANT_* — UAT must fail rather than
// log in with production credentials.
const EMAIL = process.env.UAT_KWANT_EMAIL || process.env.QA_KWANT_EMAIL!;
const PASSWORD = process.env.UAT_KWANT_PASSWORD || process.env.QA_KWANT_PASSWORD!;

// From the UAT UI URL /projects/7801174067/location/plan/7819255146. The pair
// travels together — a plan under another project returns 400.
const PROJECTS = [
  {
    name: process.env.UAT_PROJECT_NAME || 'Frontier Data Center Project',
    id: process.env.UAT_PROJECT_ID || '7801174067',
    floorId: Number(process.env.UAT_PLAN_ID || 7819255146),
  },
];

// `calendarDay`: midnight (today-13) -> 23:59 today, local. `rolling`: now-14d
// -> now, timezone-independent. Only calendarDay emits the 05:00Z/04:59Z pair
// the app sends — and 14 is what its "last 15 days" filter asks for.
const WINDOW_MODE = (process.env.UAT_WINDOW_MODE || 'calendarDay') as 'calendarDay' | 'rolling';
const WINDOW_DAYS = Number(process.env.UAT_WINDOW_DAYS || 14);

// project-zone reports America/Chicago here; FALLBACK_ZONE covers a failed
// lookup only, so a flaky call cannot shift the window to another instant.
const ZONE_OVERRIDE = process.env.UAT_TIME_ZONE ?? '';
const FALLBACK_ZONE = 'America/Chicago';

const MODULE_KEYS = [
  'worker_detail',
  'company_detail',
  'sensor_detail',
  'zone_detail',
  'gateway_detail',
];

const DAY_MS = 24 * 60 * 60 * 1000;

function isoMinuteUtc(date: Date): string {
  const floored = new Date(date);
  floored.setUTCSeconds(0, 0);
  return floored.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function startOfLocalDay(instant: Date, timeZone: string): Date {
  const local = new Date(instant.getTime() + offsetMs(instant, timeZone));
  local.setUTCHours(0, 0, 0, 0);

  // Resolve twice so a DST transition between midnight and now can't skew it.
  let utc = local.getTime() - offsetMs(instant, timeZone);
  utc = local.getTime() - offsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

// Untruncated: these bodies are under a kilobyte, unlike getPins.
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function lastDaysWindow(timeZone: string): { startDateTime: string; endDateTime: string } {
  const now = new Date();

  if (WINDOW_MODE === 'rolling') {
    return {
      startDateTime: isoMinuteUtc(new Date(now.getTime() - WINDOW_DAYS * DAY_MS)),
      endDateTime: isoMinuteUtc(now),
    };
  }

  // Each end is resolved from its own instant so a DST shift inside the window
  // cannot move the other one.
  const start = startOfLocalDay(new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS), timeZone);
  const end = new Date(startOfLocalDay(new Date(now.getTime() + DAY_MS), timeZone).getTime() - 60_000);
  return { startDateTime: isoMinuteUtc(start), endDateTime: isoMinuteUtc(end) };
}

// @uat is what CI selects on: the monitoring workflow (.github/workflows/qa.yml)
// runs one step per tag, and playwright.yml inverts @qa|@uat to leave only
// the production specs.
test.describe('uatFloorDetail', { tag: '@uat' }, () => {
  let context: APIRequestContext;
  let token: string;

  test.beforeAll(async () => {
    expect(
      Boolean(EMAIL && PASSWORD),
      'UAT_KWANT_EMAIL/UAT_KWANT_PASSWORD, or the QA_KWANT_* pair it falls back ' +
        'to, must be set (see .env.example). The UAT suite will not borrow the ' +
        'production KWANT_* pair.'
    ).toBe(true);

    context = await apiRequest.newContext();
    const login = await context.post(LOGIN_URL, {
      form: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status(), `UAT login failed — ${(await login.text()).slice(0, 200)}`).toBe(200);
    token = (await login.json()).token.token;
  });

  test.afterAll(async () => {
    await context.dispose();
  });

  for (const project of PROJECTS) {
    test(`${project.name} (${project.id})`, async ({ request }, testInfo) => {
      const headers = { 'x-auth-token': token, 'x-auth-project': project.id };

      const zone = await context.get(PROJECT_ZONE_URL, {
        headers: { ...headers, 'project-id': project.id },
      });
      const reportedZone = zone.ok() ? (await zone.json()).zone : FALLBACK_ZONE;
      const timeZone = !ZONE_OVERRIDE || ZONE_OVERRIDE === 'auto' ? reportedZone : ZONE_OVERRIDE;
      testInfo.annotations.push({
        type: 'timeZone',
        description: `${timeZone} (project-zone said ${reportedZone}, HTTP ${zone.status()})`,
      });
      testInfo.annotations.push({ type: 'floorId', description: String(project.floorId) });

      const { startDateTime, endDateTime } = lastDaysWindow(timeZone);
      expect(startDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
      expect(endDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);

      const startedAt = Date.now();
      const response = await request.post(FLOOR_DETAIL_URL, {
        params: { startDateTime, endDateTime },
        headers,
        data: {
          searchCriteriaList: [],
          floorId: project.floorId,
        },
      });

      const status = response.status();
      const body = await response.text();

      recordApiCall({
        endpoint: 'uat floorDetail',
        project: project.name,
        projectId: project.id,
        floorId: project.floorId,
        variant: `${WINDOW_DAYS} days, ${WINDOW_MODE}`,
        method: 'POST',
        url: response.url(),
        status,
        ms: Date.now() - startedAt,
        body,
      });

      console.log(
        `UAT ${project.name} [${timeZone}] floor ${project.floorId} ` +
          `${startDateTime} -> ${endDateTime} ` +
          `(${WINDOW_DAYS}d ${WINDOW_MODE}) : HTTP ${status}, ${body.length} bytes\n` +
          `${response.url()}\n${pretty(body)}`
      );
      await testInfo.attach(`UAT ${project.name} floor ${project.floorId} - HTTP ${status}`, {
        body,
        contentType: 'application/json',
      });

      const failureContext =
        `UAT ${project.name} returned HTTP ${status}\n${response.url()}\n` +
        `floorId ${project.floorId}, window ${startDateTime} -> ${endDateTime} ` +
        `(${WINDOW_DAYS} days, ${WINDOW_MODE}, ${timeZone})\n${body.slice(0, 500)}`;

      expect([200, 201], failureContext).toContain(status);

      // Shape only — the counts move between runs.
      const keys = JSON.parse(body).map((module: { key: string }) => module.key);
      expect(keys, failureContext).toEqual(expect.arrayContaining(MODULE_KEYS));
    });
  }
});
