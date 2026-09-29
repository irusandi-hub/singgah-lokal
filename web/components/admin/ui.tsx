import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Presentational building blocks for the Admin Center. No data fetching and
 * no authorization logic lives here — pages stay thin and every read is
 * server-side through lib/admin/queries.
 */

/**
 * The section back-link: up to Admin Center, the parent of every tab (PO,
 * 2026-09-28). The tab bar is the horizontal map, this is the way up — a
 * consistent text link, accent + underline + arrow, the same cue every other
 * navigational link in the Admin area uses. Pages that live DEEPER than a
 * tab (the Place workspace) render their own parent link above this one.
 */
export function AdminBackToAdminCenter(): ReactNode {
  return (
    <Link
      href="/admin"
      className="inline-flex items-center gap-1 text-xs font-bold text-brand-primary underline underline-offset-2 hover:text-brand-primary-deep"
    >
      <span aria-hidden>←</span> Kembali ke Admin Center
    </Link>
  );
}

export function AdminPageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="border-b border-black/10 pb-5">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-black/60">{description}</p>
    </header>
  );
}

export function AdminStatCards({ stats }: { stats: Array<{ label: string; value: number }> }) {
  return (
    <section aria-label="Statistik operasional" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map(({ label, value }) => (
        <div key={label} className="rounded-2xl border border-black/10 bg-white p-4">
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">{label}</div>
        </div>
      ))}
    </section>
  );
}

export type AdminColumn<Row> = {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
};

/**
 * The one Admin data surface (PO, 2026-09-28, reworked). ONE table, everywhere
 * — there is deliberately no second (card/list) presentation on a phone: the
 * same `<table>` carries every viewport, so the Admin always reads the same
 * columns on every device. The viewport is capped
 * at 75vh with INTERNAL scrolling (`max-h-[75vh] overflow-auto`): a long list
 * scrolls inside the table instead of pushing the page — and the page's other
 * panels — out of reach. The sticky head keeps the column labels visible
 * while that internal scroll happens.
 *
 * Cells keep `min-w-0` + `break-words`, so a long email, URL, or id wraps
 * inside its cell and can never widen a column past the phone frame —
 * combined with the wrapper's `max-w-full` the page gains no horizontal
 * overflow at 360/390px.
 *
 * Structure and authority are unchanged: same columns, same rows, same
 * renderers, pure presentational.
 */
export function AdminDataTable<Row>({ columns, rows, emptyMessage }: {
  columns: AdminColumn<Row>[];
  rows: readonly Row[];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-black/15 bg-white p-6 text-sm text-black/55">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="max-h-[75vh] max-w-full overflow-auto rounded-2xl border border-black/10 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-white">
          <tr className="border-b border-black/10">
            {columns.map(({ key, header }) => (
              <th key={key} scope="col" className="border-b border-black/10 bg-black/[0.02] px-4 py-3 text-[11px] font-bold uppercase tracking-[0.12em] text-black/45">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-black/5 last:border-b-0">
              {columns.map(({ key, render }) => (
                <td key={key} className="min-w-0 max-w-[16rem] px-4 py-3 align-top text-black/75 lg:max-w-xs">
                  <span className="block min-w-0 break-words">{render(row)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminErrorState({ message }: { message: string }) {
  return (
    <p className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm font-semibold text-red-800" role="alert">
      {message}
    </p>
  );
}

export function AdminStatusBadge({ value, tone = "neutral" }: { value: string; tone?: "neutral" | "positive" | "negative" | "warning" | "live" }) {
  const tones: Record<typeof tone, string> = {
    neutral: "border-black/10 bg-black/[0.03] text-black/60",
    positive: "border-emerald-200 bg-emerald-50 text-emerald-800",
    negative: "border-red-200 bg-red-50 text-red-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    live: "border-live/40 bg-live/10 text-live",
  };
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${tones[tone]}`}>
      {value}
    </span>
  );
}

export function formatAdminTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function formatShortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 11)}…`;
}
