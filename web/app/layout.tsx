import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "SINGGAH LOKAL — Temukan cerita di balik tempat",
  description:
    "SINGGAH LOKAL: platform discovery tempat, cerita, experience, dan live — temukan cerita di balik tempat.",
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
