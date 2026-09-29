"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The archive search form: ONE input, ONE key selector, ONE search button.
 *
 * Submitting navigates to `/admin/archives?key=…&q=…`, so the search is
 * shareable, survives a refresh, and is executed by the server component —
 * the same URL-state pattern the Place list's geo filter uses. No client
 * fetch, no client-side authorization logic.
 */

export const ARCHIVE_SEARCH_KEYS = ["placeId", "userId", "email", "claimId"] as const;

export type ArchiveSearchKey = (typeof ARCHIVE_SEARCH_KEYS)[number];

export const ARCHIVE_SEARCH_LABELS: Record<ArchiveSearchKey, string> = {
  placeId: "Place ID",
  userId: "Pengelola ID",
  email: "Email",
  claimId: "Claim ID",
};

export default function ClaimArchiveSearch({ searchKey }: { searchKey: ArchiveSearchKey }) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<ArchiveSearchKey>(searchKey);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    // An empty query means "clear the results" — a clean, shareable state.
    if (!trimmed) {
      router.push("/admin/archives");
      return;
    }
    if (pendingKey === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Masukkan email yang valid.");
      return;
    }
    if (pendingKey !== "email" && pendingKey !== "placeId" && !/^[0-9a-fA-F-]{8,64}$/.test(trimmed)) {
      setError("ID harus berupa UUID yang valid.");
      return;
    }
    setError(null);
    router.push(`/admin/archives?key=${encodeURIComponent(pendingKey)}&q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <form
      role="search"
      onSubmit={submit}
      aria-label="Cari arsip klaim"
      className="rounded-2xl border border-black/10 bg-white p-5"
    >
      <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-semibold">
          Cari berdasarkan
          <select
            className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm font-normal"
            value={pendingKey}
            onChange={(event) => {
              setPendingKey(event.target.value as ArchiveSearchKey);
              setError(null);
            }}
          >
            {ARCHIVE_SEARCH_KEYS.map((key) => (
              <option key={key} value={key}>
                {ARCHIVE_SEARCH_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold">
          Kata kunci
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
            placeholder={`Masukkan ${ARCHIVE_SEARCH_LABELS[pendingKey]}…`}
            className="min-w-0 rounded-lg border border-black/10 px-3 py-2 text-sm font-normal"
          />
        </label>
        <button
          type="submit"
          className="justify-self-start rounded-full bg-brand-primary px-5 py-2.5 text-xs font-bold text-white transition hover:bg-brand-primary-deep sm:justify-self-end"
        >
          Cari
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-xs font-semibold text-red-800" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
