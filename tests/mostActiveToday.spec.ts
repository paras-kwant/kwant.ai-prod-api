import { test, expect, request as apiRequest } from '@playwright/test';
import { recordApiCall } from './apiLog';

const LOGIN_URL = 'https://app.kwant.ai/api/login';
const MOST_ACTIVE_TODAY_URL = 'https://app.kwant.ai/api/plan/mostActiveToday';

const EMAIL = process.env.KWANT_EMAIL!;
const PASSWORD = process.env.KWANT_PASSWORD!;

const PROJECTS = [
  { name: 'Frontier Data Center Project', id: '7801174067' },
  { name: 'RSW Terminal E', id: '7005132808' },
  { name: 'LVL12 Data Center', id: '6964687287' },
];

test('login', async ({ request }) => {
  const response = await request.post(LOGIN_URL, {
    form: {
      email: EMAIL,
      password: PASSWORD,
    },
  });

  expect(response.status()).toBe(200);

  const body = await response.json();

  expect(body.returnVal).toBe('SUCCESS');
  expect(body.returnMessage).toContain(EMAIL);
  expect(body.errors).toBeNull();

  expect(body.token).toBeTruthy();
  expect(body.token.token).toMatch(/^[^:]+:\d+:[a-f0-9]+$/);
  expect(body.token.expires).toBeGreaterThan(Date.now());
});

test.describe('mostActiveToday', () => {
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
      const startedAt = Date.now();
      const response = await request.get(MOST_ACTIVE_TODAY_URL, {
        headers: {
          'x-auth-token': token,
          'x-auth-project': project.id,
        },
      });

      const status = response.status();
      const body = await response.text();

      // The plan id every other spec builds its request from. Parsed defensively:
      // a failing response body is not necessarily JSON.
      let floorId = '';
      try {
        floorId = String(JSON.parse(body).id ?? '');
      } catch {
        // Left blank — the status assertion below reports the real problem.
      }
      if (floorId) {
        testInfo.annotations.push({ type: 'floorId', description: floorId });
      }

      recordApiCall({
        endpoint: 'mostActiveToday',
        project: project.name,
        projectId: project.id,
        floorId,
        method: 'GET',
        url: response.url(),
        status,
        ms: Date.now() - startedAt,
        body,
      });

      console.log(
        `${project.name} (${project.id}) floor ${floorId || 'unresolved'} -> HTTP ${status}`
      );
      await testInfo.attach(`${project.name} floor ${floorId || 'unresolved'} - HTTP ${status}`, {
        body,
        contentType: 'application/json',
      });

      expect(
        [200, 201],
        `${project.name} (${project.id}) returned HTTP ${status}\n${response.url()}\n` +
          `floorId ${floorId || 'unresolved'}\n${body.slice(0, 500)}`
      ).toContain(status);
    });
  }
});
