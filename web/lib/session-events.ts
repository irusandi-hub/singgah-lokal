/**
 * Sign-out (and future sign-in) broadcasts a same-document event so every
 * live component showing auth state re-probes immediately. The event carries
 * no payload — components verify against /api/auth/session themselves.
 */
export const SESSION_CHANGED_EVENT = "singgah:session-changed";

export function broadcastSessionChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}
