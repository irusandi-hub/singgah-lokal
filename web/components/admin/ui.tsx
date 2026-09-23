import type { ReactNode } from "react";

/**
 * Presentational building blocks for the Admin Center. No data fetching and
 * no authorization logic lives here — pages stay thin and every read is
 * server-side through lib/admin/queries.
 */

export function AdminPageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="border-b border-black/10 pb-5">
      <h2 className="text-2xl font-black tracking-tight">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-black/60">{description}</p>
    </header>
  );
}

export function AdminStatCards({ stats }: { stats: Array<{ label: string; value: number }> }) {
  return (
    <section aria-label="Statistik operasional" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map(({ label, value }) => (
        <div key={label} className="rounded-2xl border border-black/10 bg-white p-4">
          <div className="text-2xl font-black tabular-nums">{value}</div>
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
    <div className="overflow-x-auto rounded-2xl border border-black/10 bg-white">
      <table className="w-full min-w-[640px] text-left text-sm">
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
                <td key={key} className="px-4 py-3 align-top text-black/75">
                  {render(row)}
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
    live: "border-[#b3261e]/40 bg-[#b3261e]/10 text-[#b3261e]",
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
