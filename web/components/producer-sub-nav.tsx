import Link from "next/link";

/**
 * The ONE local navigation layer of the Producer area.
 *
 * It switches between the Producer's own functions (Dashboard, Tempat,
 * Permintaan Kunjungan, Live). The way back to the public home is NOT here:
 * every page owns exactly ONE contextual back link, so the escape path is not
 * repeated on every screen. Active state is URL-derived, so it stays correct
 * on refresh and direct URLs.
 */
const links = [
  { href: "/producer", label: "Dashboard" },
  { href: "/producer/places", label: "Tempat" },
  { href: "/producer/visit-intents", label: "Permintaan Kunjungan" },
  { href: "/producer/live", label: "Live" },
];

export default function ProducerSubNav({ active }: { active: string }) {
  return (
    <nav
      aria-label="Navigasi Pengelola"
      className="-mx-1 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {links.map(({ href, label }) => {
        const isActive = active === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
              isActive
                ? "bg-brand-accent text-white"
                : "border border-black/10 bg-white text-black/60 hover:bg-black/[0.04]"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
