# SINGGAH LOKAL — GitHub Copilot Instructions

Before coding, inspect the relevant files in `docs/masters/` and follow `AGENTS.md`.

Treat the Masters as locked requirements, not suggestions. Never silently change product/business rules.

Critical rules:
1. Place is the central discovery object.
2. SINGGAH means visit intent; it is not a purchase or guaranteed reservation.
3. MVP must not implement payment, checkout, cart, wallet, escrow, settlement, or financial transaction processing.
4. Currency follows Place; schedules and date/time interpretation follow Place timezone.
5. Do not invent facts about Places, Producers, Products, Experiences, schedules, tickets, prices, or production claims.
6. AI-generated Producer content is draft-only until Producer review/approval and must not auto-publish.
7. Producer AI usage must be account/email-bound and quota/cost controlled.
8. Verified status must not be treated as proof that every claim is verified.
9. Canonical database/domain data is the source of truth; search indexes and caches are derived data.
10. Preserve server-side authorization, validation, idempotency, auditability, and tests.
11. Never commit secrets.
12. Development is HP-first using browser/cloud tooling. Do not require a laptop/desktop without explaining why it is genuinely necessary.

Implementation behavior:
- Read → Plan → Implement → Validate → Review → Commit.
- Prefer small, reviewable changes.
- If requirements are ambiguous or conflict with a Master, stop and ask rather than inventing a rule.
