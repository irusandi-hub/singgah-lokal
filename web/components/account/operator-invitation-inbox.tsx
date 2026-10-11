"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LIVE_OPERATOR_INVITATION_STATUS_LABELS,
  liveOperatorInvitationMessage,
  type LiveOperatorInvitationStatus,
} from "@/lib/live/operator-invitations-model";
import { ErrorState, Section, StatusBadge, StatusMessage, btn, metaTextClass } from "@/components/ui/kit";

/**
 * UNDANGAN OPERATOR LIVE — the INVITEE side, inside the EXISTING notification
 * page (no second inbox, no new navigation entry).
 *
 * The list is the caller's OWN invitations from the existing endpoint
 * (`GET /api/live-operator-invitations`, scoped to auth.uid() by the RPC), and
 * every row names the Place and the inviting manager — both come from the
 * server, never from client state.
 *
 * "Terima" and "Tolak" call the REAL endpoints. The row only changes when the
 * SERVER confirms: a success message reports what the server did, and a failure
 * keeps the invitation actionable with the server's own Indonesian reason
 * (expired, cancelled, invalid, forbidden). Because the invitation can expire or
 * be cancelled while the page is open, the accepted/rejected/expired outcomes are
 * all handled instead of assuming the tap succeeds.
 */

type Invitation = {
  id: string;
  placeId: string;
  placeName: string;
  invitedEmail: string;
  invitedByName: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
};

type RowFeedback = { message?: string; error?: string };

const STATUS_TONES: Readonly<
  Record<LiveOperatorInvitationStatus, "warning" | "positive" | "negative" | "neutral">
> = {
  pending: "warning",
  accepted: "positive",
  rejected: "negative",
  cancelled: "neutral",
  expired: "neutral",
  revoked: "negative",
};

function statusLabel(status: string): string {
  return (
    LIVE_OPERATOR_INVITATION_STATUS_LABELS[status as LiveOperatorInvitationStatus] ??
    status
  );
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function OperatorInvitationInbox() {
  const router = useRouter();
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, RowFeedback>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/live-operator-invitations", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => ({}))) as {
          invitations?: Invitation[];
        };
        if (cancelled) return;
        if (!response.ok) {
          setState("error");
          return;
        }
        setInvitations(payload.invitations ?? []);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function act(invitation: Invitation, action: "accept" | "reject") {
    if (busyId) return;
    setBusyId(invitation.id);
    setFeedback((current) => ({ ...current, [invitation.id]: {} }));
    try {
      const response = await fetch(
        `/api/live-operator-invitations/${encodeURIComponent(invitation.id)}/${action}`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setFeedback((current) => ({
          ...current,
          [invitation.id]: { error: liveOperatorInvitationMessage(payload.error) },
        }));
        return;
      }
      // Only the server's own confirmation flips the row.
      const nextStatus = action === "accept" ? "accepted" : "rejected";
      setInvitations((current) =>
        (current ?? []).map((row) =>
          row.id === invitation.id ? { ...row, status: nextStatus } : row,
        ),
      );
      setFeedback((current) => ({
        ...current,
        [invitation.id]: {
          message:
            action === "accept"
              ? `Undangan diterima. Kamu sekarang Operator Live untuk ${invitation.placeName}.`
              : `Undangan untuk ${invitation.placeName} ditolak.`,
        },
      }));
      // The Account & Access Center and the unread badge re-read the server.
      router.refresh();
    } catch {
      setFeedback((current) => ({
        ...current,
        [invitation.id]: {
          error: liveOperatorInvitationMessage("live_operator_invitation_unavailable"),
        },
      }));
    } finally {
      setBusyId(null);
    }
  }

  if (state === "loading") return null;

  if (state === "error") {
    return (
      <Section title="Undangan Operator Live">
        <ErrorState
          message={liveOperatorInvitationMessage("live_operator_invitation_unavailable")}
        />
      </Section>
    );
  }

  if (!invitations || invitations.length === 0) return null;

  const pending = invitations.filter((row) => row.status === "pending");
  const history = invitations.filter((row) => row.status !== "pending");

  return (
    <Section
      title="Undangan Operator Live"
      description="Undangan menjadi Operator Live untuk sebuah Tempat. Jawabanmu langsung diproses server."
    >
      <div className="grid gap-2">
        {pending.map((invitation) => {
          const row = feedback[invitation.id] ?? {};
          return (
            <div
              key={invitation.id}
              className="grid gap-2 rounded-2xl border border-brand-accent/30 bg-white px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-bold">
                    {invitation.placeName}
                  </span>
                  <span className={`mt-0.5 block break-words text-black/55 ${metaTextClass}`}>
                    Diundang oleh{" "}
                    {invitation.invitedByName ?? "Pengelola Tempat"} · berlaku sampai{" "}
                    {formatWhen(invitation.expiresAt)}
                  </span>
                </span>
                <StatusBadge tone={STATUS_TONES.pending}>
                  {statusLabel(invitation.status)}
                </StatusBadge>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void act(invitation, "accept")}
                  disabled={busyId === invitation.id}
                  className={btn.primary}
                >
                  {busyId === invitation.id ? "Memproses…" : "Terima"}
                </button>
                <button
                  type="button"
                  onClick={() => void act(invitation, "reject")}
                  disabled={busyId === invitation.id}
                  className={btn.secondary}
                >
                  Tolak
                </button>
              </div>
              {row.message ? <StatusMessage message={row.message} /> : null}
              {row.error ? <ErrorState message={row.error} /> : null}
            </div>
          );
        })}

        {pending.length === 0 ? (
          <p className={`text-black/55 ${metaTextClass}`}>
            Tidak ada undangan yang menunggu jawaban.
          </p>
        ) : null}

        {history.length > 0 ? (
          <details className="rounded-2xl border border-black/10 bg-white px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-black/70">
              Riwayat undangan ({history.length})
            </summary>
            <ul className="mt-2 grid gap-2">
              {history.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm">{invitation.placeName}</span>
                    <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                      {invitation.resolvedAt
                        ? `${statusLabel(invitation.status)} ${formatWhen(invitation.resolvedAt)}`
                        : statusLabel(invitation.status)}
                    </span>
                  </span>
                  <StatusBadge tone={STATUS_TONES[invitation.status as LiveOperatorInvitationStatus] ?? "neutral"}>
                    {statusLabel(invitation.status)}
                  </StatusBadge>
                  {(feedback[invitation.id]?.message || feedback[invitation.id]?.error) ? (
                    <span className={`w-full text-black/55 ${metaTextClass}`}>
                      {feedback[invitation.id]?.message ?? feedback[invitation.id]?.error}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Section>
  );
}
