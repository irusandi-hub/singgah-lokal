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
 * The one Admin data surface (PO, 2026-09-28).
 *
 * Desktop keeps the table it always had. Below `sm` the same rows re-render
 * as stacked field cards: each value keeps its column header as a label, so
 * nothing depends on side-by-side columns being readable. The old wrapper
 * forced `min-w-[640px]` inside an `overflow-x-auto` scroll area — on a phone
 * that meant every wide table left the frame and columns were cut off; there
 * is deliberately no horizontal scroll and no forced minimum width anymore.
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
    <>
      {/* Mobile: one card per row, every field labelled. Long values wrap —
          break-words keeps a long URL or id from pushing the card wide. */}
      <ul className="grid gap-3 sm:hidden">
        {rows.map((row, index) => (
          <li key={index} className="rounded-2xl border border-black/10 bg-white p-4">
            <dl className="grid gap-2">
              {columns.map(({ key, header, render }) => (
                <div key={key} className="grid gap-0.5">
                  <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-black/45">{header}</dt>
                  <dd className="min-w-0 break-words text-sm text-black/75">{render(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {/* Desktop: the unchanged table. */}
      <div className="hidden overflow-x-auto rounded-2xl border border-black/10 bg-white sm:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-black/10 bg-black/[0.02]">
              {columns.map(({ key, header }) => (
                <th key={key} scope="col" className="px-4 py-3 text-[11px] font-bold uppercase tracking-[0.12em] text-black/45">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-black/5 last:border-b-0">
                {columns.map(({ key, render }) => (
                  <td key={key} className="max-w-[16rem] px-4 py-3 align-top text-black/75 lg:max-w-xs">
                    <span className="block break-words">{render(row)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
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
