# MASTER — DEVELOPER AUTHORITY & DUMMY PLACE v1.0

Status: **LOCKED** — data + authority master (additive).
Date: 2026-10-03
Supersedes: nothing. **Extends** `MASTER_AUTHORITY_STRUCTURE_v1.0` §2/§3/§4 without altering them.
Source hierarchy: `AGENTS.md` → `MASTER_INDEX_v1.0.md` → this master.

Implementation status: implemented — migrations `0039_dummy_place_developer_authority.sql`
(schema) and `0040_dev_dummy_riyadh_dataset.sql` (DEV data only); Developer Authority in
`web/lib/developer/dummy-places.ts` (server-only) and `web/lib/developer/dummy-places-core.ts` (pure).

This master is **additive**. It grants no new tier, relaxes no existing protection, and changes
no locked rule in `MASTER_AUTHORITY_STRUCTURE_v1.0`, `MASTER_LIVE_POLICY_v1.0`, or
`MASTER_LIVE_TECH_v1.0`. Where this document and any existing master could be read as
conflicting, **the existing master wins** and the conflict must be raised as a product decision.

---

## 1. Why this master exists

A Dummy Place is data that exists only for development and testing. Before this master the
concept had **no canonical representation**: DEV demo Places were ordinary `published` rows whose
only trace was the words "Demo Place:" inside a free-text description.

That is not a fact, it is editable text. Any authority decision keyed on it would be forgeable by
whoever can write a description — which is exactly the "client-supplied label" this master forbids.

## 2. Definition of a Dummy Place

| Rule | Value |
| --- | --- |
| Canonical marker | `public.places.is_dummy` (boolean, `NOT NULL DEFAULT false`) |
| Migration | 0039 |
| Who may set it | The Creator-controlled Developer Authority path only (service role) |
| May it be inferred from text? | **No.** Never from a name, description, or any free text |
| Is it a publication state? | No — orthogonal to `publication_status` |
| Is it a category? | No — the three canonical categories are unchanged |
| Is it a Discovery input? | **No.** The engine is dummy-blind; a Dummy Place is eligible on exactly the same canonical terms as any other Place |
| Does it change scoring? | No. Scores and stars stay computed by the engine |

`is_dummy = true` means only: *this row is a development/testing fixture, not a real listing.*

## 3. Legacy data handling

Migration 0039 marks exactly the ten Places created by migration 0037, **named explicitly by id**.
0037 is the authoritative record of what those ids are. This is the ONLY sanctioned form of
backfill: an enumerated id list from an authoritative migration, never a text predicate.

A Place that merely contains "Demo" or "Dummy" in its name or description is **not** marked, and
must not be marked by any heuristic. Every other existing Place keeps `is_dummy = false`.

## 4. Developer Authority — scope and limits

The Developer Authority is a **Creator-controlled technical path** (tooling / administrative
migration), never an application feature (`MASTER_AUTHORITY_STRUCTURE_v1.0` §3).

**Permitted operations — the set is closed:**

| Operation | Effect | Scope |
| --- | --- | --- |
| `set_dummy` | mark / unmark the canonical flag | Any Place the Creator can see |
| `set_curated` | promote / unpromote `is_curated` (Tempat Pilihan) | **Only `is_dummy = true` rows** |

`set_curated` is the operation with a scope limit, because it is the one that could otherwise reach
into the real curated layer. `set_dummy` has no such limit because it is the operation that
establishes the Dummy scope in the first place — but it is Creator-only and fully audited.

**Hard limits:**

- **Not `platform_moderator`.** The Developer Authority never grants, implies, or checks
  `users.platform_role`, and is never modelled as a moderation role (Authority Master §4).
- **No client exposure.** No HTTP route, no client component, no client import. There is no
  service-role endpoint of any kind for these operations.
- **No table-wide reach.** It cannot enumerate or mutate arbitrary Places; curation is limited to
  validated Dummy rows.
- **No generic bypass.** Migration 0039 does not widen 0036's `is_curated` lockdown, and does not
  weaken any RLS policy. The only new guard is a NEW column's own guard.
- **No trust in client input.** The operation is a server-side literal; the flag is a validated
  boolean; the reason is mandatory and length-checked; the actor is the authenticated Creator's
  own user id, never the service role.
- **Not authorized by a user-supplied value.** There is no self-declared "developer" flag, header,
  or role a caller can set.

## 5. Audit requirements

Every Developer Authority mutation writes one append-only `public.place_audit` row recording:

- **actor** — the Creator's own authenticated `user_id` (never the service role);
- **action** — `developer_place_dummy_marked` / `_cleared` / `developer_place_curated` /
  `developer_place_uncurated`, deliberately distinct from the `admin_place_*` keys so a Developer
  decision can never be confused with a Platform Admin one;
- **target** — the Place id;
- **reason** — mandatory, non-empty, ≤500 characters, trimmed; a blank or over-long reason is
  refused rather than silently truncated;
- **before / after** — the canonical Place snapshot including `is_dummy` and `is_curated`.

Additional guarantees:

- **An audit failure must not leave data.** If the audit write fails, the flag change is rolled
  back before the error is surfaced. A change never outlives its own trail.
- **Append-only is preserved.** 0031's `block_place_audit_mutation` trigger continues to raise on
  UPDATE and DELETE for every writer, the service role included. Migration 0039 only extends the
  action vocabulary; it never modifies or removes an existing row, column, policy, or trigger.
- **Idempotency.** A no-op change writes nothing and records nothing (AGENTS.md).

## 6. Relationship to existing authority

| Tier | May change `is_dummy`? | May change `is_curated`? |
| --- | --- | --- |
| Creator / Developer | Yes, through this path only | Yes, on Dummy rows only |
| Platform Admin | **No** | Yes, through the existing audited Admin path |
| Producer | **No** | **No** |
| User | **No** | **No** |

The Platform Admin path (`setAdminPlaceCurated`) is unchanged. The Developer Authority adds no
capability to any tier below Creator.

## 7. Geography and currency

`SAR` is admitted to `places.currency` (migration 0039) so a Place can always satisfy
**"Currency follows Place"** (`MASTER 01`) instead of being forced to claim a currency its geography
does not have. This widens the accepted vocabulary; it **does not change the initial market**, which
remains Indonesia (`MASTER 01`).

Dummy Places may exist outside Indonesia **for development and testing only**, as in migration 0040.
A non-Indonesian Dummy Place is test data, never a signal of market expansion.

## 8. DEV / production separation

- Migrations are applied per environment, exactly as for the 0019 and 0037 demo seeds.
- **0040 is DEV ONLY and must never be applied to production.** Its ten rows are fictional Places;
  on production they would inject them into Discovery. This is why the data is a separate migration
  from the schema: 0039 is safe everywhere, 0040 is not.
- Test data must never masquerade as a real Producer. Every Dummy Place is unowned
  (`producer_id IS NULL`) and unclaimed (`claim_status = 'unverified'`), and its name and
  description state plainly that it is test data.
- Dummy status is metadata for operators and developers. It is never rendered as an endorsement,
  and never used to imply a real Producer exists.

## 9. Change rule

Any change to the operation set, the Dummy scope limit, the audit guarantees, or the DEV-only
boundary requires an explicit product decision and a new version of this master, plus an update to
`MASTER_INDEX_v1.0.md`.