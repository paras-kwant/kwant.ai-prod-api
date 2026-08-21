# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Playwright **API** test suite (no browser, no UI) exercising the live production
Kwant API at `https://app.kwant.ai/api`, plus the same two endpoints on QA at
`https://qa.kwant.ai/api` and on UAT at `https://uat.kwant.ai/api` (see
[QA environment](#qa-environment) and [UAT environment](#uat-environment)). There is no
application code here — only specs that hit those environments directly. Treat every run
as traffic against a live system.

## Commands

```bash
npm run qa                                   # QA specs only
npm run uat                                  # UAT specs only
npm run pipeline                             # both suites + the whole site/, as qa.yml does
npm run dashboard                            # the above, then serve it at localhost:8899/
npm run qa:pipeline                          # one environment: its specs + its site/qa/ subtree
npm run uat:pipeline                         # likewise, site/uat/
npm run qa:dashboard                         # qa:pipeline, then serve at localhost:8899/qa/
npm run uat:dashboard                        # uat:pipeline, then serve at localhost:8899/uat/
npm run prod                                 # production specs only (live production traffic)
```

The `*:pipeline` scripts are `SUITE=<env> npm run suite:pipeline` — see
[Running two suites in one job](#running-two-suites-in-one-job-suite).

Or invoke Playwright directly:

```bash
npx playwright test                          # everything: production, QA and UAT
npx playwright test --grep @qa               # QA only (the tag CI selects on)
npx playwright test --grep @uat              # UAT only
npx playwright test --grep-invert '@qa|@uat' # production only
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

The monitored environments use the `QA_KWANT_*` pair — UAT falls back to it, and
`UAT_KWANT_*` overrides only if you want a different account. Neither ever falls back to
the production `KWANT_*` pair. See their sections below.

CI has no `.env`; it reads every pair from repository secrets, and hands each one only to
the step that needs it.

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

## Running two suites in one job (`SUITE`)

QA and UAT run in the same CI job, one `npx playwright test` each. `SUITE` (`qa` | `uat`)
is what keeps them apart, and it is read in four places —
[playwright.config.ts](playwright.config.ts) (`results.json`, the HTML report,
`outputDir`), [tests/apiLog.ts](tests/apiLog.ts) (the
NDJSON log), [build-dashboard.mjs](.github/scripts/build-dashboard.mjs) (all three inputs
plus `site/<suite>/`) and [slack-notify.mjs](.github/scripts/slack-notify.mjs) (which
results to read, and the environment name in the message):

| `SUITE` | results | HTML report | API log | published to |
| --- | --- | --- | --- | --- |
| unset | `test-results/results.json` | `playwright-report/` | `test-results/api-calls.ndjson` | `site/` |
| `qa` | `results/qa/results.json` | `results/qa/report/` | `results/qa/api-calls.ndjson` | `site/qa/` |
| `uat` | `results/uat/results.json` | `results/uat/report/` | `results/uat/api-calls.ndjson` | `site/uat/` |

Unset — a bare `npx playwright test`, or `npm run prod` — keeps the original paths, so
nothing about the production suite changed.

Partitioning is not cosmetic: Playwright **wipes its output dir at the start of a run**, so
with both suites writing to `test-results/` the UAT run would delete the QA results before
the QA dashboard was built. Anything added that writes under `test-results/` has to take
`SUITE` into account too.

`build-dashboard.mjs` also copies the run's HTML report to `<site>/report/`, so CI and
`npm run <env>:pipeline` produce byte-identical trees from the same code.

[tests/globalSetup.ts](tests/globalSetup.ts) deletes the API call log once per run, before
any worker starts. `recordApiCall` appends, and the log now sits *beside* the wiped output
dir rather than inside it, so without this a second local run leaves the first run's calls
in the file and the dashboard credits them all to the latest run. It must stay in
`globalSetup` rather than `apiLog.ts`, which is imported once per worker — each worker would
truncate the others' entries. CI never sees the difference (fresh checkout), which is the
reason to keep it: a local build has to produce the dashboard CI produces.

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
  `qa.yml` runs `--grep @qa` in its QA step, and `playwright.yml` runs
  `--grep-invert '@qa|@uat'` to leave only the production specs. Tagging beats filtering on
  file names, which would need a case-sensitive match against `qaFloorDetail.spec.ts` vs
  `floorDetail.spec.ts`.
- The QA suite is **on a nightly cadence**, alongside UAT — see [CI](#ci). Slack and the
  dashboard label these tests from the file name (`qaFloorDetail`, `qaWorkersOnPlan`) and
  from `recordApiCall`'s `endpoint` (`qa floorDetail`, `qa workersOnPlan`).

## UAT environment

`https://uat.kwant.ai/api`. A clone of the same environment QA runs against, so
**everything but the host and the credentials is identical**: project `7801174067`
("Frontier Data Center Project"), plan `7819255146`, `project-zone` →
`America/Chicago`, and `GET /api/plan/mostActiveToday` resolves to that same plan. All
verified against the live API, not assumed from QA.

| Spec | Endpoint |
| --- | --- |
| [tests/uatFloorDetail.spec.ts](tests/uatFloorDetail.spec.ts) | `POST /api/floorDetail`, 14-day window |
| [tests/uatWorkersOnPlan.spec.ts](tests/uatWorkersOnPlan.spec.ts) | `GET /api/locationplan/workersOnPlan` |

Each is its QA counterpart with `QA_` swapped for `UAT_` and the base URL changed — same
window modes, same `calendarDay` default, same shape-only assertions. The 14-day
`calendarDay` window it sends is byte-identical to QA's
(`2026-08-08T05:00:00Z -> 2026-08-22T04:59:00Z` on 2026-08-21), because the zone matches.
Read the [QA environment](#qa-environment) notes for the reasoning behind all of it; only
the differences are listed here:

- **It shares QA's credentials.** `UAT_KWANT_EMAIL`/`UAT_KWANT_PASSWORD` override, but
  unset the specs use the `QA_KWANT_*` pair — the QA account (`paras@kwant.ai`) is
  authorised for this project on both environments, verified against the live API. So UAT
  needs **no repository secrets of its own**; `qa.yml` passes
  `secrets.UAT_KWANT_EMAIL || secrets.QA_KWANT_EMAIL` to its UAT step.
  There is still **no fallback to `KWANT_*`** — a monitoring suite must fail rather than
  log in with production credentials. If UAT is ever pointed at an account that is not
  authorised for the project, the failure looks like QA's: HTTP 200 on login, then
  `400 "User is not authorized to this resource"` on every call.
- Overridable via `UAT_BASE_URL`, `UAT_PROJECT_ID`/`UAT_PLAN_ID` (which must move
  together), `UAT_WINDOW_DAYS`, `UAT_WINDOW_MODE`, `UAT_TIME_ZONE`.
- Tagged **`@uat`**, which is how CI selects it. Adding another tag means updating
  `playwright.yml`'s `--grep-invert '@qa|@uat'` as well, or a production dispatch will
  start firing at the new environment.
- Slack and the dashboard label these from the file name (`uatFloorDetail`,
  `uatWorkersOnPlan`) and from `recordApiCall`'s `endpoint` (`uat floorDetail`,
  `uat workersOnPlan`). The Slack header reads `Kwant API (UAT)`, from `SUITE`.

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

The `uat*` specs are whole-file copies of the `qa*` ones for the same reason — the repo's
convention is one self-contained spec per endpoint per environment. That makes four copies
of the date helpers now, so the cleanup is worth more than it was; a change to the QA
window logic almost certainly belongs in the UAT spec too.

## CI

**QA and UAT are what run on a schedule; production is on-demand only.**

| Workflow | Runs | Triggers | Publishes |
| --- | --- | --- | --- |
| [qa.yml](.github/workflows/qa.yml) | `--grep @qa`, then `--grep @uat`, as two steps | `workflow_dispatch` only — every **15 min from 00:00 to 08:00 Asia/Kathmandu** via [qa-ticker.yml](.github/workflows/qa-ticker.yml) | `/qa/` + `/uat/` (live) + `/prod/` (frozen) + the root index |
| [playwright.yml](.github/workflows/playwright.yml) | `--grep-invert '@qa\|@uat'` (production specs) | `workflow_dispatch` only | nothing — report as an artifact |

**Both monitored environments live in one workflow, and that is load-bearing.** A Pages
deploy replaces the *entire* site, so whatever publishes must emit every live subtree in
the same deploy; as two workflows, each deploy would delete the other environment's
archive. The report tree cannot be recovered by fetching either, the way `history.json` is.
Hence also: there is no way to run one environment and not the other from CI, and adding a
third means another pair of steps in `qa.yml`, not another workflow.

The file is still named `qa.yml` because [qa-ticker.yml](.github/workflows/qa-ticker.yml)
dispatches it by name; renaming it means updating the ticker's `gh workflow run` too, and
costs one dropped tick while the in-flight ticker still points at the old name.

**32 runs a night** of each suite (00:00, 00:15 … 07:45 NPT), so `MAX_RUNS` at 200 covers
about six nights per environment and `DETAIL_RUNS` at 30 keeps roughly one night of full
response bodies; raise them (and `CHART_RUNS`/`TABLE_ROWS`) if you want more.

**Nothing runs outside the window.** `qa.yml` is `workflow_dispatch`-only — `push` and
`pull_request` were removed for the same reason `playwright.yml` dropped them: merging must
not fire traffic at a monitored environment. So a change to the specs, the dashboard or the
build scripts reaches the site only on the next nightly run; `gh workflow run qa.yml`
publishes it immediately.

`qa.yml` uses `concurrency: qa-playwright-<ref>`, and serialising is load-bearing: each run
builds `history.json` by merging itself into the copy fetched from `/qa/history.json` and
`/uat/history.json`, so two concurrent runs would each write back only their own. A run
must finish inside the 15-minute window; two suites take about two minutes.

A dashboard build **aborts** rather than overwrite an archive it could not read, and the
packaging and deploy steps carry no `if:`, so an abort publishes nothing at all — the live
site keeps both archives and the next run merges into them. Deploying a site missing `/qa/`
or `/uat/` would erase that environment's history for good, so never loosen that: the
artifact uploads are `!cancelled()`, the deploy is not.

**Production no longer publishes to Pages.** A Pages deploy replaces the *entire* site, so a
manual production dispatch would delete the `/qa/` and `/uat/` archives. It uploads
`playwright-report/` as an artifact instead, and holds its own concurrency group.

Its dashboard and last report stay at **`/prod/`** (with `/prod/report/`), republished by
[preserve-prod-archive.mjs](.github/scripts/preserve-prod-archive.mjs) on **every** QA build —
again because a deploy replaces the whole site, so once is not enough. Both files are
vendored in [.github/dashboard/prod-report/](.github/dashboard/prod-report/): the archive
stopped changing when monitoring was retired, and re-fetching it from the live site would
mean one failed request erases 85 runs for good (the deploy ships without them, the next
build finds nothing to copy). `frozen: true` in that history is what makes the page show a
frozen banner instead of an "Updated" line.

Both test steps run with `continue-on-error` and the job is **left green even when tests
fail** — this is a monitoring pipeline, not a gate. The UAT step also carries
`if: !cancelled()`, so a broken QA environment never stops UAT from being measured.
Pass/fail lives on the dashboard and in Slack. No browser is installed — the `request`
fixture never launches one.

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
cron, is what keeps the interval.

The **nightly window lives in the script, not the cron**: `WINDOW_TZ` (`Asia/Kathmandu`),
`WINDOW_START_HOUR` (0) and `WINDOW_END_HOUR` (8, exclusive — the last dispatch is 07:45)
are its only definition, so moving it needs no cron edit. GitHub's cron is UTC-only and
could not express `+5:45` anyway. That leaves the hourly cron doing two jobs: starting the
chain each night and restarting one a dead runner broke. Outside the window a tick exits in
seconds, so the 16 daytime ones cost almost nothing. Three properties are load-bearing, and
a simulated night against a virtual clock confirmed all of them (exactly 32 dispatches,
00:00 through 07:45, none outside, chain terminating):

- The start check looks **ahead**, not at "now": a run may begin before the window opens and
  sleep into it. That is what covers a zone whose offset is not a whole hour — at `+5:45`
  the 18:00 UTC tick starts at 23:45 NPT, and without the look-ahead the 00:00, 00:15 and
  00:30 dispatches would all be lost.
- Re-arming is **conditional** on a boundary in the next hour still being in-window.
  Unconditional re-arming would spin: outside the window each run exits in seconds and would
  immediately start another, all day.
- A failed `gh workflow run` is non-fatal (`|| echo "::warning::…"`), so one refused dispatch
  cannot end the night's chain — and the step deliberately does not use `set -e`, so the
  re-arm decision at the end is always reached.

Notes for anyone changing it:

- `workflow_dispatch` and `repository_dispatch` are the only two events `GITHUB_TOKEN` may
  trigger from inside a run, so no PAT is needed. Any other event would need one.
- Its `cron: '0 * * * *'` is the nightly **starter** and a recovery net for a chain broken by
  a dead runner — not the schedule. Don't read it as the real cadence. Its one gap: if the
  chain dies inside the final 15 minutes, the cron tick at 02:00 UTC (07:45 NPT) finds no
  remaining in-window boundary and that single dispatch is lost.
- `concurrency: qa-ticker` is load-bearing. GitHub keeps at most one *pending* run per group
  and cancels the rest, which is what stops the cron net and the self-rearm from compounding
  into overlapping tickers that double-fire the suite.
- Sleeping to the next boundary rather than a flat `sleep 900` keeps runs pinned to the
  clock across re-arms, instead of drifting by each run's start offset. `INTERVAL` is the
  one knob; keep it a divisor of 3600 or the boundaries wander from hour to hour.
- The ticker needs no checkout, so `gh` cannot infer the repo from a git remote — hence
  `GH_REPO`.

[.github/scripts/slack-notify.mjs](.github/scripts/slack-notify.mjs) reads
`results.json` (which one is set by `SUITE`) and posts failures grouped by endpoint, each
with project name, project id, status code and the full request URL. It exits silently when
everything passes. `qa.yml` invokes it **once per failing environment**, and `SUITE` puts
the name in the header (`Kwant API (UAT) — test failures`) — both suites post to the same
webhook, so without it two messages would be indistinguishable.
Project ids reach Slack through the **test titles** — `` test(`${project.name} (${project.id})`) `` —
so keep that shape when adding specs.

Required secrets: `QA_KWANT_EMAIL`/`QA_KWANT_PASSWORD` (which serve **both** scheduled
suites) plus `SLACK_WEBHOOK_URL`; `KWANT_EMAIL`/`KWANT_PASSWORD` for the on-demand
production suite. Optional: `UAT_KWANT_EMAIL`/`UAT_KWANT_PASSWORD`, only to point UAT at a
different account. The production pair is never handed to a monitoring step. Optional repo
variables: `BASE_URL`, `QA_BASE_URL`, `QA_TIME_ZONE`, `UAT_BASE_URL`, `UAT_TIME_ZONE`,
`REPORT_URL` (adds an "Open report" button).

Passing `--reporter=list` on the CLI overrides the configured reporters and skips writing
`results.json`, which the Slack script needs.

## History dashboard

Three dashboards share one Pages site:

| Path | Contents |
| --- | --- |
| `/` | index listing all three, from [dashboard/root.html](.github/dashboard/root.html) |
| `/qa/` + `/qa/report/` | QA, live, refreshed every 15 min, 00:00-08:00 NPT |
| `/uat/` + `/uat/report/` | UAT, live, same run and cadence as QA |
| `/prod/` + `/prod/report/` | production, frozen at its last run (2026-08-14, 85 runs) |

All three serve the **same** [dashboard/index.html](.github/dashboard/index.html). It knows
which one it is from `env` in `history.json` (`qa` | `uat` | `prod`), which is what labels
the header and builds the links to the other two — so the page stays copyable to a new
mount point without editing it. The frozen production archive predates that field, so the
page falls back to `frozen ? 'prod' : 'qa'`; `preserve-prod-archive.mjs` now stamps
`env: 'prod'` in as well. Slack links to the failing environment's own dashboard.

Neither subpath needs code in the build script: `SUITE` sets both where it writes
(`site/<suite>`) and, with `PAGES_URL=<root>/<suite>`, which archive it merges into. The
page fetches `./history.json` and links `./report/` relatively, so it works at any mount
point. `npm run pipeline` builds the identical tree locally.

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
