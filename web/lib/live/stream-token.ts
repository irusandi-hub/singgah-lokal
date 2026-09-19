import "server-only";

import { LIVE_PLAYBACK_TOKEN_TTL_SECONDS } from "@/lib/live/types";

/**
 * Stream signing-key token issuance (MASTER_LIVE_TECH §5, Phase 5).
 *
 * Provider-documented mechanism for Live WebRTC signed access (the /token
 * endpoint does NOT support Live WebRTC):
 *  1. `POST /accounts/{id}/stream/keys` (once, admin) → { id, pem, jwk }.
 *  2. Sign RS256 JWT: header { alg: "RS256", kid: <key id> },
 *     payload { sub: <live_input_uid>, kid: <key id>, exp, nbf }.
 *  3. The token REPLACES the input UID in the WHEP playback URL.
 *
 * Security invariants (fail closed):
 * - The signing key lives in server env vars only (CLOUDFLARE_STREAM_SIGNING_KEY,
 *   CLOUDFLARE_STREAM_SIGNING_KEY_ID) — never in the repo, never to the client.
 * - Tokens are minted ONLY after the full admission gate passes.
 * - TTL is short (default 60 s, provider max 24 h).
 * - On any misconfiguration or crypto failure, issuance returns null and the
 *   playback route denies (no unsigned URL is ever exposed).
 */

const STREAM_API_BASE = "https://api.cloudflare.com/client/v4";

export type StreamSigningKey = {
  keyId: string;
  /** base64-encoded JWK (base64url-decoded before import). */
  jwkB64: string;
};

export function getStreamSigningKey(): StreamSigningKey | null {
  const keyId = process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID;
  const jwkB64 = process.env.CLOUDFLARE_STREAM_SIGNING_KEY;

  if (!keyId?.trim() || !jwkB64?.trim()) {
    return null;
  }

  return { keyId: keyId.trim(), jwkB64: jwkB64.trim() };
}

export function isStreamSigningKeyConfigured(): boolean {
  return getStreamSigningKey() !== null;
}

/**
 * Creates a signing key via the Stream API (admin, once). Returns the raw
 * response fields — the caller stores them in server-side secret storage;
 * they are NEVER logged or returned to any client.
 */
export async function createStreamSigningKey(): Promise<StreamSigningKey | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId?.trim() || !apiToken?.trim()) {
    return null;
  }

  try {
    const response = await fetch(`${STREAM_API_BASE}/accounts/${accountId}/stream/keys`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiToken}` },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      success?: boolean;
      result?: { id?: string; jwk?: string };
    };

    if (!payload.success || !payload.result?.id || !payload.result?.jwk) {
      return null;
    }

    return { keyId: payload.result.id, jwkB64: payload.result.jwk };
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function jsonToBase64Url(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Signs a short-lived playback token for the given live input.
 * Returns null on any failure — callers must fail closed (never fall back
 * to an unsigned URL).
 */
export async function signPlaybackToken(liveInputId: string): Promise<string | null> {
  const key = getStreamSigningKey();
  if (!key) {
    return null;
  }

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", kid: key.keyId };
    const payload = {
      sub: liveInputId,
      kid: key.keyId,
      exp: nowSeconds + LIVE_PLAYBACK_TOKEN_TTL_SECONDS,
      nbf: nowSeconds - 5,
    };

    const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;

    const jwk = JSON.parse(new TextDecoder().decode(base64UrlDecode(key.jwkB64))) as JsonWebKey;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      cryptoKey,
      new TextEncoder().encode(signingInput),
    );

    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  } catch {
    return null;
  }
}
