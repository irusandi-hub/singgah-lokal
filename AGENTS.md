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
