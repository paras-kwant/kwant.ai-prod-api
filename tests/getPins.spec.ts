import { test, expect, request as apiRequest } from '@playwright/test';
import { recordApiCall } from './apiLog';

const LOGIN_URL = 'https://app.kwant.ai/api/login';
const GET_PINS_URL = 'https://app.kwant.ai/api/plan/getPins';
const MOST_ACTIVE_TODAY_URL = 'https://app.kwant.ai/api/plan/mostActiveToday';
const PROJECT_ZONE_URL = 'https://app.kwant.ai/api/project-zone';

const EMAIL = process.env.KWANT_EMAIL!;
const PASSWORD = process.env.KWANT_PASSWORD!;

const PROJECTS = [
  { name: 'Frontier Data Center Project', id: '7801174067' },
  { name: 'RSW Terminal E', id: '7005132808' },
  { name: 'LVL12 Data Center', id: '6964687287' },
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

  // Resolved twice so a DST transition between midnight and now can't skew it.
  let utc = local.getTime() - offsetMs(instant, timeZone);
  utc = local.getTime() - offsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

function windowFor(timeZone: string): { start: Date; end: Date } {
  const end = new Date();
  const start =
    WINDOW_MODE === 'localDay'
      ? startOfLocalDay(end, timeZone)
      : new Date(end.getTime() - WINDOW_MINUTES * 60 * 1000);
  return { start, end };
}

test.describe('getPins', () => {
  let token: string;

  test.beforeAll(async () => {
    const context = await apiRequest.newContext();
    const login = await context.post(LOGIN_URL, {
      form: {
        email: EMAIL,
        password: PASSWORD,
      },
    });
    expect(login.status()).toBe(200);
    token = (await login.json()).token.token;
    await context.dispose();
  });

  for (const project of PROJECTS) {
    test(`${project.name} (${project.id})`, async ({ request }, testInfo) => {
      const headers = {
        'x-auth-token': token,
        'x-auth-project': project.id,
      };

      const zone = await request.get(PROJECT_ZONE_URL, {
        headers: { ...headers, 'project-id': project.id },
      });
      expect(
        zone.status(),
        `${project.name}: project-zone failed — ${(await zone.text()).slice(0, 200)}`
      ).toBe(200);
      const timeZone = (await zone.json()).zone;

      const plan = await request.get(MOST_ACTIVE_TODAY_URL, { headers });
      expect(
        plan.status(),
        `${project.name}: could not resolve a plan — ${(await plan.text()).slice(0, 300)}`
      ).toBe(200);
      const floorId = (await plan.json()).id;
      testInfo.annotations.push({ type: 'floorId', description: String(floorId) });

      const { start, end } = windowFor(timeZone);
      const startDateTime = isoMinuteUtc(start);
      const endDateTime = isoMinuteUtc(end);

      expect(startDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
      expect(endDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
      expect(start.getTime()).toBeLessThan(end.getTime());

      const startedAt = Date.now();
      const response = await request.post(GET_PINS_URL, {
        params: { startDateTime, endDateTime },
        headers,
        data: {
          floorId,
          selectWorker: true,
          selectEquipment: false,
          searchCriteriaList: [],
        },
      });

      const status = response.status();
      const body = await response.text();

      recordApiCall({
        endpoint: 'getPins',
        project: project.name,
        projectId: project.id,
        floorId,
        method: 'POST',
        url: response.url(),
        status,
        ms: Date.now() - startedAt,
        body,
      });

      console.log(
        `${project.name} (${project.id}) [${timeZone}] floor ${floorId} ` +
          `${startDateTime} -> ${endDateTime} : HTTP ${status}`
      );
      await testInfo.attach(`${project.name} floor ${floorId} - HTTP ${status}`, {
        body,
        contentType: 'application/json',
      });

      expect(
        [200, 201],
        `${project.name} (${project.id}) returned HTTP ${status}\n${response.url()}\n` +
          `floorId ${floorId}, window ${startDateTime} -> ${endDateTime} ` +
          `(${WINDOW_MODE}, ${timeZone})\n` +
          body.slice(0, 500)
      ).toContain(status);
    });
  }
});
