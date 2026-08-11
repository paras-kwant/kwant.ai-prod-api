# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Playwright **API** test suite (no browser, no UI) exercising the live production
Kwant API at `https://app.kwant.ai/api`. There is no application code here — only specs
that hit production directly. Treat every run as traffic against a live system.

## Commands

`package.json` has no scripts; invoke Playwright directly.

```bash
npx playwright test                          # whole suite
npx playwright test getPins                  # by filename substring
npx playwright test -g "RSW Terminal E"      # by test title
npx playwright test --reporter=list          # see per-test console.log output
npx playwright show-report                   # HTML report, incl. full response bodies
```

`--headed` and the `chromium`/`firefox`/`webkit` projects have no effect: these specs use
the `request` fixture, so no browser ever launches. Use `--ui` or `--trace on` to inspect
calls instead. Only the `chromium` project is enabled, so tests run once rather than 3×.

## Credentials

Read from `.env` (gitignored) via `dotenv` in [playwright.config.ts](playwright.config.ts):
`BASE_URL`, `KWANT_EMAIL`, `KWANT_PASSWORD`. Copy `.env.example` to start.
Specs read `process.env.KWANT_EMAIL!` directly and fail on a login assertion if unset.

CI has no `.env`; it reads `KWANT_EMAIL` / `KWANT_PASSWORD` from repository secrets.

## API contract

Learned by inspecting the frontend bundle (`https://app.kwant.ai/assets/index-*.js`) and
probing the live API — not from published docs. Re-derive the same way if something changes.

### Auth

`POST /api/login` takes **`application/x-www-form-urlencoded`** (`email`, `password`).
JSON returns 400 with an empty body. Success returns `token.token` as
`<sessionId>:<expiryMillis>:<signature>`, plus `token.expires`.

Authenticated calls need **two headers**, not `Authorization`:

- `x-auth-token: <token.token>`
- `x-auth-project: <projectId>`

`Authorization: Bearer` is ignored and yields 401. Bad credentials return **400**
(not 401) with `returnVal: "ERROR"`, `returnMessage: "Bad credentials"`.

### Project ids vs floor ids

These are easy to confuse — both are 10-digit numbers, and passing a floor id as
`x-auth-project` returns `400 "User is not authorized to this resource"`, which reads
like a permissions problem but is not.

| Project | id | Timezone |
| --- | --- | --- |
| Frontier Data Center Project | `7801174067` | `America/Chicago` |
| RSW Terminal E | `7005132808` | `America/New_York` |
| LVL12 Data Center | `6964687287` | `America/New_York` |

`GET /api/projects/{id}` resolves a name from an id — use it to check which kind you have.

`floorId` (a.k.a. plan id) comes from `GET /api/plan/mostActiveToday` → `.id`, scoped by
the `x-auth-project` header. The UI takes it from whichever plan is open; specs resolve it
per project. Every stats/pins endpoint needs it in the body.

### Timezones

`GET /api/project-zone` returns `{"zone":"America/Chicago"}`, with **both**
`project-id` and `x-auth-project` set to the project id. Projects carry no timezone or
usable `lat`/`lon` field otherwise, and `calibrateGeometry` holds image pixel coordinates,
not geography — so this endpoint is the only source. Prefer fetching it over hardcoding.

### Endpoints under test

All take `?startDateTime=<iso>&endDateTime=<iso>` and `POST` a JSON body.

| Endpoint | Body |
| --- | --- |
| `/api/plan/getPins` | `{floorId, selectWorker, selectEquipment, searchCriteriaList}` |
| `/api/floorDetail` | `{searchCriteriaList, floorId}` |
| `/api/floorSubDetail` | `{searchCriteriaList, floorId, floorSubType}` |

`floorSubType` ∈ `WORKERDETAIL`, `COMPANYDETAIL`, `ZONEDETAIL`, `SENSORDETAIL`,
`GATEWAYDETAIL`. `floorSubDetail` paginates (`content`, `totalPages`); `getPins` does not.

`GET /api/locationplan/workersOnPlan?planId=<floorId>` takes no body and no date window,
returning `{totalWorkerPresentOnPlan, totalFloor, top3Workers}`.

### Date format

`2026-08-11T10:26:00Z` — ISO-8601 **UTC**, floored to the minute, no milliseconds.
Plain `toISOString()` is wrong (emits `.000Z`). `%3A` in captured URLs is just an encoded
`:`; Playwright's `params` option encodes it.

Always build these with UTC methods (`setUTCSeconds`, `toISOString`). The local-time
equivalents (`setSeconds`, `getHours`, `toLocaleString`) emit a valid-looking string for
the wrong instant — a bug that stays invisible on a UTC CI runner but not on a developer
machine in another zone.

A *rolling* window ending "now" is timezone-independent, since "now" is one instant
everywhere. Per-project timezones only change the request for calendar-anchored windows
("today", "since midnight"), which is what `WINDOW_MODE: 'localDay'` and
`WINDOW_START: 'midnight'` select.

## Spec structure

One spec per endpoint. Each logs in once in `beforeAll`, then loops a `PROJECTS` array
generating one named test per project, so a failure names the project directly.

`request` is **test-scoped** and unavailable in `beforeAll`; specs call
`apiRequest.newContext()` by hand to log in once, then `dispose()` it.

Assertions pass a custom message as `expect`'s second argument, carrying project, status,
window and response body — the message renders only on failure. Full bodies go to the HTML
report via `testInfo.attach`; console output is truncated because a successful `getPins`
body is several MB.

## Known failures

Both are server-side. The signature is the same in each case: HTTP 504 after ~15–16s with
`upstream request timeout` (`text/plain`, 24 bytes) from Envoy. That is **not** a Playwright
timeout — no timeout is configured in this repo, and curl with a 120s allowance still gets
504 at 16.1s. Do not "fix" either by raising a timeout.

### workersOnPlan, Frontier only

`workersOnPlan.spec.ts` fails for **Frontier Data Center Project** and passes for the other
two (RSW ~1.8s, LVL12 ~7.6s). Reproduced 4/4 times via curl, so it is consistent rather than
flaky — something about that project's plan makes the count query hang. The spec keeps all
three projects in one file with the assertion left at 200.

### getPins over a wide window

No spec covers this — `getPinsLast15Days.spec.ts` was written and then removed — but the
limit is real and worth knowing before widening any window. `getPins` cannot serve a
15-day window; measured against Frontier on 2026-08-11:

```
 1 day  -> 200 in 13.8s (4.2 MB)     5 days -> 504 after 15.7s
 2 days -> 200 in  7.1s (2.4 MB)     7 days -> 504 after 15.8s
 3 days -> 200 in  7.6s (4.7 MB)    15 days -> 504 after 16.0s
```

It breaks between 3 and 5 days on every project. Keep windows at 3 days or under.

## Known duplication

`isoMinuteUtc`, `offsetMs`, `startOfLocalDay`, `windowFor` and the login block are copied
verbatim across the specs. Extracting `tests/helpers.ts` is a pending, behavior-neutral
cleanup; until then, a change to the date format must be applied in every spec.

## CI

[.github/workflows/playwright.yml](.github/workflows/playwright.yml) runs on push, PR,
manual dispatch, and a **10-minute schedule** (`*/10 * * * *`) — roughly 144 runs a day
against live production, so 200 runs of history covers about 33 hours. Tests run with `continue-on-error` and the job is **left green even when tests fail** —
this is a monitoring pipeline, not a gate. Pass/fail lives on the dashboard and in Slack.
`concurrency.cancel-in-progress` is `false`: a cancelled run publishes nothing, and
serialising keeps the history read-modify-write race-free. No browser is installed —
the `request` fixture never launches one.

[.github/scripts/slack-notify.mjs](.github/scripts/slack-notify.mjs) reads
`test-results/results.json` and posts failures grouped by endpoint, each with project name,
project id, status code and the full request URL. It exits silently when everything passes.
Project ids reach Slack through the **test titles** — `` test(`${project.name} (${project.id})`) `` —
so keep that shape when adding specs.

Required secrets: `KWANT_EMAIL`, `KWANT_PASSWORD`, `SLACK_WEBHOOK_URL`. Optional repo
variables: `BASE_URL`, `REPORT_URL` (adds an "Open report" button).

Passing `--reporter=list` on the CLI overrides the configured reporters and skips writing
`results.json`, which the Slack script needs.

## History dashboard

Published to `https://<owner>.github.io/<repo>/`, with the raw Playwright report under
`/report/`. Slack links to it.

[.github/scripts/build-dashboard.mjs](.github/scripts/build-dashboard.mjs) merges the
current run into `history.json` and keeps the last 200 (`MAX_RUNS`). **Previous history is fetched from
the live Pages URL** — there is no history branch. A 404 starts a fresh archive; any other
fetch error aborts the build rather than silently replacing 100 runs with one. Each run is
also uploaded as a `run-history` artifact so the archive is recoverable.

Response bodies come from [tests/apiLog.ts](tests/apiLog.ts): every spec calls
`recordApiCall(...)` after reading a response, appending NDJSON to
`test-results/api-calls.ndjson`. Bodies are truncated to 800 chars — a successful `getPins`
response is several MB.

Only the newest `DETAIL_RUNS` (30) keep every call; older runs keep just their failed
calls, and old green runs keep none. Counts always survive, so the chart and stats stay
accurate. That holds 200 runs at ~900 KB (~16 KB gzipped, which is what Pages serves).
Without it, 200 runs of full bodies would be ~9 MB.

The chart draws at most `CHART_RUNS` bars and the table `TABLE_ROWS` rows — past roughly
200 bars the strip turns into an unreadable block, so raising `MAX_RUNS` means raising
those caps deliberately, not automatically.

[.github/dashboard/index.html](.github/dashboard/index.html) is a static page that fetches
`history.json`; the build script only copies it. It needs a real HTTP server to test
locally (`file://` blocks the fetch):

```bash
node .github/scripts/build-dashboard.mjs && (cd site && python3 -m http.server 8899)
```
