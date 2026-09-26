# Account Menu — Setting / Help / About & Terms: audit result

Date: 2026-09-26
Baseline commit: `03ee69e` (Notification surface: header bell + Inbox + Notification Settings)
Scope: the Account Menu (☰) items that are still placeholders.

## Result of the audit

| Item | Source-of-truth found | Decision |
| --- | --- | --- |
| Account Center | existing `/account` route | already implemented, untouched |
| Notification Settings | `notification_preferences` (migration 0024), MASTER 10 §10 | already implemented at `/account/notifications`, untouched |
| Navigation | **none** — no master requirement, no stored preference, no surface | stays inert (no dead link) |
| App Language | MASTER 01 locks "Bahasa utama awal: Bahasa Indonesia"; MASTER 10 §13 keeps localization *architectural* while MVP ships one primary language. No second locale, no translation strings exist in the project. | stays inert — a switcher would require inventing a language and its copy |
| Video Setting | MASTER_LIVE_POLICY §6 locks **720p / 30 fps as a technical Live limit** (ingest/playback), not a user preference. No user-facing video control, no stored preference, no schema for it. | stays inert — would require new schema + invented content |
| Help | no FAQ/contact/support copy anywhere. MASTER 10's "Help & Support" is a notification *category*; MASTER 08/09's Support/Ops is an internal Platform Admin role. | stays inert — no FAQ, contact, or support policy is invented |
| About & Terms | no Terms/Privacy/legal copy in the project. MASTER 12 defers privacy/retention to a **"Privacy Master" that does not exist** in `docs/masters/`. | existing behaviour kept — no legal text is invented |

## Why nothing was built

`AGENTS.md` makes the Masters the source of truth and forbids inventing
requirements. Every remaining item would have required new product copy, a new
feature, or new schema with no master behind it. The project pattern for a
missing surface is an inert menu item (visible, `aria-disabled`, "Segera
tersedia") — never a dead link and never invented content. That pattern is
unchanged, and is now locked by `web/tests/account-menu-surfaces.test.ts`.

## Gaps to resolve with a product decision

1. **App Language** — needs a master decision on the second locale and its
   translation source before any language switcher can exist.
2. **Video Setting** — needs a master decision on what the User may control
   (e.g. playback quality) versus the locked 720p/30 fps ingest limit; any
   stored user preference would need a new migration.
3. **Help** — needs real support content (FAQ / contact channel) from the
   product owner.
4. **About & Terms** — needs the missing **Privacy Master** (referenced by
   MASTER 12) and Terms text. Note: the menu entry currently links to Home,
   which is pre-existing behaviour kept deliberately; it should be revisited
   when the Terms/Privacy source exists.

## Regression coverage

`web/tests/account-menu-surfaces.test.ts` locks: the four Setting items and
their order, Notification Settings as the only linked Setting route, inert
Navigation/App Language/Video Setting/Help, the absence of invented
`/about`, `/terms`, `/privacy`, `/help` pages, exactly one Notification entry
in the menu, the bell as the only inbox entry, the unchanged header nav (Home,
LIVE, Visit Intent — no duplicates, no bottom nav, logo untouched), and the
signed-out header having neither the account menu nor a notification action.
