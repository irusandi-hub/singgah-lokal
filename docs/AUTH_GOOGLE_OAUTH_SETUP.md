# Google Sign-In — owner configuration checklist

This document lists the **manual provider/dashboard actions** an owner must
perform to turn on the Google sign-in implemented in this repository. All
repository-side code is already in place; nothing here exposes or asks for a
secret in chat, and no provider credential is stored in the repository.

- App flow: `/auth` (Masuk) and `/auth/sign-up` (Daftar) →
  `POST /api/auth/oauth/google` → Google consent →
  `GET /auth/callback` → session cookie → destination.
- Auth provider: the project's **existing Supabase Auth** (same account
  system, session cookies, and role rules as email/password). No parallel
  account system, and Google sign-in grants **no** elevated role.
- Supabase DEV project ref: `qiwexmzbysujmqctrsiq`
  (from `NEXT_PUBLIC_SUPABASE_URL`; the ref is public app config, not a secret).

## 1. Google Cloud Console (OAuth client)

1. Create/select a Google Cloud project and configure the OAuth consent screen.
2. Create an **OAuth 2.0 Client ID** of type **Web application**.
3. Authorized **JavaScript origin** (Supabase's own callback host):
   - `https://qiwexmzbysujmqctrsiq.supabase.co`
4. Authorized **redirect URI** (Supabase, not the app):
   - `https://qiwexmzbysujmqctrsiq.supabase.co/auth/v1/callback`
5. Keep the generated **Client ID** and **Client Secret** for step 2 below.
   Do not commit them and do not paste them into the repository.

## 2. Supabase Dashboard → Authentication → Providers → Google

1. Enable the **Google** provider.
2. Paste the Google **Client ID** and **Client Secret** from step 1.
3. Save. Supabase stores the secret server-side; the app never sees it.

## 3. Supabase Dashboard → Authentication → URL Configuration

Set the app-side redirect URLs so Supabase will return the browser to
`/auth/callback`.

- **Site URL**: the production origin, e.g. `https://<production-domain>`.
- **Additional Redirect URLs** (add each environment used):
  - `http://localhost:3000/auth/callback` (local/preview development)
  - `https://<production-domain>/auth/callback`
  - Each preview/staging origin actually used, e.g.
    `https://<preview-domain>/auth/callback`

The app builds the callback URL from the request's own origin (or from
`NEXT_PUBLIC_SITE_URL` when set), so the origin Supabase sees always matches
the origin the browser used.

## 4. Optional application environment

- `NEXT_PUBLIC_SITE_URL` — set this to the canonical public origin (no trailing
  slash) when the deployment sits behind a proxy and you want a deterministic
  OAuth redirect origin. Optional; otherwise the request origin is used.
- No Google client id/secret and no new Supabase key is required in the app
  environment for OAuth. The Google client id/secret live only in Supabase.

## 5. Verification (required before calling Google operational)

After steps 1–3, perform a real round trip and confirm:

1. A brand-new Google account lands signed in (a `public.users` row is created
   by the existing trigger) and is treated as a normal USER.
2. An existing email/password account that already has a Google identity signs
   in to the same account (no duplicate account).
3. Cancelling the Google consent screen returns to `/auth` with a clear
   "dibatalkan" message and no stuck loading state.
4. Signing out ends the session for both Google and email/password.

Until that round trip is observed, Google sign-in must be described as
**configured in code but not verified operational**.
