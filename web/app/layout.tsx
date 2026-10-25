import type { Metadata } from "next";
import type { ReactNode } from "react";
import { existsSync } from "node:fs";
import path from "node:path";
import { Geist_Mono, Poppins } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Brand typography (Master brand identity): Poppins is the app-wide typeface.
// Headings/brand/navigation use SemiBold; body stays Regular.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Master brand icons (Brand Identity package) are served from /public/brand/
// once the Creator places the files there; until then the default favicon is
// kept so the icon is always readable. No drawing, recoloring, or resizing of
// the master assets happens in code.
function brandIconMetadata(): Metadata["icons"] | undefined {
  // The dev/preview process cwd may be the repo root or the web/ package dir;
  // try both so the master icons are picked up in every runtime.
  const candidates = [
    path.join(process.cwd(), "public", "brand"),
    path.join(process.cwd(), "web", "public", "brand"),
  ];
  const brandDir = candidates.find((dir) =>
    existsSync(path.join(dir, "singgah-lokal-icon-512.png")),
  );
  if (!brandDir) return undefined;
  const favicon = path.join(brandDir, "singgah-lokal-favicon.ico");
  return {
    icon: existsSync(favicon)
      ? ["/brand/singgah-lokal-favicon.ico", "/brand/singgah-lokal-icon-512.png"]
      : "/brand/singgah-lokal-icon-512.png",
    apple: "/brand/singgah-lokal-icon-512.png",
  };
}

export const metadata: Metadata = {
  title: "SINGGAH LOKAL — Temukan cerita di balik tempat",
  description:
    "SINGGAH LOKAL: platform discovery tempat, cerita, experience, dan live — temukan cerita di balik tempat.",
  icons: brandIconMetadata(),
};

/**
 * PRECONNECT (perf, 2026-10-25). The Home map's basemap and the Place card
 * images are requested several seconds after the document arrives, and the
 * first OSM tile is the LCP element on mobile: its DNS + TCP + TLS setup used
 * to run entirely on top of that delay. Opening both connections while the JS
 * is still loading takes that setup off the critical path.
 *
 * Neither the tile nor the image request carries a `crossorigin` attribute
 * (Leaflet's `<img>` and next/image's plain `<img>`), so BOTH hints are
 * emitted without `crossOrigin` too — a mismatched hint would open a second,
 * unused connection instead of warming the one the request reuses.
 */
const TILE_ORIGIN = "https://tile.openstreetmap.org";

/** Origin of the public media host, taken from env — never hardcoded. */
function mediaOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const media = mediaOrigin();

  return (
    <html
      lang="id"
      className={`${geistMono.variable} ${poppins.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* React 19 hoists resource hints to <head> wherever they render. */}
        <link rel="preconnect" href={TILE_ORIGIN} />
        {media ? <link rel="preconnect" href={media} /> : null}
        {children}
      </body>
    </html>
  );
}
