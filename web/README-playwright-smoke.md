# Playwright home smoke

Read-only browser smoke tests for the Singgah Lokal Home page. They verify that
the target answers without an HTTP 5xx, that Home's `<main>` shell is visible,
and that the Home map container is present and actually occupies the map stage.

No data is changed, no account is created, no file is uploaded, and no admin
surface is touched.

## What is checked

`web/tests/playwright-home-smoke.test.ts` contains six tests:

1. **the target is reachable** — `BASE_URL` responds with a status below 500.
2. **Home renders the shell and the map container** — Home's `<main>` is
   visible, and the map container
   `div.singgah-home-map[aria-label="Peta Tempat"]` (rendered unconditionally by
   `components/home-map.tsx`) is visible with a non-zero box.
3. **Home keeps the whole catalogue on the map before any location fix** —
   with geolocation not granted, one Place = one pin, and the first reported
   map frame does not remove Places the server rendered (the regression that
   used to drop every non-Gulf Place on a clamped world slice).
4. **with a location fix the map never paints a world-scale frame** — with a
   granted fix the map must open on the user's local area, never on the
   world-scale catalogue frame that it then replaced. The location outcome is
   delayed to phone-like latency (1500 ms), because Chromium answers a persisted
   permission decision faster than a tile can paint and the first frame would
   otherwise be unobservable. Fails on the pre-fix build with ~16 world-scale
   samples.
5. **without a fix, a world-scale frame always carries the whole catalogue** —
   while the first location attempt is pending the map must not paint a basemap
   at all (that is how the global frame used to appear first), and once the
   denial settles the catalogue frame must list every Place, one pin each.
   Fails on the pre-fix build with tiles painted before any frame decision.
6. **a real fix moves the camera to the user area exactly once** — with a
   granted fix the user disc appears and the list settles without oscillating.
   Browsers only honour geolocation in a secure context, so on an `http` target
   this test is reported as **skipped**, not passed.

The map check is **not optional**. If the container is missing or has no size,
the smoke fails. Tests 1–3 do **not** require location permission and do
**not** require map tiles to finish loading — only the container element itself.
Tests 4–6 exercise real geolocation timing; tests 4 and 6 report **skipped** on
an `http` target instead of passing silently, while test 5 still runs (a denial
needs no secure context).

## Prerequisites

Node 20+ and Bun. Install the project dependencies from `web/`:

```bash
cd web
bun install
```

Then install the browser once per machine/environment:

```bash
cd web
bunx playwright install chromium
```

## Run locally

Set `BASE_URL` to a running target. The smoke does not start a server for you.

```bash
cd web
BASE_URL=http://127.0.0.1:3000 bun run test:playwright
```

Or directly:

```bash
cd web
BASE_URL=http://127.0.0.1:3000 bunx playwright test
```

## Read the results

The reporter is `list`, so every test and its outcome is printed:

```text
Running 6 tests using 1 worker

  ✓  1 [chromium] › playwright-home-smoke.test.ts:61:9 › qplaywright-home-smoke / Home smoke › the target is reachable (1.3s)
  ✓  2 [chromium] › playwright-home-smoke.test.ts:67:9 › qplaywright-home-smoke / Home smoke › Home renders the shell and the map container (1.7s)
  ✓  3 [chromium] › playwright-home-smoke.test.ts:100:9 › qplaywright-home-smoke / Home smoke › Home keeps the whole catalogue on the map before any location fix (5.8s)
  ✓  4 [chromium] › playwright-home-smoke.test.ts:156:9 › qplaywright-home-smoke / Home smoke › with a location fix the map never paints a world-scale frame (5.7s)
  ✓  5 [chromium] › playwright-home-smoke.test.ts:227:9 › qplaywright-home-smoke / Home smoke › without a fix, a world-scale frame always carries the whole catalogue (6.8s)
  ✓  6 [chromium] › playwright-home-smoke.test.ts:323:9 › qplaywright-home-smoke / Home smoke › a real fix moves the camera to the user area exactly once (4.6s)

  6 passed (26.8s)
```

A failure is a real finding:

- a target that is unreachable or returns 5xx fails the first test;
- Home that does not render its shell, or that renders without the map
  container (or with a zero-size container), fails the second test;
- a world-scale (zoom ≤ 3) frame on a 390 px viewport, or a basemap painted
  before the first-frame decision, fails tests 4 and 5 — that is the
  "global map, then it changes" regression itself.

A missing browser is reported by Playwright as a setup error asking for
`bunx playwright install chromium`; that is a setup problem, not a passing test.

## Configuration

- Config: `web/playwright.config.ts`
- Test file: `web/tests/playwright-home-smoke.test.ts`
- Browser: Chromium only
- `testMatch` limits the run to the smoke file; the project's real unit suite is
  `bun run test` (`tsx --test "tests/**/*.test.ts"`) and is not run by Playwright
- `BASE_URL` is read from the environment and is never hardcoded

## GitHub Actions

The workflow lives at the repository root, not under `web/`:
`.github/workflows/qa-playwright-home-smoke.yml`.

It is manual-only (`workflow_dispatch`) and requires a `target_url` input, so it
never targets production automatically on a pull request. It installs
dependencies with `bun install --frozen-lockfile` (the repo ships `web/bun.lock`),
installs Chromium with `bunx playwright install --with-deps chromium`, and runs
`bunx playwright test` with `BASE_URL` from the input.

To run it:

1. Open Actions → qa → Run workflow
2. Paste the target URL into `target_url`
3. Run the workflow

Note: a `workflow_dispatch` workflow only appears in the Actions UI once the
workflow file exists on the repository's default branch. Until then it cannot be
triggered through the UI or the API, even though the file is present on a PR
branch.

## Scope and limits

This is a smoke test, not coverage. It catches "Home did not render", "Home
returned 5xx", and "the map container disappeared or collapsed". It does not
validate business logic, auth, payments, visit intents, admin flows, or map tile
correctness.
