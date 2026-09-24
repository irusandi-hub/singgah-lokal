import Link from "next/link";

const links = [
  { href: "/producer", label: "Dashboard" },
  { href: "/producer/places", label: "Places" },
  { href: "/producer/visit-intents", label: "Visit Intent Inbox" },
  { href: "/producer/live", label: "Live" },
];

// Producer sub-navigation. Active state is URL-derived (route prop), so it
// stays correct on refresh and direct URLs. `dark` adapts it to the dark
// Producer surfaces (inbox).
export default function ProducerSubNav({ active, dark = false }: { active: string; dark?: boolean }) {
  return (
    <nav
      aria-label="Navigasi Producer"
      className={`flex flex-wrap items-center gap-2 border-b pb-4 ${dark ? "border-white/15" : "border-black/10"}`}
    >
      {links.map(({ href, label }) => {
        const isActive = active === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={`rounded-full px-4 py-2 text-xs font-bold transition ${
              isActive
                ? dark
                  ? "bg-brand-accent text-brand-ink"
                  : "bg-brand-accent text-white"
                : dark
                  ? "border border-white/20 bg-white/10 text-white/70 hover:bg-white/20"
                  : "border border-black/10 bg-white text-black/60 hover:bg-black/5"
            }`}
          >
            {label}
          </Link>
        );
      })}
      <Link
        href="/"
        className={`ml-auto rounded-full px-4 py-2 text-xs font-bold hover:bg-black/5 ${
          dark ? "text-brand-accent" : "text-brand-accent"
        }`}
      >
        ← Area user
      </Link>
    </nav>
  );
}
