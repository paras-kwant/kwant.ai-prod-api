import { test, expect, request as apiRequest, APIRequestContext } from '@playwright/test';
import { recordApiCall } from './apiLog';

// The QA spec pointed at https://uat.kwant.ai. UAT is a clone of the same
// environment, so the project and plan ids are identical to the QA ones
// (confirmed against the live API: projects/7801174067 resolves to "Frontier
// Data Center Project", and plan/mostActiveToday returns 7819255146). Only BASE
// and the credentials differ, which is why this is a copy rather than a flag.

const BASE = (process.env.UAT_BASE_URL ?? 'https://uat.kwant.ai').replace(/\/+$/, '');
const LOGIN_URL = `${BASE}/api/login`;
const WORKERS_ON_PLAN_URL = `${BASE}/api/locationplan/workersOnPlan`;

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
    planId: Number(process.env.UAT_PLAN_ID || 7819255146),
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

// @uat is what CI selects on: the monitoring workflow (.github/workflows/qa.yml)
// runs one step per tag, and playwright.yml inverts @qa|@uat to leave only
// the production specs.
test.describe('uatWorkersOnPlan', { tag: '@uat' }, () => {
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
      testInfo.annotations.push({ type: 'floorId', description: String(project.planId) });

      const startedAt = Date.now();
      const response = await request.get(WORKERS_ON_PLAN_URL, {
        params: { planId: project.planId },
        headers,
      });

      const status = response.status();
      const body = await response.text();

      recordApiCall({
        endpoint: 'uat workersOnPlan',
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
        `UAT ${project.name} plan ${project.planId} : HTTP ${status}, ` +
          `${body.length} bytes\n${response.url()}\n${pretty(body)}`
      );
      await testInfo.attach(`UAT ${project.name} plan ${project.planId} - HTTP ${status}`, {
        body,
        contentType: 'application/json',
      });

      const failureContext =
        `UAT ${project.name} returned HTTP ${status}\n${response.url()}\n` +
        `planId ${project.planId}\n${body.slice(0, 500)}`;

      expect([200, 201], failureContext).toContain(status);

      // Shape only — the counts move between runs.
      const payload = JSON.parse(body);
      expect(Object.keys(payload), failureContext).toEqual(expect.arrayContaining(EXPECTED_FIELDS));
    });
  }
});
