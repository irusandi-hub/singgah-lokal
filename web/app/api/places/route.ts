import { NextResponse } from "next/server";
import { getPublicPlaceExperienceRepository } from "@/lib/place-experience-repository";

/**
 * Public, session-independent discovery data:
 * `listPublishedPlaces()` reads published Places through the sessionless
 * public (anon) client — it never touches `cookies()` or user identity, so
 * this response is identical for every visitor and Next.js ISR route caching
 * genuinely applies (a cookie-reading handler would opt out and make
 * `revalidate` a no-op). It is revalidated at most every 30 seconds — a
 * short-lived public cache that keeps Home refresh fast without ever serving
 * long-stale data (AGENTS.md: no cache as source of truth; publication /
 * approval state still flows through within 30 s).
 *
 * Deliberately NOT auth-dependent: this route must never become
 * session-scoped, or the shared cache would leak/blur identity.
 */
export const revalidate = 30;

export async function GET() {
  try {
    const repository = await getPublicPlaceExperienceRepository();
    return NextResponse.json(await repository.listPublishedPlaces());
  } catch {
    return NextResponse.json({ error: "Places could not be loaded" }, { status: 500 });
  }
}
