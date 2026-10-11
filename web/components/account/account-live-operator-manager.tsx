"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { AccountPlaceMembership } from "@/lib/account-memberships";
import {
  LIVE_OPERATOR_INVITATION_STATUS_LABELS,
  liveOperatorInvitationMessage,
  type LiveOperatorInvitationStatus,
} from "@/lib/live/operator-invitations-model";
import {
  ErrorState,
  Panel,
  StatusBadge,
  StatusMessage,
  btn,
  metaTextClass,
} from "@/components/ui/kit";

/**
 * KELOLA AKSES LIVE — delegated Live-operator management, inside the Account
 * Center's Akses section and therefore visible only to an owner/manager.
 *
 * Authority separation (locked, Authority Master §1/§6):
 * - Pengelola = the owner/manager membership this component is rendered for.
 * - Operator Live = an explicit delegated assignment for the EXACT Tempat
 *   chosen here. Producer membership NEVER implies it, and this surface NEVER
 *   offers a Tempat the account does not manage.
 *
 * Mobile layout (Tahap 3): the surface is COMPACT and split into subviews
 * instead of one long page —
 *   (a) the Tempat picker feeds everything below;
 *   (b) "Operator" shows the ACTIVE operators, who must be revoked through a
 *       confirmation dialog;
 *   (c) "Undangan" holds the invite form in its OWN collapsible block, apart
 *       from the lists, plus the pending invitations (cancellable) and history.
 *
 * The component only ever names Places handed to it by the server, delegates
 * every write to the existing routes (which re-derive authorization on the
 * server), and NEVER decides authorization itself: hiding a control is
 * presentation, and the API refuses an unauthorized call either way.
 *
 * Anti-enumeration is preserved in the UI: the invite form reports the same
 * result whatever the email is, because the server answers uniformly and never
 * reveals whether the email resolved to an account.
 */

type Props = {
  /** ONLY the Places this account is owner/manager of — never a wider list. */
  places: AccountPlaceMembership[];
};

type OperatorAssignment = {
  userId: string;
  username: string | null;
  grantedAt: string;
  revokedAt: string | null;
};

type PlaceInvitation = {
  id: string;
  placeId: string;
  placeName: string;
  invitedEmail: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
};

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

const INVITE_ACKNOWLEDGEMENT =
  "Undangan dicatat. Kalau email itu terdaftar, undangannya akan muncul di akun tersebut.";

function statusLabel(status: string): string {
  return (
    LIVE_OPERATOR_INVITATION_STATUS_LABELS[status as LiveOperatorInvitationStatus] ??
    status
  );
}

function statusTone(
  status: string,
): "warning" | "positive" | "negative" | "neutral" {
  return STATUS_TONES[status as LiveOperatorInvitationStatus] ?? "neutral";
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

async function loadOperators(placeId: string): Promise<OperatorAssignment[]> {
  const response = await fetch(
    `/api/account/live-operators?placeId=${encodeURIComponent(placeId)}`,
  );
  const payload = (await response.json().catch(() => ({}))) as {
    operators?: OperatorAssignment[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? "live_operator_list_unavailable");
  }
  return payload.operators ?? [];
}

async function loadInvitations(placeId: string): Promise<PlaceInvitation[]> {
  const response = await fetch(
    `/api/account/live-operators/invitations?placeId=${encodeURIComponent(placeId)}`,
  );
  const payload = (await response.json().catch(() => ({}))) as {
    invitations?: PlaceInvitation[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.error ?? "live_operator_invitation_unavailable",
    );
  }
  return payload.invitations ?? [];
}

export default function AccountLiveOperatorManager({ places }: Props) {
  const [selectedPlaceId, setSelectedPlaceId] = useState(places[0]?.placeId ?? "");
  const [view, setView] = useState<"operators" | "invitations">("operators");
  const [inviteOpen, setInviteOpen] = useState(false);

  const [operators, setOperators] = useState<OperatorAssignment[]>([]);
  const [invitations, setInvitations] = useState<PlaceInvitation[]>([]);
  // Starts LOADING whenever a Place exists, so the effect never has to set
  // state synchronously (react-hooks/set-state-in-effect).
  const [listState, setListState] = useState<"idle" | "loading" | "ready" | "error">(
    places.length > 0 ? "loading" : "idle",
  );
  const [listError, setListError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [actionState, setActionState] = useState<"idle" | "working">("idle");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<OperatorAssignment | null>(null);

  const selectedPlace = places.find((place) => place.placeId === selectedPlaceId);

  async function refresh(placeId: string) {
    const [nextOperators, nextInvitations] = await Promise.all([
      loadOperators(placeId),
      loadInvitations(placeId),
    ]);
    setOperators(nextOperators);
    setInvitations(nextInvitations);
    setListError(null);
    setListState("ready");
  }

  useEffect(() => {
    if (!selectedPlaceId) return;
    let cancelled = false;
    (async () => {
      try {
        const [nextOperators, nextInvitations] = await Promise.all([
          loadOperators(selectedPlaceId),
          loadInvitations(selectedPlaceId),
        ]);
        if (cancelled) return;
        setOperators(nextOperators);
        setInvitations(nextInvitations);
        setListError(null);
        setListState("ready");
      } catch (requestError) {
        if (cancelled) return;
        setListState("error");
        setListError(
          liveOperatorInvitationMessage(
            requestError instanceof Error ? requestError.message : undefined,
            "Daftar Operator Live tidak dapat dimuat.",
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPlaceId]);

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim();
    if (!value) {
      setActionState("idle");
      setActionMessage(null);
      setActionError(liveOperatorInvitationMessage("email_required"));
      return;
    }
    setActionState("working");
    setActionMessage(null);
    setActionError(null);
    try {
      const response = await fetch("/api/account/live-operators/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeId: selectedPlaceId, email: value }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setActionError(liveOperatorInvitationMessage(payload.error));
        return;
      }
      // Uniform acknowledgement: the UI must not imply whether the email
      // resolved to an account (the endpoint is deliberately non-enumerating).
      setEmail("");
      setInviteOpen(false);
      setView("invitations");
      setActionMessage(INVITE_ACKNOWLEDGEMENT);
      setListState("loading");
      await refresh(selectedPlaceId);
    } catch {
      setActionError(liveOperatorInvitationMessage("live_operator_invitation_unavailable"));
      setListState("ready");
    } finally {
      setActionState("idle");
    }
  }

  async function cancelInvitation(id: string) {
    setActionState("working");
    setActionMessage(null);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/account/live-operators/invitations/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setActionError(liveOperatorInvitationMessage(payload.error));
        return;
      }
      setActionMessage("Undangan dibatalkan.");
      setListState("loading");
      await refresh(selectedPlaceId);
    } catch {
      setActionError(liveOperatorInvitationMessage("live_operator_invitation_unavailable"));
      setListState("ready");
    } finally {
      setActionState("idle");
    }
  }

  async function confirmRevoke() {
    const target = revokeTarget;
    if (!target) return;
    setActionState("working");
    setActionMessage(null);
    setActionError(null);
    try {
      const response = await fetch("/api/account/live-operators", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: target.userId, placeId: selectedPlaceId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setActionError(
          liveOperatorInvitationMessage(
            payload.error,
            "Akses Operator Live gagal dicabut.",
          ),
        );
        return;
      }
      setRevokeTarget(null);
      setActionMessage("Akses Operator Live dicabut.");
      setListState("loading");
      await refresh(selectedPlaceId);
    } catch {
      setActionError("Akses Operator Live gagal dicabut.");
      setListState("ready");
    } finally {
      setActionState("idle");
    }
  }

  if (places.length === 0) return null;

  const active = operators.filter((row) => row.revokedAt === null);
  const revoked = operators.filter((row) => row.revokedAt !== null);
  const pending = invitations.filter((row) => row.status === "pending");
  const history = invitations.filter((row) => row.status !== "pending");

  return (
    <Panel className="grid gap-3">
      <div>
        <h3 className="text-sm font-bold">Kelola Akses Live</h3>
        <p className={`mt-1 text-black/55 ${metaTextClass}`}>
          Berikan atau cabut akses Operator Live untuk Tempat yang kamu kelola.
          Operator Live hanya dapat mengoperasikan Live untuk Tempat yang
          diberikan.
        </p>
      </div>

      <div className="grid gap-1.5">
        <label
          className="text-xs font-semibold text-black/70"
          htmlFor="live-operator-place"
        >
          Tempat
        </label>
        <select
          id="live-operator-place"
          value={selectedPlaceId}
          onChange={(event) => {
            setSelectedPlaceId(event.target.value);
            setListState("loading");
            setListError(null);
            setInviteOpen(false);
            setEmail("");
            setRevokeTarget(null);
            setActionMessage(null);
            setActionError(null);
          }}
          className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm"
        >
          {places.map((place) => (
            <option key={place.placeId} value={place.placeId}>
              {place.placeName}
            </option>
          ))}
        </select>
      </div>

      {/* Two subviews instead of one long list: the operator list and the
          invitation lifecycle never compete for the same screen. */}
      <div className="grid min-w-0 grid-cols-2 gap-1 rounded-full border border-black/10 bg-white p-1">
        <button
          type="button"
          aria-pressed={view === "operators"}
          onClick={() => setView("operators")}
          className={`min-w-0 rounded-full px-2 py-1.5 text-[11px] font-bold leading-tight transition ${
            view === "operators" ? "bg-brand-accent text-white" : "text-black/60"
          }`}
        >
          Operator ({active.length})
        </button>
        <button
          type="button"
          aria-pressed={view === "invitations"}
          onClick={() => setView("invitations")}
          className={`min-w-0 rounded-full px-2 py-1.5 text-[11px] font-bold leading-tight transition ${
            view === "invitations" ? "bg-brand-accent text-white" : "text-black/60"
          }`}
        >
          Undangan ({pending.length})
        </button>
      </div>

      {listState === "error" && listError ? <ErrorState message={listError} /> : null}
      {actionMessage ? <StatusMessage message={actionMessage} /> : null}
      {actionError ? <ErrorState message={actionError} /> : null}

      {view === "operators" ? (
        <div className="grid gap-2">
          <p className="text-xs font-semibold text-black/70">Operator aktif</p>
          {listState === "loading" ? (
            <p className={`text-black/55 ${metaTextClass}`} aria-busy="true">
              Memuat Operator Live…
            </p>
          ) : active.length === 0 ? (
            <p className={`text-black/55 ${metaTextClass}`}>
              Belum ada Operator Live aktif untuk Tempat ini.
            </p>
          ) : (
            <ul className="grid gap-2">
              {active.map((row) => (
                <li
                  key={row.userId}
                  className="grid gap-2 rounded-xl border border-black/10 bg-white px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-semibold">
                        {row.username ?? "Akun tanpa username"}
                      </span>
                      <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                        Diberikan {formatWhen(row.grantedAt)}
                      </span>
                    </span>
                    <StatusBadge tone="positive">Aktif</StatusBadge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        // Replacement path: accepting a new invitation revokes
                        // any other active operator for this Place (0048).
                        setInviteOpen(true);
                        setView("invitations");
                        setActionMessage(null);
                        setActionError(null);
                      }}
                      className={btn.compact}
                    >
                      Undang pengganti
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRevokeTarget(row);
                        setActionMessage(null);
                        setActionError(null);
                      }}
                      disabled={actionState === "working"}
                      className={btn.compact}
                    >
                      Cabut akses
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {revoked.length > 0 ? (
            <details className="rounded-xl border border-black/10 bg-white px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-black/70">
                Riwayat yang dicabut ({revoked.length})
              </summary>
              <ul className="mt-2 grid gap-2">
                {revoked.map((row) => (
                  <li key={row.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm">
                        {row.username ?? "Akun tanpa username"}
                      </span>
                      <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                        Dicabut {row.revokedAt ? formatWhen(row.revokedAt) : "—"}
                      </span>
                    </span>
                    <StatusBadge tone="negative">Dicabut</StatusBadge>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-3">
          {/* (b) the invite form lives in its OWN block, apart from the lists. */}
          <div className="rounded-xl border border-black/10 bg-white px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Undang Operator Live</span>
                <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                  Lewat email akun SINGGAH LOKAL yang terdaftar. Akun baru tidak
                  dibuat dari sini.
                </span>
              </span>
              <button
                type="button"
                aria-expanded={inviteOpen}
                onClick={() => {
                  setInviteOpen((open) => !open);
                  setActionError(null);
                }}
                className={btn.compact}
              >
                {inviteOpen ? "Tutup" : "Undang lewat email"}
              </button>
            </div>

            {inviteOpen ? (
              <form className="mt-3 grid gap-2" onSubmit={submitInvite}>
                <label
                  className="text-xs font-semibold text-black/70"
                  htmlFor="live-operator-invite-email"
                >
                  Email akun
                </label>
                <input
                  id="live-operator-invite-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="nama@email.com"
                  className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-black/30 focus:border-brand-accent focus:outline-none"
                />
                <p className={`text-black/45 ${metaTextClass}`}>
                  Isian ini tidak memberi tahu apakah email tersebut terdaftar
                  atau tidak.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={actionState === "working" || !email.trim()}
                    className={btn.primary}
                  >
                    {actionState === "working" ? "Mengirim…" : "Kirim undangan"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInviteOpen(false);
                      setEmail("");
                    }}
                    className={btn.secondary}
                  >
                    Batal
                  </button>
                </div>
              </form>
            ) : null}
          </div>

          <div className="grid gap-2">
            <p className="text-xs font-semibold text-black/70">Undangan menunggu</p>
            {listState === "loading" ? (
              <p className={`text-black/55 ${metaTextClass}`} aria-busy="true">
                Memuat undangan…
              </p>
            ) : pending.length === 0 ? (
              <p className={`text-black/55 ${metaTextClass}`}>
                Belum ada undangan yang menunggu jawaban untuk Tempat ini.
              </p>
            ) : (
              <ul className="grid gap-2">
                {pending.map((row) => (
                  <li
                    key={row.id}
                    className="grid gap-2 rounded-xl border border-black/10 bg-white px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-semibold">
                          {row.invitedEmail}
                        </span>
                        <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                          Dikirim {formatWhen(row.createdAt)} · berlaku sampai{" "}
                          {formatWhen(row.expiresAt)}
                        </span>
                      </span>
                      <StatusBadge tone={statusTone(row.status)}>
                        {statusLabel(row.status)}
                      </StatusBadge>
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => void cancelInvitation(row.id)}
                        disabled={actionState === "working"}
                        className={btn.compact}
                      >
                        Batalkan
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {history.length > 0 ? (
            <details className="rounded-xl border border-black/10 bg-white px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-black/70">
                Riwayat undangan ({history.length})
              </summary>
              <ul className="mt-2 grid gap-2">
                {history.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm">{row.invitedEmail}</span>
                      <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                        {row.resolvedAt
                          ? `${statusLabel(row.status)} ${formatWhen(row.resolvedAt)}`
                          : statusLabel(row.status)}
                      </span>
                    </span>
                    <StatusBadge tone={statusTone(row.status)}>
                      {statusLabel(row.status)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}

      {/* Revoking a delegated operator is irreversible from the UI, so it is
          confirmed explicitly — the action never fires on a single tap. */}
      {revokeTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-operator-title"
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-4">
            <h4 id="revoke-operator-title" className="text-sm font-bold">
              Cabut akses Operator Live?
            </h4>
            <p className={`mt-1.5 text-black/60 ${metaTextClass}`}>
              {revokeTarget.username ?? "Akun tanpa username"} tidak akan bisa
              mengoperasikan Live untuk {selectedPlace?.placeName ?? "Tempat ini"}{" "}
              lagi. Akses bisa diberikan kembali lewat undangan baru.
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setRevokeTarget(null)}
                className={btn.secondary}
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void confirmRevoke()}
                disabled={actionState === "working"}
                className={btn.primary}
              >
                {actionState === "working" ? "Mencabut…" : "Ya, cabut akses"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {listState === "idle" ? (
        <p className={`text-black/55 ${metaTextClass}`}>
          Pilih Tempat untuk melihat Operator Live.
        </p>
      ) : null}
    </Panel>
  );
}
