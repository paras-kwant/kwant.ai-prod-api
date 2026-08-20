# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Playwright **API** test suite (no browser, no UI) exercising the live production
Kwant API at `https://app.kwant.ai/api`, plus two endpoints on QA at
`https://qa.kwant.ai/api` (see [QA environment](#qa-environment)). There is no application
code here — only specs that hit those environments directly. Treat every run as traffic
against a live system.

## Commands

```bash
npm run qa                                   # QA specs only — what CI runs
npm run qa:pipeline                          # QA specs + build site/qa/ exactly as qa.yml does
npm run qa:dashboard                         # the above, then serve it at localhost:8899/qa/
npm run prod                                 # production specs only (live production traffic)
```

Or invoke Playwright directly:

```bash
npx playwright test                          # everything, QA and production
npx playwright test --grep @qa               # QA only (the tag CI selects on)
npx playwright test --grep-invert @qa        # production only
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

## QA environment

`https://qa.kwant.ai/api`, same API shape. **QA has its own credentials**:
`QA_KWANT_EMAIL`/`QA_KWANT_PASSWORD`, required, with **no fallback** to the production
`KWANT_*` pair — unset, the specs fail on a named assertion in `beforeAll` rather than
logging in with production credentials. `qa.yml` reinforces that by not passing the
`KWANT_*` secrets to the job at all.

The two accounts are **not interchangeable**, and the failure is confusing: the production
`support@ontargetcloud.com` logs into QA with HTTP 200 but is not authorized for the project
below, so every call then returns `400 "User is not authorized to this resource"` — a login
that works followed by uniform 400s means the wrong account, not a broken token. Use an
account that can open the plan in the QA UI (`paras@kwant.ai` can).

Two endpoints are covered, in their own specs because almost nothing carries over from the
production ones:

| Spec | Endpoint |
| --- | --- |
| [tests/qaFloorDetail.spec.ts](tests/qaFloorDetail.spec.ts) | `POST /api/floorDetail`, 15-day window |
| [tests/qaWorkersOnPlan.spec.ts](tests/qaWorkersOnPlan.spec.ts) | `GET /api/locationplan/workersOnPlan` |

- **Take the ids from the UI URL**, not from `GET /api/projects`:
  `https://qa.kwant.ai/projects/7801174067/location/plan/7819255146` → project `7801174067`
  ("Frontier Data Center Project", the same id it has in production — QA clones them), plan
  `7819255146`. Overridable via `QA_PROJECT_ID` / `QA_PLAN_ID`, which must move together.
- **`GET /api/projects` is a trap here.** It lists 20 projects, but that is not an access
  list, the ids in it are unrelated 6–9 digit internal ids, and *none of them is the project
  the UI shows*. Sweeping `workersOnPlan?planId=7819255146` across that list produced a
  false positive — `110254569` answered 200 with `totalFloor: 30` and all-zero counts, which
  looks like a match and is not one. The real project returns `worker_detail: 8562`.
- `GET /api/plan/mostActiveToday` **does** resolve to `7819255146` under this project, so the
  pin is a choice, not a workaround: the spec asserts a specific plan rather than whatever is
  busiest today.
- **`project-zone` returns `America/Chicago`** here, which is already the anchoring of the
  captured URLs (`05:00Z -> 04:59Z`) — so `QA_TIME_ZONE` is left unset and the zone is
  fetched. An IANA name in it forces a different zone; `FALLBACK_ZONE` covers only a failed
  lookup. (An earlier note claimed `UTC`; that was the false-positive project.)
- `QA_WINDOW_DAYS` (default **14**) sets the width; `QA_WINDOW_MODE` sets the anchoring.
  14 is not a typo: the application's "last 15 days" filter sends a 14-day span. Captured
  from the browser on 2026-08-20 (Chicago), the app requests
  `startDateTime=2026-08-07T05:00:00Z&endDateTime=2026-08-21T04:59:00Z` — Aug 7 00:00
  through Aug 20 23:59 local. The label counts boundaries, not days; the spec matches the
  wire, not the label.
  - `calendarDay` (default) — whole local days in the project's zone,
    `midnight (today-13) -> 23:59 today` at 14 days. The **only** mode that can produce the
    `05:00Z -> 04:59Z` boundaries the app sends, since those are local midnights. Its end is
    the last minute of *today*, so it runs a few hours past the present instant. This mode
    at 14 days is byte-identical to the app's own request.
  - `rolling` — `now-14d -> now`, floored to the minute. Timezone-independent: "now" is one
    instant everywhere, so `project-zone` does not affect the request at all in this mode.
    It never reproduces the app's URLs, since those are midnight-anchored.
- floorDetail returns the five `location_floor_details` module rows
  (`worker_detail`, `company_detail`, `sensor_detail`, `zone_detail`, `gateway_detail`).
  Both specs assert the shape, not the counts — the counts move. A 15-day window answers in
  ~7s, unlike the `getPins` limit noted below.
- Both specs are tagged **`@qa`** on their `describe`, which is how CI selects them:
  `qa.yml` runs `--grep @qa`, `playwright.yml` runs `--grep-invert @qa`. Tagging beats
  filtering on file names, which would need a case-sensitive match against
  `qaFloorDetail.spec.ts` vs `floorDetail.spec.ts`.
- The QA suite is the one **on a cadence** — see [CI](#ci). Slack and the dashboard label
  these tests from the file name (`qaFloorDetail`, `qaWorkersOnPlan`) and from
  `recordApiCall`'s `endpoint` (`qa floorDetail`, `qa workersOnPlan`).

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

**QA is what runs on a schedule; production is on-demand only.**

| Workflow | Runs | Triggers | Publishes |
| --- | --- | --- | --- |
| [qa.yml](.github/workflows/qa.yml) | `--grep @qa` (QA specs) | push, PR, dispatch — plus every **15 min** via [qa-ticker.yml](.github/workflows/qa-ticker.yml) | `/qa/` (live) + `/prod/` (frozen) + the root index |
| [playwright.yml](.github/workflows/playwright.yml) | `--grep-invert @qa` (production specs) | `workflow_dispatch` only | nothing — report as an artifact |

`qa.yml` is a copy of `playwright.yml` with the QA env, the tag filter and the `/qa`
subpath swapped in. Roughly **96 QA runs a day**, so `MAX_RUNS` at 200 covers about 50
hours; raise it (and `CHART_RUNS`/`TABLE_ROWS`) if you want more.

`qa.yml` uses `concurrency: qa-playwright-<ref>`, and serialising is load-bearing: each run
builds `history.json` by merging itself into the copy fetched from `/qa/history.json`, so
two concurrent runs would each write back only their own. A run must finish inside the
15-minute window; it takes about one.

**Production no longer publishes to Pages.** A Pages deploy replaces the *entire* site, so a
manual production dispatch would delete the `/qa/` archive. It uploads `playwright-report/`
as an artifact instead, and holds its own concurrency group.

Its dashboard and last report stay at **`/prod/`** (with `/prod/report/`), republished by
[preserve-prod-archive.mjs](.github/scripts/preserve-prod-archive.mjs) on **every** QA build —
again because a deploy replaces the whole site, so once is not enough. Both files are
vendored in [.github/dashboard/prod-report/](.github/dashboard/prod-report/): the archive
stopped changing when monitoring was retired, and re-fetching it from the live site would
mean one failed request erases 85 runs for good (the deploy ships without them, the next
build finds nothing to copy). `frozen: true` in that history is what makes the page show a
frozen banner instead of an "Updated" line.

Tests run with `continue-on-error` and the job is **left green even when tests fail** —
this is a monitoring pipeline, not a gate. Pass/fail lives on the dashboard and in Slack.
No browser is installed — the `request` fixture never launches one.

The production cadence was retired, not paused: `ticker.yml` was **deleted** and
`playwright.yml` lost its `push`/`pull_request` triggers, so merging cannot fire traffic at
production either. To bring it back, restore the file
(`git show <commit>:.github/workflows/ticker.yml`) — or point a second ticker at
`playwright.yml`, giving it its own `concurrency` group.

### Why the 15-minute cadence is not a cron

`playwright.yml` carried `schedule: '*/15 * * * *'` and GitHub **dropped** most of it:
over a measured 1h54m window, 8 expected runs produced 1, itself ~10 min late. GitHub's
`schedule` is best-effort and the lowest-priority event; high-frequency crons are discarded
rather than queued. This is not fixable from the workflow file.

[.github/workflows/qa-ticker.yml](.github/workflows/qa-ticker.yml) drives the cadence
instead. It holds a runner for ~55 minutes, sleeping to each `:00/:15/:30/:45`
boundary and firing `gh workflow run qa.yml`, then re-dispatches **itself**. The chain, not a
cron, is what keeps the interval. Notes for anyone changing it:

- `workflow_dispatch` and `repository_dispatch` are the only two events `GITHUB_TOKEN` may
  trigger from inside a run, so no PAT is needed. Any other event would need one.
- Its `cron: '0 * * * *'` is a **recovery net** for a chain broken by a dead runner, not the
  schedule. Don't read it as the real cadence.
- `concurrency: qa-ticker` is load-bearing. GitHub keeps at most one *pending* run per group
  and cancels the rest, which is what stops the cron net and the self-rearm from compounding
  into overlapping tickers that double-fire the suite.
- Sleeping to the next boundary rather than a flat `sleep 900` keeps runs pinned to the
  clock across re-arms, instead of drifting by each run's start offset. `INTERVAL` is the
  one knob; keep it a divisor of 3600 or the boundaries wander from hour to hour.
- The ticker needs no checkout, so `gh` cannot infer the repo from a git remote — hence
  `GH_REPO`.

[.github/scripts/slack-notify.mjs](.github/scripts/slack-notify.mjs) reads
`test-results/results.json` and posts failures grouped by endpoint, each with project name,
project id, status code and the full request URL. It exits silently when everything passes.
Project ids reach Slack through the **test titles** — `` test(`${project.name} (${project.id})`) `` —
so keep that shape when adding specs.

Required secrets: `QA_KWANT_EMAIL`, `QA_KWANT_PASSWORD` (the scheduled QA suite) and
`SLACK_WEBHOOK_URL`; `KWANT_EMAIL`, `KWANT_PASSWORD` for the on-demand production suite.
The two pairs are never both handed to the same job. Optional repo variables: `BASE_URL`,
`QA_BASE_URL`, `QA_TIME_ZONE`, `REPORT_URL` (adds an "Open report" button).

Passing `--reporter=list` on the CLI overrides the configured reporters and skips writing
`results.json`, which the Slack script needs.

## History dashboard

Two dashboards share one Pages site:

| Path | Contents |
| --- | --- |
| `/` | index listing both, from [dashboard/root.html](.github/dashboard/root.html) |
| `/qa/` + `/qa/report/` | QA, live, refreshed every 15 minutes |
| `/prod/` + `/prod/report/` | production, frozen at its last run (2026-08-14, 85 runs) |

Each page header links to the other and to its own Playwright report. Slack links to `/qa/`.

The `/qa` subpath needs no code in the build script: `SITE_DIR=site/qa` sets where it writes
and `PAGES_URL=<root>/qa` sets which archive it merges into, both already env-driven. The
page fetches `./history.json` and links `./report/` relatively, so it works at any mount
point. `npm run qa:pipeline` builds the identical tree locally.

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
