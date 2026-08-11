import { test, expect, request as apiRequest, APIRequestContext } from '@playwright/test';

const LOGIN_URL = 'https://app.kwant.ai/api/login';
const WORKERS_ON_PLAN_URL = 'https://app.kwant.ai/api/locationplan/workersOnPlan';
const MOST_ACTIVE_TODAY_URL = 'https://app.kwant.ai/api/plan/mostActiveToday';

const EMAIL = process.env.KWANT_EMAIL!;
const PASSWORD = process.env.KWANT_PASSWORD!;

const PROJECTS = [
  { name: 'Frontier Data Center Project', id: '7801174067' },
  { name: 'RSW Terminal E', id: '7005132808' },
  { name: 'LVL12 Data Center', id: '6964687287' },
];

test.describe('workersOnPlan', () => {
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
    test(`${project.name} (${project.id})`, async ({ request }, testInfo) => {
      const headers = { 'x-auth-token': token, 'x-auth-project': project.id };

      const plan = await context.get(MOST_ACTIVE_TODAY_URL, { headers });
      expect(
        plan.status(),
        `${project.name}: no active plan — ${(await plan.text()).slice(0, 200)}`
      ).toBe(200);
      const planId = (await plan.json()).id;

      const response = await request.get(WORKERS_ON_PLAN_URL, {
        params: { planId },
        headers,
      });

      const status = response.status();
      const body = await response.text();

      console.log(
        `${project.name} plan ${planId} : HTTP ${status}, ${body.length} bytes — ${body.slice(0, 200)}`
      );
      await testInfo.attach(`${project.name} - HTTP ${status}`, {
        body,
        contentType: 'application/json',
      });

      expect(
        [200, 201],
        `${project.name} returned HTTP ${status}\n${response.url()}\nplanId ${planId}\n${body.slice(0, 500)}`
      ).toContain(status);
    });
  }
});
