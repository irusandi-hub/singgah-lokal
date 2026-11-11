# SINGGAH LOKAL — AI AGENT RULES

## Source of truth
- The Master documents in `docs/masters/` are the product and technical source of truth.
- Read the relevant Master documents before implementing a feature.
- If Masters conflict, stop and ask for a decision; do not silently choose a new business rule.

## Locked product rules
- SINGGAH LOKAL is a discovery platform centered on Place.
- Core flow: Map/Discovery → Place → Story/Production → Experience → SINGGAH → Visit Intent → Producer.
- SINGGAH is visit intent, not checkout or payment.
- MVP has no payment, checkout, cart, wallet, escrow, settlement, or transaction processing.
- Prices/tickets are informational only; currency follows Place.
- Place timezone is the source of truth for schedules and visit-intent times.
- Verified Place/Producer does not mean every Producer claim is verified.
- AI may assist content creation, but must not invent facts, must remain draft until Producer approval, and must not auto-publish.
- Producer AI usage is tied to the registered Producer account/email and subject to quota/cost controls.

## Engineering rules
- Prefer simple, maintainable, typed implementations.
- Validate inputs server-side.
- Do not expose secrets or commit `.env` values.
- Do not delete data, migrations, or infrastructure without explicit approval.
- Add/update tests for meaningful behavior changes.
- Do not use cache/search index as the source of truth for canonical Place/Producer/Product/Experience data.
- Preserve idempotency for operations that can be submitted more than once.
- Keep authorization checks on the server.

## Device constraint
- Development is HP-first through browser/cloud tooling.
- Do not require a desktop IDE unless the task genuinely cannot be completed reliably on mobile/browser.
- If a laptop/PC becomes necessary, explain the exact reason before changing the workflow.

## Browser automation — Agent Browser
- Use Vercel `agent-browser` for real-browser verification of UI and user workflows; a successful build or unit test alone does not prove the browser experience works.
- Before first use in an environment, check `agent-browser --version`. If unavailable, install the CLI with `npm install -g agent-browser`, then install its browser with `agent-browser install`. On Linux, use `agent-browser install --with-deps` only when required system browser libraries are missing and the environment permits installing them.
- Before using the tool, load the version-matched instructions with `agent-browser skills get core` and follow them. The discovery skill can be installed with `npx skills add vercel-labs/agent-browser` when the agent harness supports skills.
- Standard interaction loop: `agent-browser open <URL>` → `agent-browser snapshot -i` → interact using fresh element refs → take a new snapshot after navigation or meaningful DOM changes. Use `agent-browser --help` for current command syntax.
- Verify the actual changed workflows, visible controls, forms and validation, navigation, error/empty states, keyboard/focus behavior where relevant, and responsive layouts at relevant phone, tablet, and desktop widths.
- Inspect browser console/errors and capture screenshots for material UI changes or regressions. A click is not considered successful unless the resulting page/state is checked.
- Use only synthetic development/preview data and explicitly authorized test accounts. Never expose, save, or enter real user personal data, production credentials, or secrets into browser sessions, screenshots, traces, or Git.
- Never use browser automation to mutate production data, make real bookings/payments, publish content, send messages, or perform irreversible actions. Do not bypass authentication or authorization to claim a protected workflow passed.
- If a route requires authentication, report it as blocked/not tested unless an authorized test account and safe non-production environment are available.
- Report the exact URL/environment, routes and viewport sizes tested, actions performed, observed results, console errors, screenshots/evidence, and anything not tested. Clearly distinguish browser-tested behavior from build/unit-test results.
- Do not add `agent-browser` as an application runtime dependency or commit browser binaries/auth state unless the project explicitly requires and approves that change.
