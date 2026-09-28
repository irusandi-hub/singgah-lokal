"use client";

import { useId, useState } from "react";

/**
 * The one search field above an Admin list (PO, 2026-09-28).
 *
 * Fully client-side: typing narrows the ALREADY-LOADED canonical dataset in
 * memory — no navigation, no reload, no refetch. The dataset itself (its
 * order and its completeness) still comes from the server query; this box
 * only filters what the server already ordered.
 */
export default function AdminSearchBox({
  label,
  onSearch,
}: {
  label: string;
  onSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(query);
      }}
      className="max-w-full"
    >
      <label htmlFor={id} className="grid gap-1 text-sm font-semibold">
        {label}
      </label>
      <div className="mt-1 flex max-w-full min-w-0 flex-wrap items-center gap-2">
        <input
          id={id}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            onSearch(event.target.value);
          }}
          placeholder={label}
          className="min-w-0 flex-1 basis-52 rounded-lg border border-black/10 px-3 py-2 text-sm font-normal"
        />
      </div>
    </form>
  );
}

/** Case-insensitive substring match over the row's searchable values. */
export function rowMatches(query: string, values: Array<string | null>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => (value ?? "").toLowerCase().includes(needle));
}
