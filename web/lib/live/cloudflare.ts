import "server-only";

/**
 * Cloudflare Stream boundary (MASTER_LIVE_TECH §5, amended Policy §12.4).
 *
 * Ingest: WebRTC/WHIP. Playback: WHEP (Cloudflare does not support HLS/DASH
 * playback for WHIP-published inputs — provider limitation).
 *
 * Fail-closed rules:
 * - Only server-side code may call Cloudflare.
 * - Credentials live in the server runtime environment only — never in the
 *   repository, chat, or client code (PO decision 2026-09-18).
 * - Recording must be hard-disabled at the provider (recording mode "off").
 * - The WHIP publish URL is secret-bearing (provider docs: "treat it like a
 *   stream key") — it is issued ONLY to the authorized Producer's own start
 *   response, never persisted, never logged.
 * - On any misconfiguration or provider failure, callers receive null and the
 *   start flow refuses to create a Live session (fail closed).
 */

const STREAM_API_BASE = "https://api.cloudflare.com/client/v4";

export type LiveInputResult = {
  liveInputId: string;
  webRtcPublishUrl: string | null;
  webRtcPlaybackUrl: string | null;
};

export type LiveInputStatus = {
  connected: boolean;
  /** Raw provider status string, e.g. "connected" | "client_disconnect" | null. */
  raw: string | null;
};

type CloudflareLiveInputResponse = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: {
    uid: string;
    webRTC?: { url?: string };
    webRTCPlayback?: { url?: string };
    status?: string | null;
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
        // WebRTC/WHIP ingest (Policy §12.4): provider returns webRTC/webRTCPlayback URLs.
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
      webRtcPublishUrl: payload.result.webRTC?.url ?? null,
      webRtcPlaybackUrl: payload.result.webRTCPlayback?.url ?? null,
    };
  } catch {
    // Network/parse failure: fail closed with no artifact.
    return null;
  }
}

/**
 * Fetches a live input's current connection status (stream_healthy gate,
 * PO item 4). Returns null on any failure — callers must treat null as
 * "unknown" and fail closed.
 */
export async function getLiveInputStatus(liveInputId: string): Promise<LiveInputStatus | null> {
  const config = getCloudflareStreamConfig();

  if (!config) {
    return null;
  }

  try {
    const response = await fetch(
      `${STREAM_API_BASE}/accounts/${config.accountId}/stream/live_inputs/${liveInputId}`,
      {
        headers: { "Authorization": `Bearer ${config.apiToken}` },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as CloudflareLiveInputResponse;
    if (!payload.success || !payload.result) {
      return null;
    }

    const raw = payload.result.status ?? null;
    return { connected: raw === "connected" || raw === "reconnected" || raw === "reconnecting", raw };
  } catch {
    return null;
  }
}

/**
 * Re-reads the WHEP playback URL for an existing live input (issued per
 * admitted viewer via the playback route, never persisted server-side).
 * Returns null on any failure — callers fail closed.
 */
export async function getLiveInputPlaybackUrl(liveInputId: string): Promise<string | null> {
  const config = getCloudflareStreamConfig();

  if (!config) {
    return null;
  }

  try {
    const response = await fetch(
      `${STREAM_API_BASE}/accounts/${config.accountId}/stream/live_inputs/${liveInputId}`,
      {
        headers: { "Authorization": `Bearer ${config.apiToken}` },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as CloudflareLiveInputResponse;
    if (!payload.success || !payload.result) {
      return null;
    }

    return payload.result.webRTCPlayback?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Re-reads the WHIP publish URL for an existing live input (issued per start,
 * never persisted server-side). Returns null on any failure.
 */
export async function getLiveInputPublishUrl(liveInputId: string): Promise<string | null> {
  const config = getCloudflareStreamConfig();

  if (!config) {
    return null;
  }

  try {
    const response = await fetch(
      `${STREAM_API_BASE}/accounts/${config.accountId}/stream/live_inputs/${liveInputId}`,
      {
        headers: { "Authorization": `Bearer ${config.apiToken}` },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as CloudflareLiveInputResponse;
    if (!payload.success || !payload.result) {
      return null;
    }

    return payload.result.webRTC?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Deletes a live input (cleanup / orphan handling, PO item 10). Best-effort:
 * returns false on failure without throwing — session state in Supabase stays
 * canonical regardless of provider cleanup outcome.
 */
export type LiveInputSummary = { uid: string; status: string | null };

/**
 * Lists live inputs marked with this app's metadata purpose (PO item 10
 * orphan sweep). Returns null on failure — callers fail closed and treat
 * null as "cannot sweep".
 */
export async function listAppLiveInputs(): Promise<LiveInputSummary[] | null> {
  const config = getCloudflareStreamConfig();

  if (!config) {
    return null;
  }

  try {
    const response = await fetch(
      `${STREAM_API_BASE}/accounts/${config.accountId}/stream/live_inputs?per_page=100`,
      {
        headers: { "Authorization": `Bearer ${config.apiToken}` },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      success?: boolean;
      result?: Array<{ uid?: string; status?: string | null; meta?: Record<string, string> | null }>;
    };

    if (!payload.success || !Array.isArray(payload.result)) {
      return null;
    }

    return payload.result
      .filter((input) => input.uid && input.meta?.purpose === "singgah-lokal-live")
      .map((input) => ({ uid: input.uid as string, status: input.status ?? null }));
  } catch {
    return null;
  }
}

/**
 * Deletes a live input (cleanup / orphan handling, PO item 10). Best-effort:
 * returns false on failure without throwing — session state in Supabase stays
 * canonical regardless of provider cleanup outcome.
 */
export async function deleteLiveInput(liveInputId: string): Promise<boolean> {
  const config = getCloudflareStreamConfig();

  if (!config) {
    return false;
  }

  try {
    const response = await fetch(
      `${STREAM_API_BASE}/accounts/${config.accountId}/stream/live_inputs/${liveInputId}`,
      {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${config.apiToken}` },
        cache: "no-store",
      },
    );

    return response.ok;
  } catch {
    return false;
  }
}
