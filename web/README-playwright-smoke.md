# Playwright home smoke

Read-only browser smoke tests for the Singgah Lokal Home page. They verify that
the target page loads without an HTTP 5xx or a visible error marker and that the
core content and (where rendered) the map area are present after load.

No data is changed, no account is created, no file is uploaded, and no admin
surface is touched.

## Prerequisites

Node 20+ and npm. Install the project dependencies first:

```bash
cd web
npm install
```

Then install the browsers once per machine/environment:

```bash
cd web
npx playwright install
```

If you only want Chromium (enough for these smoke tests and smaller), run:

```bash
cd web
npx playwright install chromium
```

## Run locally

Set `BASE_URL` to a target that is reachable from this machine. The smoke tests
do not start a server for you; they only drive a browser against an already-running
target.

```bash
cd web
BASE_URL=http://127.0.0.1:3000 npm run test:playwright
```

Or with npx directly:

```bash
cd web
BASE_URL=http://127.0.0.1:3000 npx playwright test
```

## Read the results

The default reporter is `list`, so each test and its result is printed to stdout:

```text
Running 4 tests using 1 worker

  ✔  1 [chromium] › playwright-home-smoke.test.ts:18:7 › qplaywright-home-smoke / Home smoke › the target is reachable
  ✔  2 [chromium] › playwright-home-smoke.test.ts:24:7 › qplaywright-home-smoke / Home smoke › Home renders without an error marker
  ✔  3 [chromium] › playwright-home-smoke.test.ts:29:7 › qplaywright-home-smoke / Home smoke › main content area is present
  ✔  4 [chromium] › playwright-home-smoke.test.ts:33:7 › qplaywright-home-smoke / Home smoke › a map container appears after load

  4 passed
```

When a test cannot run because no browser is installed, Playwright prints an
explicit message asking for `npx playwright install`. That is a setup problem,
not a passing test — do not treat it as evidence the smoke passed.

When a target is not reachable, the first test fails with the HTTP/status detail
from the browser. Read that failure output; do not assume success.

## Configuration

- Config file: `web/playwright.config.ts`
- Smoke test file: `web/tests/playwright-home-smoke.test.ts`
- Browser: Chromium only, with `BASE_URL` read from the environment
- Trace: on first retry only

The target URL is intentionally not hardcoded. Use `BASE_URL` locally and in CI.

## GitHub Actions

A workflow exists at `.github/workflows/qa-playwright-home-smoke.yml`. It is
triggered manually (`workflow_dispatch`) and asks for the target URL as an input.
It does not target production automatically on every pull request.

To run it:

1. Open Actions → qa → Run workflow
2. Paste the target URL into `target_url`
3. Run the workflow

The workflow installs dependencies, caches Playwright browsers, installs Chromium,
and runs `npx playwright test` with `BASE_URL` set from the input.

## Scope and limits

These are smoke tests, not coverage tests. They are meant to catch obvious
render/load regressions on Home, not to validate business logic, auth, payments,
visits, or admin flows.

If the target build does not render a map on Home, the "map container" test is
designed to stay passing (it only asserts visibility when a map locator matches).
If you change Home so that it renders differently, update the locator instead of
diluting the check.
