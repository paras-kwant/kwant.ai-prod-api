import { test, expect, request as apiRequest, APIRequestContext } from '@playwright/test';
import { recordApiCall } from './apiLog';

const LOGIN_URL = 'https://app.kwant.ai/api/login';
const FLOOR_SUB_DETAIL_URL = 'https://app.kwant.ai/api/floorSubDetail';
const MOST_ACTIVE_TODAY_URL = 'https://app.kwant.ai/api/plan/mostActiveToday';
const PROJECT_ZONE_URL = 'https://app.kwant.ai/api/project-zone';

const EMAIL = process.env.KWANT_EMAIL!;
const PASSWORD = process.env.KWANT_PASSWORD!;

const PROJECTS = [
  { name: 'Frontier Data Center Project', id: '7801174067' },
  { name: 'RSW Terminal E', id: '7005132808' },
  { name: 'LVL12 Data Center', id: '6964687287' },
];

const FLOOR_SUB_TYPES = [
  'WORKERDETAIL',
  'COMPANYDETAIL',
  'ZONEDETAIL',
  'SENSORDETAIL',
  'GATEWAYDETAIL',
];

const WINDOW_MODE: 'rolling' | 'localDay' = 'rolling';
const WINDOW_MINUTES = 10;

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

function windowFor(timeZone: string): { startDateTime: string; endDateTime: string } {
  const end = new Date();
  const start =
    WINDOW_MODE === 'localDay'
      ? startOfLocalDay(end, timeZone)
      : new Date(end.getTime() - WINDOW_MINUTES * 60 * 1000);
  return { startDateTime: isoMinuteUtc(start), endDateTime: isoMinuteUtc(end) };
}

test.describe('floorSubDetail', () => {
  let context: APIRequestContext;
  let token: string;

  test.beforeAll(async () => {
    context = await apiRequest.newContext();
    const login = await context.post(LOGIN_URL, {
      form: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
    token = (await login.json()).token.token;
  });

  test.afterAll(async () => {
    await context.dispose();
  });

  for (const project of PROJECTS) {
    test.describe(`${project.name} (${project.id})`, () => {
      let floorId: number;
      let timeZone: string;

      test.beforeAll(async () => {
        const headers = { 'x-auth-token': token, 'x-auth-project': project.id };

        const zone = await context.get(PROJECT_ZONE_URL, {
          headers: { ...headers, 'project-id': project.id },
        });
        expect(
          zone.status(),
          `${project.name}: project-zone failed — ${(await zone.text()).slice(0, 200)}`
        ).toBe(200);
        timeZone = (await zone.json()).zone;

        const plan = await context.get(MOST_ACTIVE_TODAY_URL, { headers });
        expect(
          plan.status(),
          `${project.name}: no active plan — ${(await plan.text()).slice(0, 200)}`
        ).toBe(200);
        floorId = (await plan.json()).id;
      });

      for (const floorSubType of FLOOR_SUB_TYPES) {
        test(floorSubType, async ({ request }, testInfo) => {
          const { startDateTime, endDateTime } = windowFor(timeZone);

          expect(startDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
          expect(endDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);

          const startedAt = Date.now();
          const response = await request.post(FLOOR_SUB_DETAIL_URL, {
            params: { startDateTime, endDateTime },
            headers: {
              'x-auth-token': token,
              'x-auth-project': project.id,
            },
            data: {
              searchCriteriaList: [],
              floorId,
              floorSubType,
            },
          });

          const status = response.status();
          const body = await response.text();

          recordApiCall({
            endpoint: 'floorSubDetail',
            project: project.name,
            projectId: project.id,
            variant: floorSubType,
            method: 'POST',
            url: response.url(),
            status,
            ms: Date.now() - startedAt,
            body,
          });

          console.log(
            `${project.name} [${timeZone}] floor ${floorId} ${floorSubType} ` +
              `${startDateTime} -> ${endDateTime} : HTTP ${status}`
          );
          await testInfo.attach(`${project.name} ${floorSubType} - HTTP ${status}`, {
            body,
            contentType: 'application/json',
          });

          expect(
            [200, 201],
            `${project.name} / ${floorSubType} returned HTTP ${status}\n${response.url()}\n` +
              `floorId ${floorId}, window ${startDateTime} -> ${endDateTime} ` +
              `(${WINDOW_MODE}, ${timeZone})\n${body.slice(0, 500)}`
          ).toContain(status);
        });
      }
    });
  }
});
