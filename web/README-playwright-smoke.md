# Playwright home smoke

Read-only browser smoke tests for the Singgah Lokal Home page. They verify that
the target page loads without an HTTP 5xx or a visible error marker and that the
Home shell (the `<main>` root authored in `components/home-discovery.tsx`) and,
where rendered, the map area are present after load.

No data is changed, no account is created, no file is uploaded, and no admin
surface is touched.

## Prerequisites

Node 20+ and Bun. Install the project dependencies first from the repo root:

```bash
cd web
bun install
```

Then install the browsers once per machine/environment:

```bash
cd web
bunx playwright install
```

If you only want Chromium (enough for these smoke tests and smaller), run:

```bash
cd web
bunx playwright install chromium
```

## Run locally

Set `BASE_URL` to a target that is reachable from this machine. The smoke tests
do not start a server for you; they only drive a browser against an already-running
target.

```bash
cd web
BASE_URL=http://127.0.0.1:3000 bun run test:playwright
```

Or with `bunx` directly:

```bash
cd web
BASE_URL=http://127.0.0.1:3000 bunx playwright test
```

## Read the results

The default reporter is `list`, so each test and its result is printed to stdout:

```text
Running 2 tests using 1 worker

  ✓  1 [chromium] › playwright-home-smoke.test.ts:19:7 › qplaywright-home-smoke / Home smoke › the target is reachable
  ✓  2 [chromium] › playwright-home-smoke.test.ts:25:7 › qplaywright-home-smoke / Home smoke › Home renders the expected shell on Home

  2 passed
```

When a test cannot run because no browser is installed, Playwright prints an
explicit message asking for `bunx playwright install`. That is a setup problem,
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

A workflow exists at `.github/workflows/qa-playwright-home-smoke.yml` at the
**repository root**, not under `web/`. It is triggered manually
(`workflow_dispatch`) and asks for the target URL as an input. It does not
target production automatically on every pull request.

The CI job installs dependencies with Bun in the `web/` directory, caches
Playwright browsers, installs Chromium, and runs `bunx playwright test` with
`BASE_URL` set from the input.

To run it:

1. Open Actions → qa → Run workflow
2. Paste the target URL into `target_url`
3. Run the workflow

## Scope and limits

These are smoke tests, not coverage tests. They are meant to catch obvious
render/load regressions on Home, not to validate business logic, auth, payments,
visits, or admin flows.

If the target build does not render a map on Home, the "map container" check is
only run when the locator matches, so a missing map locator does not hide a
broken Home shell. If you change Home so that it renders differently, update the
locator instead of diluting the check.
