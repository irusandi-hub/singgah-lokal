import { NextResponse } from "next/server";
import { processAgeVerificationCallback } from "@/lib/age-verification/service";

/**
 * Provider webhook endpoint for age-verification results (Phase 2.1 foundation).
 *
 * Provider-neutral: the signature scheme, the payload shape and the event id are
 * owned by whichever provider is later registered. This route only hands the RAW
 * body and the headers to the provider (which must verify its own signature) and
 * then applies the outcome. With no provider configured it answers
 * `provider_not_configured` (503) and writes nothing.
 *
 * Fail-closed mapping:
 *   503 provider_not_configured — no provider registered (today)
 *   401 invalid_signature       — the provider could not authenticate the call
 *   503 store_unavailable       — the result could not be recorded
 *   404 unknown_reference       — no verification row matches the reference
 *   200 ignored                 — a replayed event (recorded once, applied once)
 *   200 applied                 — the verification status was updated
 *
 * No secret is read here: provider credentials belong to the provider module and
 * the server runtime env, never to this route.
 */
export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const result = await processAgeVerificationCallback({ rawBody, headers });

    switch (result.status) {
      case "provider_not_configured":
        return NextResponse.json({ error: "provider_not_configured" }, { status: 503 });
      case "invalid_signature":
        return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
      case "store_unavailable":
        return NextResponse.json({ error: "age_verification_unavailable" }, { status: 503 });
      case "unknown_reference":
        return NextResponse.json({ error: "unknown_reference" }, { status: 404 });
      case "event_replay":
        return NextResponse.json({ status: "ignored" });
      default:
        return NextResponse.json({ status: "applied" });
    }
  } catch {
    return NextResponse.json({ error: "age_verification_unavailable" }, { status: 503 });
  }
}
