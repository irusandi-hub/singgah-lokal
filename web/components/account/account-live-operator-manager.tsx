"use client";

import { useEffect, useState } from "react";
import type { AccountPlaceMembership } from "@/lib/account-memberships";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  StatusBadge,
  StatusMessage,
  btn,
  metaTextClass,
} from "@/components/ui/kit";

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

type LookupAccount = {
  userId: string;
  username: string | null;
};

const MESSAGES: Readonly<Record<string, string>> = {
  authentication_required: "Sesi berakhir. Masuk kembali untuk melanjutkan.",
  producer_authorization_required:
    "Kamu tidak mengelola Tempat ini, jadi tidak dapat mengubah akses Live-nya.",
  username_required: "Masukkan username akun yang ingin dicari.",
  account_lookup_unavailable: "Pencarian akun tidak tersedia saat ini.",
  live_operator_list_unavailable: "Daftar Operator Live tidak tersedia saat ini.",
  live_operator_grant_failed: "Gagal memberikan akses Operator Live.",
  live_operator_revoke_failed: "Gagal mencabut akses Operator Live.",
};

function messageFor(key: string | undefined, fallback: string): string {
  if (!key) return fallback;
  return MESSAGES[key] ?? fallback;
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

/**
 * KELOLA AKSES LIVE — delegated Live-operator management, inside the Account
 * Center's Akses section and therefore visible only to an owner/manager.
 *
 * Authority separation (locked, Authority Master §1/§6):
 * - Pengelola = the owner/manager membership this component is rendered for.
 * - Operator Live = an explicit ACTIVE `live_operators` assignment for the
 *   EXACT Tempat chosen here. Producer membership NEVER implies it, and this
 *   surface NEVER grants it for a Tempat the account does not manage.
 * The component only ever names Places handed to it by the server (the
 * account's own owner/manager memberships) and delegates every write to the
 * server routes, which re-derive authorization on the server.
 */
export default function AccountLiveOperatorManager({ places }: Props) {
  const [selectedPlaceId, setSelectedPlaceId] = useState(places[0]?.placeId ?? "");
  const [assignments, setAssignments] = useState<OperatorAssignment[]>([]);
  // The list starts LOADING whenever a Place is available, so the effect never
  // has to set state synchronously (react-hooks/set-state-in-effect). The
  // loading state is otherwise set from event handlers, never from the effect.
  const [listState, setListState] = useState<"idle" | "loading" | "ready" | "error">(
    places.length > 0 ? "loading" : "idle",
  );
  const [listError, setListError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<LookupAccount | null>(null);
  const [lookupState, setLookupState] = useState<
    "idle" | "loading" | "found" | "empty" | "error"
  >("idle");
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [actionState, setActionState] = useState<"idle" | "working">("idle");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedPlace = places.find((place) => place.placeId === selectedPlaceId);

  /** Pure fetch: no setState, so effects can await it before updating state. */
  async function fetchOperators(placeId: string): Promise<OperatorAssignment[]> {
    const response = await fetch(
      `/api/account/live-operators?placeId=${encodeURIComponent(placeId)}`,
    );
    const payload = (await response.json()) as {
      operators?: OperatorAssignment[];
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error ?? "live_operator_list_unavailable");
    }
    return payload.operators ?? [];
  }

  useEffect(() => {
    if (!selectedPlaceId) return;
    let cancelled = false;
    (async () => {
      try {
        const operators = await fetchOperators(selectedPlaceId);
        if (!cancelled) {
          setAssignments(operators);
          setListError(null);
          setListState("ready");
        }
      } catch (requestError) {
        if (!cancelled) {
          setListState("error");
          setListError(
            messageFor(
              requestError instanceof Error ? requestError.message : undefined,
              "Daftar Operator Live tidak dapat dimuat.",
            ),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPlaceId]);

  async function runLookup() {
    const value = query.trim();
    if (!value) {
      setLookupState("error");
      setLookupError(MESSAGES.username_required);
      return;
    }
    setLookupState("loading");
    setLookupError(null);
    setLookup(null);
    try {
      const response = await fetch(
        `/api/account/lookup?username=${encodeURIComponent(value)}`,
      );
      const payload = (await response.json()) as {
        account?: LookupAccount | null;
        error?: string;
      };
      if (!response.ok) {
        setLookupState("error");
        setLookupError(messageFor(payload.error, "Pencarian akun gagal."));
        return;
      }
      if (!payload.account) {
        setLookupState("empty");
        return;
      }
      setLookup(payload.account);
      setLookupState("found");
    } catch {
      setLookupState("error");
      setLookupError("Pencarian akun gagal.");
    }
  }

  async function grant() {
    if (!lookup || !selectedPlaceId) return;
    setActionState("working");
    setActionMessage(null);
    setActionError(null);
    try {
      const response = await fetch("/api/account/live-operators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: lookup.userId, placeId: selectedPlaceId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setActionError(messageFor(payload.error, "Gagal memberikan akses."));
        return;
      }
      setActionMessage(
        `Akses Operator Live diberikan${selectedPlace ? ` untuk ${selectedPlace.placeName}` : ""}.`,
      );
      setListState("loading");
      const operators = await fetchOperators(selectedPlaceId);
      setAssignments(operators);
      setListError(null);
      setListState("ready");
    } catch {
      setActionError("Gagal memberikan akses.");
      setListState("ready");
    } finally {
      setActionState("idle");
    }
  }

  async function revoke(userId: string) {
    if (!selectedPlaceId) return;
    setActionState("working");
    setActionMessage(null);
    setActionError(null);
    try {
      const response = await fetch("/api/account/live-operators", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, placeId: selectedPlaceId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setActionError(messageFor(payload.error, "Gagal mencabut akses."));
        return;
      }
      setActionMessage("Akses Operator Live dicabut.");
      setListState("loading");
      const operators = await fetchOperators(selectedPlaceId);
      setAssignments(operators);
      setListError(null);
      setListState("ready");
    } catch {
      setActionError("Gagal mencabut akses.");
      setListState("ready");
    } finally {
      setActionState("idle");
    }
  }

  if (places.length === 0) return null;

  const active = assignments.filter((row) => row.revokedAt === null);
  const revoked = assignments.filter((row) => row.revokedAt !== null);

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
            setLookup(null);
            setLookupState("idle");
            setActionMessage(null);
            setActionError(null);
          }}
          className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm"
        >
          {places.map((place) => (
            <option key={place.placeId} value={place.placeId}>
              {place.placeName}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-2">
        <p className="text-xs font-semibold text-black/70">Operator aktif</p>
        {listState === "loading" ? (
          <LoadingState label="Memuat Operator Live…" />
        ) : listState === "error" && listError ? (
          <ErrorState message={listError} />
        ) : active.length === 0 ? (
          <p className={`text-black/55 ${metaTextClass}`}>
            Belum ada Operator Live aktif untuk Tempat ini.
          </p>
        ) : (
          <ul className="grid gap-2">
            {active.map((row) => (
              <li
                key={row.userId}
                className="flex items-center gap-3 rounded-xl border border-black/10 bg-white px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-semibold">
                    {row.username ?? "Akun tanpa username"}
                  </span>
                  <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                    Diberikan {formatWhen(row.grantedAt)}
                  </span>
                </span>
                <StatusBadge tone="positive">Aktif</StatusBadge>
                <button
                  type="button"
                  onClick={() => revoke(row.userId)}
                  disabled={actionState === "working"}
                  className={btn.compact}
                >
                  Cabut
                </button>
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
                <li key={row.userId} className="flex items-center gap-3">
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

      <div className="grid gap-2 border-t border-black/10 pt-3">
        <label
          className="text-xs font-semibold text-black/70"
          htmlFor="live-operator-lookup"
        >
          Cari akun SINGGAH LOKAL (username)
        </label>
        <div className="flex gap-2">
          <input
            id="live-operator-lookup"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="username"
            className="flex-1 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-black/30 focus:border-brand-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={runLookup}
            disabled={lookupState === "loading" || !query.trim()}
            className={btn.secondary}
          >
            {lookupState === "loading" ? "Mencari…" : "Cari"}
          </button>
        </div>
        <p className="text-[11px] text-black/45">
          Hanya akun yang sudah ada yang dapat ditambahkan. Pencarian mencocokkan
          username secara persis; tidak ada daftar pengguna publik.
        </p>

        {lookupState === "empty" ? (
          <StatusMessage message="Tidak ada akun dengan username tersebut." />
        ) : null}

        {lookupState === "error" && lookupError ? (
          <ErrorState message={lookupError} />
        ) : null}

        {lookup ? (
          <div className="flex items-center gap-3 rounded-xl border border-brand-accent/25 bg-brand-accent/5 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-semibold">
                {lookup.username ?? "Akun tanpa username"}
              </span>
              <span className={`mt-0.5 block text-black/55 ${metaTextClass}`}>
                {lookup.username
                  ? "Akun SINGGAH LOKAL — belum tentu Operator Live."
                  : "Akun ini belum memiliki username publik."}
              </span>
            </span>
            <button
              type="button"
              onClick={grant}
              disabled={actionState === "working"}
              className={btn.primary}
            >
              Beri akses
            </button>
          </div>
        ) : null}

        {actionMessage ? <StatusMessage message={actionMessage} /> : null}
        {actionError ? <ErrorState message={actionError} /> : null}
      </div>

      {listState === "idle" ? (
        <EmptyState title="Pilih Tempat untuk melihat Operator Live." />
      ) : null}
    </Panel>
  );
}
