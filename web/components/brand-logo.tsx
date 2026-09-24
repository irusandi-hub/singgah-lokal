"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * SINGGAH LOKAL master logo (Brand Identity Guidelines).
 *
 * Renders the master asset from /public/brand/ exactly as-is: fixed ratio
 * via intrinsic width/height, object-contain, no effects, no recoloring, no
 * alternate lockups. While the asset files are not yet present in the repo,
 * the component falls back to the plain two-tone wordmark so no surface ever
 * shows a broken image; the moment the master files are placed in
 * web/public/brand/ the same component serves the real logo everywhere.
 */

const HORIZONTAL_SRC = "/brand/singgah-lokal-logo-horizontal.png";
const MARK_SRC = "/brand/singgah-lokal-logo-mark.png";

// Intrinsic master dimensions (from the Brand Identity package). Only the
// rendered height varies; the ratio stays fixed so nothing can stretch.
const HORIZONTAL_W = 660;
const HORIZONTAL_H = 160;
const MARK_W = 512;
const MARK_H = 512;

type BrandLogoProps = {
  /** Rendered height in px of the horizontal lockup. */
  height?: number;
  /** Prefer the compact mark (mobile / tight spaces). */
  variant?: "horizontal" | "mark";
  /** Shown only in the wordmark fallback (the master lockup has it baked in). */
  tagline?: string;
  className?: string;
};

function WordmarkFallback({ compact, tagline }: { compact: boolean; tagline?: string }) {
  return (
    <span className="inline-flex min-w-0 flex-col">
      <span
        className={`whitespace-nowrap font-semibold tracking-tight ${
          compact ? "text-base" : "text-xl"
        }`}
      >
        SINGGAH<span className="text-brand-accent"> LOKAL</span>
      </span>
      {tagline ? (
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-black/45">
          {tagline}
        </span>
      ) : null}
    </span>
  );
}

export default function BrandLogo({
  height = 40,
  variant = "horizontal",
  tagline,
  className = "",
}: BrandLogoProps) {
  const [failed, setFailed] = useState(false);
  const compact = variant === "mark";
  const src = compact ? MARK_SRC : HORIZONTAL_SRC;
  const width = compact ? Math.round((height * MARK_W) / MARK_H) : Math.round((height * HORIZONTAL_W) / HORIZONTAL_H);

  if (failed) {
    return <WordmarkFallback compact={compact} tagline={tagline} />;
  }

  return (
    <Image
      src={src}
      alt="SINGGAH LOKAL"
      width={width}
      height={height}
      className={`object-contain ${className}`}
      onError={() => setFailed(true)}
      priority
    />
  );
}
