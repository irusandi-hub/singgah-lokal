import Link from "next/link";
import type { ReactNode } from "react";

/**
 * SHARED UI SYSTEM (UI/UX structure refactor, 2026-10-08).
 *
 * ONE compact system for every user-facing surface: page shell, page header,
 * sections, the one-surface panel, compact rows, and the shared state
 * presentations. Pages compose these instead of re-declaring their own
 * shell, their own heading scale, or their own card stack.
 *
 * Presentation only: no data fetching, no authorization, no product copy
 * invented here. Brand font (Poppins) is the app-wide typeface; the scale
 * below is the single hierarchy:
 *   page title  26px mobile → 32px larger screens
 *   section     17px, clearly smaller than the title
 *   body        14px
 *   metadata    12px
 *   eyebrow     11px uppercase, used sparingly
 */

/* ---------------------------------------------------------------- type scale */

export const pageTitleClass =
  "text-[26px] font-semibold leading-tight tracking-tight sm:text-[32px]";

export const sectionTitleClass = "text-[17px] font-semibold leading-snug tracking-tight";

export const bodyTextClass = "text-sm leading-6";

export const metaTextClass = "text-xs leading-5";

export const eyebrowClass = "text-[11px] font-bold uppercase tracking-[0.16em]";

/* ------------------------------------------------------------------- buttons */

/**
 * Four treatments only. One visually dominant action per section; everything
 * else is a compact secondary/ghost action so the page has ONE primary CTA.
 */
export const btn = {
  primary:
    "inline-flex items-center justify-center gap-1.5 rounded-full bg-brand-primary px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-primary-deep disabled:cursor-not-allowed disabled:opacity-50",
  solid:
    "inline-flex items-center justify-center gap-1.5 rounded-full bg-brand-ink px-4 py-2 text-sm font-bold text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "inline-flex items-center justify-center gap-1.5 rounded-full border border-black/12 bg-white px-4 py-2 text-sm font-bold text-black/70 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50",
  compact:
    "inline-flex items-center justify-center gap-1 rounded-full border border-black/12 bg-white px-3 py-1.5 text-xs font-bold text-black/70 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50",
  ghost:
    "inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-brand-accent transition hover:bg-brand-accent/10 disabled:opacity-50",
} as const;

export const backLinkClass =
  "inline-flex items-center gap-1 text-xs font-bold text-brand-accent transition hover:text-brand-primary";

/* ---------------------------------------------------------------------- tabs */

/**
 * ONE navigation layer for a working surface: a single row of equal-width tab
 * controls. Four items fit a phone width without horizontal scrolling and
 * without clipping a label — each item is equal width and its label wraps
 * inside its own cell rather than being cut off or pushed out of the viewport.
 */
export const tabListClass =
  "grid min-w-0 grid-cols-4 gap-1 rounded-full border border-black/10 bg-white p-1";

export const tabItemClass =
  "min-w-0 rounded-full px-1 py-1.5 text-center text-[11px] font-bold leading-tight transition sm:text-xs";

export const tabActiveClass = "bg-brand-accent text-white";

export const tabIdleClass = "text-black/60 hover:bg-black/[0.05]";

/* --------------------------------------------------------------------- shell */

const WIDTHS = { narrow: "max-w-xl", default: "max-w-3xl", wide: "max-w-5xl" } as const;

export function PageShell({
  width = "default",
  className = "",
  children,
}: {
  width?: keyof typeof WIDTHS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main className={`min-h-screen bg-brand-cream text-brand-ink ${className}`}>
      <div className={`mx-auto w-full px-4 py-5 sm:px-6 ${WIDTHS[width]}`}>{children}</div>
    </main>
  );
}

/**
 * ONE header per page: at most one contextual way back, one page title, one
 * short purpose line. No eyebrow is required — pass one only when it names a
 * real context (e.g. the Place you are working in).
 */
export function PageHeader({
  back,
  eyebrow,
  title,
  description,
  actions,
}: {
  back?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="border-b border-black/10 pb-4">
      {back ? <div className="mb-3">{back}</div> : null}
      {eyebrow ? <p className={`${eyebrowClass} text-brand-accent`}>{eyebrow}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className={`min-w-0 break-words ${pageTitleClass} ${eyebrow ? "mt-1" : ""}`}>{title}</h1>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {description ? (
        <p className={`mt-1.5 max-w-2xl text-black/60 ${bodyTextClass}`}>{description}</p>
      ) : null}
    </header>
  );
}

/** A named block inside the work area. Grouping by spacing, not by card. */
export function Section({
  title,
  description,
  action,
  className = "",
  children,
  accountCenterVocabulary,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
  accountCenterVocabulary?: boolean;
}) {
  return (
    <section className={`grid gap-3 ${className}`}>
      {title || action ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className={sectionTitleClass}>{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {description ? <p className={`-mt-1 text-black/55 ${metaTextClass}`}>{description}</p> : null}
      {children}
    </section>
  );
}

/**
 * Internal hook seam for future account-center label parity. The Producer surface
 * may pass the marker today; the parity layer that uses it is intentionally outside
 * this file so Section stays presentation-only.
 */
export function useAccountCenterVocabulary(marker?: boolean): boolean {
  return Boolean(marker);
}


/** The ONE surface a form or a work area sits on. Never nested in a card. */
export function Panel({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-2xl border border-black/10 bg-white p-4 sm:p-5 ${className}`}>{children}</div>
  );
}

/** A compact list row — the list unit everywhere instead of a large card. */
export function ListRow({
  href,
  leading,
  title,
  meta,
  trailing,
}: {
  href?: string;
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
}) {
  const inner = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-semibold">{title}</span>
        {meta ? <span className="mt-0.5 block text-xs text-black/55">{meta}</span> : null}
      </span>
      {trailing ?? <span aria-hidden className="text-black/30">›</span>}
    </>
  );
  const className =
    "flex w-full items-center gap-3 rounded-xl border border-black/10 bg-white px-3 py-2.5 text-left transition hover:bg-black/[0.02]";
  if (!href) {
    return <div className={className}>{inner}</div>;
  }
  return (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}

/* -------------------------------------------------------------------- states */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-black/15 bg-white px-4 py-5">
      <p className="text-sm font-semibold">{title}</p>
      {description ? <p className={`mt-1 text-black/55 ${metaTextClass}`}>{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: ReactNode }) {
  return (
    <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800" role="alert">
      {message}
    </p>
  );
}

export function StatusMessage({ message }: { message: ReactNode }) {
  return (
    <p className={`text-black/60 ${metaTextClass}`} role="status">
      {message}
    </p>
  );
}

export function LoadingState({ label = "Memuat…" }: { label?: string }) {
  return (
    <div className="grid gap-2" aria-busy="true" role="status">
      <span className="sr-only">{label}</span>
      <span className="h-4 w-1/3 animate-pulse rounded bg-black/[0.07]" />
      <span className="h-4 w-2/3 animate-pulse rounded bg-black/[0.05]" />
    </div>
  );
}

/* ------------------------------------------------------------------- badges */

const TONES = {
  neutral: "border-black/10 bg-black/[0.03] text-black/60",
  positive: "border-emerald-200 bg-emerald-50 text-emerald-800",
  negative: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  live: "border-live/40 bg-live/10 text-live",
  accent: "border-brand-accent/30 bg-brand-accent/10 text-brand-accent",
} as const;

/** A status appears ONCE, in its primary context, as a small badge. */
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <span className={`inline-block shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${TONES[tone]}`}>
      {children}
    </span>
  );
}
