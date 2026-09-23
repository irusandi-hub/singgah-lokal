# SINGGAH LOKAL — MASTER AUTHORITY & ROLE STRUCTURE v1.0

Status: **LOCKED** — authority master.
Date: 2026-09-23
Scope: authority hierarchy and role boundaries for the entire SINGGAH LOKAL program — platform (application), infrastructure, and organization. This document defines **reference structure only**; it authorizes no code, migration, or UI change by itself.
Implementation status: **none authorized**. Existing auth/role/UI/database implementations are NOT changed by this document; this master is the source of truth they must be aligned to.

Source hierarchy: `AGENTS.md` → `MASTER_INDEX_v1.0.md` → this master.
Any change to a rule in this document requires an explicit product decision and a new master version. New permissions must preserve this hierarchy unless a new Master version says otherwise.

---

## 1. Authority tiers

There are exactly four authority tiers. No tier may be merged into another, and no tier may be bypassed:

| Tier | Authority type | Domain |
| --- | --- | --- |
| CREATOR / OWNER / DEVELOPER | Highest authority — program + infrastructure | Everything: platform, infrastructure, organization |
| PLATFORM ADMIN | Operational authority | Inside the application only |
| PRODUCER | Resource authority | Only their own resources |
| USER | End-user capability | Discovery and account only |

## 2. CREATOR / OWNER / DEVELOPER (highest authority)

- **Creator = OWNER = DEVELOPER.** They are the same highest authority over the program and **all infrastructure**.
- The Creator holds ultimate control of:
  - **GitHub** (repository, branches, releases)
  - **Vercel** (hosting, deployments, environment)
  - **Supabase** (database, auth, storage, realtime, project settings)
  - **Domain / DNS**
  - **Environment / secrets** (all credentials, API keys, provider tokens)
  - **Deployment** (pipelines, release decisions)
  - **Database / infrastructure** (schema, migrations, infra topology)
  - **Security** (security decisions, incident response authority)
  - **Backup / recovery**
  - **Integrations** (third-party services, provider accounts, credentials)
  - **Architecture** (final technical decisions; masters in `docs/masters/` are locked by/through the Creator)
  - **Pengelolaan Platform Admin** (creating and revoking Platform Admin accounts/roles)
- The Creator may act at every tier below, but the tiers below may never act upward.

## 3. Infrastructure credentials and secrets

- **Infrastructure credentials/secrets must NEVER be delivered through the application** to a Platform Admin, Producer, or User.
- Secrets (Vercel/Supabase/provider keys, stream tokens, signing keys, service-role keys, DNS/DNS-provider credentials, deployment credentials) live only in the server/Creator-controlled runtime environment — consistent with locked rule "credentials are server-side only" (`MASTER_LIVE_POLICY_v1.0.md` §8, `MASTER_LIVE_TECH_v1.0.md` §5).
- No in-app page, role, permission, export, or API response may expose infrastructure credentials/secrets to any non-Creator tier — regardless of that account's role or permission set.
- Management of infrastructure, secrets, integrations, and deployment is **Creator-only**, performed through Creator-controlled consoles/tooling, not through application features.

## 4. Creator is NOT platform_moderator

- The Creator is **not** the `platform_moderator` role and does not hold it by default.
- `platform_moderator` is a Platform Admin operational role (§6). The Creator governs the program and infrastructure above it; moderation is operational work delegated to Platform Admin.
- If the Creator ever performs moderation operations, it must be through a separate Platform Admin account/role that was explicitly granted — not by fusing Creator with `platform_moderator`. No implementation may model the Creator as a moderator role or auto-assign moderation powers to the Creator identity.

## 5. PLATFORM ADMIN (operational authority inside the app)

- **Platform Admin = the operational authority inside the application.** It is the highest authority that exists *in-app*.
- Platform Admin manages, according to its granted permissions:
  - **User** accounts (operational management)
  - **Producer** accounts and **Producer membership**
  - **Place**, **Experience**, **Visit Intent** (operational oversight)
  - **Live** (including moderation per `MASTER_LIVE_POLICY_v1.0.md` §5.1: moderation authority = Platform Admin/Moderator)
  - **Moderation** and **enforcement**
  - **Operational monitoring** of the platform
- `platform_moderator` is an **operational Platform Admin role** — a Platform Admin variant focused on moderation/enforcement duties. It is not a separate tier.
- Platform Admin has **no infrastructure authority**: it cannot access GitHub, Vercel, Supabase project settings, DNS, environment/secrets, deployment controls, database/infrastructure management, or integration credentials. These remain Creator-only (§2, §3).
- Platform Admin does not outrank the Creator and cannot create or modify the Creator's authority.
- Every Platform Admin exists by **Creator grant** and can be **revoked by the Creator** at any time.

## 6. PRODUCER (resource authority)

- Producer authority covers **only the resources that are theirs**:
  - **Place** they own/are a member of (via `producer_memberships`)
  - **Experience** of their Place
  - **Schedule** of their Place/Experience
  - **Visit Intent response** to intents directed at their Place
  - **Live** from their Place (per Live policy/tech masters: authorization checked server-side, eligibility-gated)
- A Producer **cannot** access:
  - **Infrastructure** (GitHub, Vercel, Supabase project settings, DNS, deployment)
  - **Secrets/credentials** of any kind (§3)
  - **Admin** functions, Platform Admin accounts, or other Admin capabilities
  - **Other Producers** — their accounts, memberships, Places, Experiences, Schedules, Visit Intent responses, or Lives
- A Producer authorized for one Place has no rights over any other Place's resources (locked in `MASTER_LIVE_POLICY_v1.0.md` §2.2).
- Producers are subject to moderation by Platform Admin and cannot moderate (locked, PO 2026-09-18).

## 7. USER (end-user capability)

- User capability is limited to:
  - **Discover Place** (Map-based discovery)
  - **Map / Search / Filter**
  - **View Place**
  - **View Experience**
  - **SINGGAH / Visit Intent** (submit and manage their own visit intent)
  - **Respond to Producer** (respond to a Producer's response to their own intent)
  - **Live** (view/comment/report, subject to Live eligibility gates)
  - **Account** (their own account settings only)
- User has **no operational authority**: no moderation, no admin functions, no Producer capabilities, no access to other users' data or any infrastructure/secrets.
- A User may only ever act on **their own** account and their **own** Visit Intents/responses.

## 8. Hierarchy invariants (LOCKED)

| Invariant | Rule |
| --- | --- |
| Top authority | CREATOR / OWNER / DEVELOPER over program + all infrastructure |
| Creator controls | GitHub, Vercel, Supabase, domain/DNS, environment/secrets, deployment, database/infrastructure, security, backup/recovery, integrations, architecture, Platform Admin management |
| Secrets in-app | NEVER delivered via the app to Admin, Producer, or User (§3) |
| Creator vs moderator | Creator is NOT `platform_moderator` (§4) |
| In-app authority | Platform Admin — operational, per permission grants |
| Admin grant/revoke | Creator creates and revokes Platform Admin |
| platform_moderator | Operational Platform Admin role (not a tier, not the Creator) |
| Producer scope | Own Place/Experience/Schedule/Visit Intent response/Live only |
| Producer exclusion | No infrastructure, no secrets, no Admin, no other Producers |
| User scope | Discovery, Place/Experience, SINGGAH/Visit Intent, Producer response, Live, own account |
| User authority | None (operational or otherwise) |
| New permissions | Must preserve this hierarchy; deviation requires a new Master version |

## 9. Source of truth for Creator vs Platform Admin separation

- This document is the **source of truth for the separation between Creator and Platform Admin**.
- Future masters, technical designs, permission tables, RLS policies, and admin tooling must be **derived from and consistent with** this hierarchy.
- When any other document, plan, or implementation appears to blur the Creator/Platform Admin boundary (e.g. giving an Admin infra access, exposing secrets in-app, fusing Creator with `platform_moderator`), **this master wins** — and the conflict must be raised for an explicit product decision (AGENTS.md rule).

## 10. Locked summary

| Rule | Value |
| --- | --- |
| Authority tiers | Creator / Platform Admin / Producer / User |
| Highest authority | CREATOR / OWNER / DEVELOPER (program + all infrastructure) |
| Creator scope | GitHub, Vercel, Supabase, domain/DNS, env/secrets, deployment, DB/infra, security, backup/recovery, integrations, architecture, Platform Admin management |
| Infra secrets via app | Prohibited to Admin, Producer, User |
| Creator as platform_moderator | No — separate roles; moderation is Platform Admin work |
| Platform Admin | Operational authority inside the app (Users, Producers, Producer membership, Place, Experience, Visit Intent, Live, moderation, operational monitoring) |
| platform_moderator | Operational Platform Admin role |
| Admin lifecycle | Granted and revoked by Creator |
| Producer authority | Own Place, Experience, Schedule, Visit Intent response, Live only |
| Producer exclusions | Infrastructure, secrets, Admin, other Producers |
| User authority | None |
| User scope | Discover Place, Map/Search/Filter, Place, Experience, SINGGAH/Visit Intent, Producer response, Live, own account |
| Change rule | Hierarchy is LOCKED; any change requires an explicit product decision + new master version |
