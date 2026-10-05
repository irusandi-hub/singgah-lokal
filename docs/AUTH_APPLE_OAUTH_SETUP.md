# Apple Sign-In — owner configuration checklist

This document lists the **manual provider/dashboard actions** an owner must
perform to turn on the Apple sign-in implemented in this repository. All
repository-side code is already in place; nothing here exposes or asks for a
secret in chat, and no provider credential is stored in the repository.

- App flow: `/auth` (Masuk) and `/auth/sign-up` (Daftar) →
  `POST /api/auth/oauth/apple` → Apple consent →
  `GET /auth/callback` → session cookie → destination.
- Auth provider: the project's **existing Supabase Auth** (same account
  system, session cookies, and role rules as email/password and Google). No
  parallel account system, and Apple sign-in grants **no** elevated role.
- Apple reuses the same callback route as Google (`/auth/callback`), the same
  `sanitizeReturnTo` open-redirect guard, and the same Supabase SSR
  session-cookie mechanism.
- Supabase DEV project ref: `qiwexmzbysujmqctrsiq`
  (from `NEXT_PUBLIC_SUPABASE_URL`; the ref is public app config, not a secret).

## 1. Apple Developer account (Services ID, key, team)

Apple sign-in requires a **paid Apple Developer Program** membership.

1. **App ID**: create/select an App ID with the **Sign In with Apple**
   capability enabled (Identifiers → App IDs).
2. **Services ID**: create a Services ID (Identifiers → Services IDs). This is
   the OAuth `client_id` Supabase will use, e.g. `id.singgahlokal.auth`.
   Configure **Sign In with Apple** on it and add the **Return URL**:
   - `https://qiwexmzbysujmqctrsiq.supabase.co/auth/v1/callback`
   (this is Supabase's own callback host, not the app).
3. **Key**: create a **Sign in with Apple** private key (Keys → +). Download the
   `.p8` file once and record its **Key ID**.
4. Record the **Team ID** (top-right of the Apple Developer account).

Keep the `.p8` private key, its Key ID, the Team ID, and the Services ID out of
this repository. Do not commit them and do not paste them into the repo.

## 2. Supabase Dashboard → Authentication → Providers → Apple

1. Enable the **Apple** provider.
2. Paste:
   - **Services ID** (a.k.a. Client ID), e.g. `id.singgahlokal.auth`
   - **Team ID**
   - **Key ID**
   - the **private key** contents from the `.p8` file
3. Save. Supabase stores the secret server-side; the app never sees it.

## 3. Supabase Dashboard → Authentication → URL Configuration

Apple uses the same app-side redirect configuration as Google. Ensure these
are present (add each environment actually used):

- **Site URL**: the production origin, e.g. `https://<production-domain>`.
- **Additional Redirect URLs**:
  - `http://localhost:3000/auth/callback` (local/preview development)
  - `https://<production-domain>/auth/callback`
  - Each preview/staging origin actually used, e.g.
    `https://<preview-domain>/auth/callback`

The app builds the callback URL from the request's own origin (or from
`NEXT_PUBLIC_SITE_URL` when set) and carries `next` + `provider` query params,
so the origin Supabase sees always matches the origin the browser used.

## 4. Optional application environment

No new environment variable is required for Apple OAuth. The Apple Services ID
and key live only in Supabase. `NEXT_PUBLIC_SITE_URL` (see
`docs/AUTH_GOOGLE_OAUTH_SETUP.md`) remains the only optional OAuth-related app
env var.

## 5. Verification (required before calling Apple operational)

After steps 1–3, perform a real round trip and confirm:

1. A brand-new Apple account lands signed in (a `public.users` row is created
   by the existing trigger) and is treated as a normal USER.
2. An existing account that already has an Apple identity signs in to the same
   account (no duplicate account).
3. Cancelling the Apple consent screen returns to `/auth` with a clear
   "Masuk dengan Apple dibatalkan" message and no stuck loading state.
4. Apple and Google both appear beside the email/password form on `/auth` and
   `/auth/sign-up`, and signing out ends the session for all providers.

Until that round trip is observed, Apple sign-in must be described as
**configured in code but not verified operational**.
