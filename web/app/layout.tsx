import type { Metadata } from "next";
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
  const brandDir = path.join(process.cwd(), "public", "brand");
  const icon512 = path.join(brandDir, "singgah-lokal-icon-512.png");
  if (!existsSync(icon512)) return undefined;
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      className={`${geistMono.variable} ${poppins.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
