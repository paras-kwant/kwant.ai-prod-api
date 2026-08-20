import { test, expect, request as apiRequest, APIRequestContext } from '@playwright/test';
import { recordApiCall } from './apiLog';

const BASE = (process.env.QA_BASE_URL ?? 'https://qa.kwant.ai').replace(/\/+$/, '');
const LOGIN_URL = `${BASE}/api/login`;
const WORKERS_ON_PLAN_URL = `${BASE}/api/locationplan/workersOnPlan`;

// No fallback to KWANT_*: QA must fail rather than log in with production creds.
const EMAIL = process.env.QA_KWANT_EMAIL!;
const PASSWORD = process.env.QA_KWANT_PASSWORD!;

// From the QA UI URL /projects/7801174067/location/plan/7819255146. The pair
// travels together — a plan under another project returns 400.
const PROJECTS = [
  {
    name: process.env.QA_PROJECT_NAME || 'Frontier Data Center Project',
    id: process.env.QA_PROJECT_ID || '7801174067',
    planId: Number(process.env.QA_PLAN_ID || 7819255146),
  },
];

// No date window on this endpoint — it reports current occupancy.
const EXPECTED_FIELDS = ['totalWorkerPresentOnPlan', 'totalFloor', 'top3Workers'];

// Untruncated: these bodies are under a kilobyte, unlike getPins.
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// @qa is what CI selects on: qa.yml greps it, playwright.yml inverts it.
test.describe('qaWorkersOnPlan', { tag: '@qa' }, () => {
  let context: APIRequestContext;
  let token: string;

  test.beforeAll(async () => {
    expect(
      Boolean(EMAIL && PASSWORD),
      'QA_KWANT_EMAIL and QA_KWANT_PASSWORD must be set (see .env.example). ' +
        'The QA suite uses its own credentials — it will not borrow the KWANT_* pair.'
    ).toBe(true);

    context = await apiRequest.newContext();
    const login = await context.post(LOGIN_URL, {
      form: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status(), `QA login failed — ${(await login.text()).slice(0, 200)}`).toBe(200);
    token = (await login.json()).token.token;
  });

  test.afterAll(async () => {
    await context.dispose();
  });

  for (const project of PROJECTS) {
    test(`${project.name} (${project.id})`, async ({ request }, testInfo) => {
      const headers = { 'x-auth-token': token, 'x-auth-project': project.id };
      testInfo.annotations.push({ type: 'floorId', description: String(project.planId) });

      const startedAt = Date.now();
      const response = await request.get(WORKERS_ON_PLAN_URL, {
        params: { planId: project.planId },
        headers,
      });

      const status = response.status();
      const body = await response.text();

      recordApiCall({
        endpoint: 'qa workersOnPlan',
        project: project.name,
        projectId: project.id,
        floorId: project.planId,
        method: 'GET',
        url: response.url(),
        status,
        ms: Date.now() - startedAt,
        body,
      });

      console.log(
        `QA ${project.name} plan ${project.planId} : HTTP ${status}, ` +
          `${body.length} bytes\n${response.url()}\n${pretty(body)}`
      );
      await testInfo.attach(`QA ${project.name} plan ${project.planId} - HTTP ${status}`, {
        body,
        contentType: 'application/json',
      });

      const failureContext =
        `QA ${project.name} returned HTTP ${status}\n${response.url()}\n` +
        `planId ${project.planId}\n${body.slice(0, 500)}`;

      expect([200, 201], failureContext).toContain(status);

      // Shape only — the counts move between runs.
      const payload = JSON.parse(body);
      expect(Object.keys(payload), failureContext).toEqual(expect.arrayContaining(EXPECTED_FIELDS));
    });
  }
});
