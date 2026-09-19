import "server-only";

/**
 * Cloudflare Stream boundary (MASTER_LIVE_TECH §5).
 *
 * Fail-closed rules:
 * - Only server-side code may call Cloudflare.
 * - Credentials live in the server runtime environment only — never in the
 *   repository, chat, or client code (PO decision 2026-09-18).
 * - Recording must be hard-disabled at the provider (recording: false).
 * - On any misconfiguration or provider failure, callers receive null and the
 *   start flow refuses to create a Live session (fail closed).
 */

const STREAM_API_BASE = "https://api.cloudflare.com/client/v4";

export type LiveInputResult = {
  liveInputId: string;
  rtmpsUrl: string | null;
  srtUrl: string | null;
};

type CloudflareLiveInputResponse = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: {
    uid: string;
    rtmps?: { url?: string; streamKey?: string };
    srt?: { url?: string };
  };
};

export function getCloudflareStreamConfig(): { accountId: string; apiToken: string } | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId?.trim() || !apiToken?.trim()) {
    return null;
  }

  return { accountId, apiToken };
}

export function isCloudflareStreamConfigured(): boolean {
  return getCloudflareStreamConfig() !== null;
}

/**
 * Creates a Cloudflare Stream live input with recording hard-disabled.
 * Returns null on any failure (fail closed) — never throws to the caller,
 * never exposes keys, and never logs credential material.
 */
export async function createLiveInput(): Promise<LiveInputResult | null> {
  const config = getCloudflareStreamConfig();

  if (!config) {
    return null;
  }

  try {
    const response = await fetch(`${STREAM_API_BASE}/accounts/${config.accountId}/stream/live_inputs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recording: { mode: "off", requireSignedURLs: true },
        // 60-minute hard cap is enforced server-side; a static metadata
        // constraint for max duration is applied by the session sweeper.
        metadata: [{ key: "purpose", value: "singgah-lokal-live" }],
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as CloudflareLiveInputResponse;
    if (!payload.success || !payload.result?.uid) {
      return null;
    }

    return {
      liveInputId: payload.result.uid,
      rtmpsUrl: payload.result.rtmps?.url ?? null,
      srtUrl: payload.result.srt?.url ?? null,
    };
  } catch {
    // Network/parse failure: fail closed with no artifact.
    return null;
  }
}
