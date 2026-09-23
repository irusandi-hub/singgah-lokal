# SINGGAH LOKAL — MASTER INDEX v1.0

Definitive reference set for long-term implementation.

1. MASTER 01 — Foundation & Business Rules
2. MASTER 02 — Producer AI Assistant & AI Cost Control
3. MASTER 03 — UX Home / Map / Place
4. MASTER 04 — “Dari Sini” / Production Story
5. MASTER 05 — Technical Implementation Baseline
6. MASTER AUTHORITY & ROLE STRUCTURE v1.0 — `MASTER_AUTHORITY_STRUCTURE_v1.0.md`

MASTER AUTHORITY & ROLE STRUCTURE v1.0 (`MASTER_AUTHORITY_STRUCTURE_v1.0.md`) is an **official Master** that must be used together with the other Masters. It is the source of truth for the Creator vs Platform Admin separation and the locked authority hierarchy: CREATOR / OWNER / DEVELOPER (highest authority, program + all infrastructure) → PLATFORM ADMIN (operational authority inside the app) → PRODUCER (own resources only) → USER (no operational authority).

LOCKED principles:
- Authority hierarchy is LOCKED: CREATOR / OWNER / DEVELOPER hold the highest authority over the program and all infrastructure; PLATFORM ADMIN holds operational authority inside the app; PRODUCER is limited to their own resources; USER has no operational authority. New permissions must preserve this hierarchy unless a new Master version says otherwise.
- Infrastructure credentials/secrets are never delivered through the application to Admin, Producer, or User.
- The Creator is NOT platform_moderator; platform_moderator is an operational Platform Admin role.
- Initial market: Indonesia.
- Home = Map-based Discovery.
- Home discovery is time-first, not product-category-first.
- Place is the ecosystem center.
- Currency follows Place.
- Schedule/availability uses Place timezone.
- MVP does not facilitate financial transactions between Producer and User.
- Ticket/price/promotion are informational Producer data.
- AI generation cost must be controlled per registered Producer account/email; platform must not carry uncontrolled Producer AI generation cost.
- AI content is draft until Producer approval; AI may not invent facts.
- “Dari Sini” is dynamic production storytelling.
- SINGGAH leads to Visit Intent, not checkout/payment.

Use the latest master files as the source of truth for AI coding. Any change to a LOCKED rule requires an explicit product decision and a new master version.
