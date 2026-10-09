# SINGGAH LOKAL — UI TERMINOLOGY STANDARD

The ONE documentation location for user-facing UI wording (labels, headings,
buttons, empty/loading/error states, confirmations, accessibility labels).
Established by the UI/UX + language audit of 2026-10-09. Masters in
`docs/masters/` remain the product source of truth; this standard governs how
those concepts are WRITTEN in the interface and never introduces a new
business rule.

## 1. Language rules

- The interface language is Bahasa Indonesia (MASTER 01: initial single
  language). Write natural, concise Indonesian; avoid unnecessary English and
  internal technical terms.
- Describe the user's task or the actual result ("Simpan", not "Submit";
  "Batal", not "Cancel").
- Use specific action labels instead of vague ones; keep status messages
  factual and never claim success when an operation fails.
- Menu labels stay consistent with the destination page's title.
- Keep product meaning unchanged: a copy edit never adds, removes, or alters a
  rule, permission, or data shown.
- Do not blind-replace: each occurrence is reviewed in context, and locked
  product terms (below) are never translated.

## 2. Locked product terms (never translated)

| Term | Meaning |
| --- | --- |
| SINGGAH LOKAL | the platform |
| SINGGAH | visit intent — never checkout/payment |
| Tempat | the Place entity in user-facing Indonesian copy ("Place" stays in code, docs, and Master references) |
| Discovery Place | the canonical Home results heading (locked by the discovery suites) |
| Tempat Pilihan | the curated Place row/preset |
| Live | the real-time broadcast feature; the header control reads **LIVE** |
| Kunjungan / Visit Intent | visit-intent surfaces ("Permintaan Kunjungan" for the Producer inbox) |
| Pengelola | owner/manager Producer role |
| Operator Live | delegated Live operator assignment (never conflated with Pengelola) |
| Platform Admin | operational platform role (`platform_moderator`) |
| Creator | the Creator/Developer authority tier |
| Dari Sini | production storytelling |
| Kegiatan | Experience entity |

## 3. Canonical labels (Indonesian replaces the old English)

| Surface | Use | Retired |
| --- | --- | --- |
| Account page title | Akun & Akses | Account & Access Center |
| Profile section / action | Profil Saya / Edit Profil | Profile / Edit Profile |
| Save / Cancel actions | Simpan / Batal | Save Changes / Cancel |
| Account menu entry | Akun & Akses | Account Center |
| Sign-out action | Keluar | Sign Out |
| Settings group | Pengaturan | Setting |
| Settings items | Navigasi, Bahasa Aplikasi, Pengaturan Video, Pengaturan Notifikasi | Navigation, App Language, Video Setting, Notification Settings |
| Help menu entry | Bantuan | Help |
| Header home link | Beranda | Home |
| Notification preferences page | Pengaturan Notifikasi | Notification Settings |
| Admin tabs | Ringkasan, Data Tempat, Moderasi Live | Overview, Data Place, Live Moderation |
| Admin Live tables/headings | Sesi Live, Laporan Live, Kelayakan Pengelola | Live Session, Live Report, Eligibility Pengelola |

## 4. Structural rules (Android-inspired settings organization)

- Group related functions under meaningful headings; one grouped list per
  destination family (see the Akses section of `/account`).
- Keep navigation shallow and predictable: one contextual back action per
  workflow, no nested navigation bars, no duplicate controls.
- Put an action beside the feature it controls; show role-specific options
  only to authorized users (server-side resolution, never client-side
  inference); remove dead links and items that imply nonexistent features.
- Inert items that predate this standard (Navigasi, Bahasa Aplikasi,
  Pengaturan Video) stay visibly inert ("Segera tersedia") per
  `docs/ACCOUNT_MENU_GAP_AUDIT.md` — they are not links to invented surfaces.
- Every list row that navigates carries an icon, a short Indonesian label,
  and the shared right-facing chevron.

## 5. Scope of the 2026-10-09 audit

Audited in context: Home/Map, Place detail and Experience pages, Visit Intent,
Authentication/onboarding, Account & profile, Producer dashboard and Place
management, Live and Live Operator, Admin and Developer, plus forms,
dialogs, buttons, empty states, loading states, errors, confirmations, and
accessibility labels. Deliberately unchanged: the locked terms in §2, code
identifiers, and already-natural Indonesian copy. Tests that lock copy
(`web/tests/account-*.test.ts`, `admin-*.test.ts`, `navigation-*.test.ts`,
`notification-inbox.test.ts`) are kept in sync with this standard — update
them here when a label changes.
