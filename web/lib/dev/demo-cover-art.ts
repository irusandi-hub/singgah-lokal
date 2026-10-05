/**
 * DEV-ONLY DEMO COVER ART (2026-10-05).
 *
 * ⚠ DEV ONLY — DO NOT USE IN PRODUCTION.
 *
 * This module draws the artwork used by the DEV demo-media seed
 * (`scripts/seed-dev-demo-media.ts`). It exists so the DEV Home/Discovery
 * surfaces can show real image content without pretending to be a real
 * Producer's photography:
 *
 * - every image is a flat, generated illustration — never a photograph, and
 *   never presented as a verified real Place;
 * - every image carries a visible DEMO badge and an explicit caption, so the
 *   content can never be mistaken for Producer-owned media;
 * - the motif is chosen from the Place's OWN name/description/category, so
 *   the artwork matches what the demo Place claims to be.
 *
 * No product data, media contract, or rendering rule lives here: this is a
 * DEV data-generation helper only.
 */

export const DEMO_COVER_WIDTH = 1200;
export const DEMO_COVER_HEIGHT = 750;

/** Craft motifs the demo artwork can draw. */
export type DemoMotif =
  | "soup-bowl"
  | "corn"
  | "leaf-wrapped"
  | "tofu"
  | "bamboo"
  | "batik"
  | "weaving"
  | "lantern"
  | "herbs"
  | "seedling"
  | "palm-sugar"
  | "coffee"
  | "tea"
  | "kitchen-pot"
  | "clay"
  | "timber"
  | "tools"
  | "honey"
  | "grain"
  | "spice"
  | "seafood"
  | "soap"
  | "glassware"
  | "leather"
  | "wheel"
  | "flower"
  | "workshop";

type MotifRule = { motif: DemoMotif; keywords: string[] };

/**
 * Keyword → motif resolution. Order matters: the first matching rule wins, so
 * the more specific craft words are listed before the broader ones.
 */
const MOTIF_RULES: MotifRule[] = [
  { motif: "soup-bowl", keywords: ["bakso", "soup", "noodle", "mie", "meatball", "kuah"] },
  { motif: "corn", keywords: ["jagung", "corn", "gandum", "grain-mill"] },
  { motif: "leaf-wrapped", keywords: ["tempe", "panggang", "baking"] },
  { motif: "tofu", keywords: ["tahu", "tofu", "sari kedelai", "soy"] },
  { motif: "batik", keywords: ["batik"] },
  { motif: "weaving", keywords: ["tenun", "weav", "tekstil", "textile", "kain", "fabric", "jahit"] },
  // Lantern BEFORE bamboo: "anyaman bambu dan lentera" is a lantern Place that
  // happens to mention bamboo, and the specific craft must win.
  { motif: "lantern", keywords: ["lentera", "lantern", "anyaman", "dekorasi"] },
  { motif: "bamboo", keywords: ["bambu", "bamboo", "rotan", "rattan"] },
  { motif: "herbs", keywords: ["obat", "herbal", "herb", "tanaman obat", "jamu", "aroma", "spice"] },
  { motif: "seedling", keywords: ["bibit", "nursery", "seed", "semai", "sayur", "vegetable", "fruit"] },
  { motif: "palm-sugar", keywords: ["gula aren", "palm sugar", "aren", "gula"] },
  { motif: "coffee", keywords: ["kopi", "coffee", "roast"] },
  { motif: "tea", keywords: ["teh", "tea", "minuman"] },
  { motif: "seafood", keywords: ["seafood", "ikan", "fish", "udang", "pantai", "coastal", "salt"] },
  { motif: "clay", keywords: ["clay", "tanah liat", "ceramic", "kaca", "glass", "pottery", "gerabah"] },
  { motif: "timber", keywords: ["wood", "kayu", "woodcraft", "furniture", "tukang"] },
  { motif: "tools", keywords: ["metal", "besi", "tool", "perbaikan", "repair", "service", "sepeda", "bicycle", "tali", "rope"] },
  { motif: "honey", keywords: ["honey", "madu", "bees", "lebah"] },
  { motif: "grain", keywords: ["desert grain", "date", "kismis", "olive", "zaitun", "sawit", "palm"] },
  { motif: "soap", keywords: ["soap", "sabun", "bath", "mandi"] },
  { motif: "leather", keywords: ["leather", "kulit", "paper", "kertas"] },
  { motif: "spice", keywords: ["rempah", "spice", "blend", "cabai", "bumbu"] },
  { motif: "flower", keywords: ["flower", "bunga", "tanaman", "garden", "panen", "harvest"] },
  { motif: "kitchen-pot", keywords: ["dapur", "kitchen", "masak", "cook", "food", "makanan", "bakery", "roti"] },
];

/**
 * Resolve the motif for a demo Place from its own canonical fields. Falls back
 * to the generic workshop motif, never to nothing.
 */
export function resolveDemoMotif(place: {
  name: string;
  shortDescription?: string | null;
  category?: string | null;
}): DemoMotif {
  const haystack = [place.name, place.shortDescription ?? "", place.category ?? ""].join(" ").toLowerCase();
  for (const rule of MOTIF_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) return rule.motif;
  }
  return "workshop";
}

const PALETTE = {
  cream: "#f6f3eb",
  paper: "#ffffff",
  ink: "#20231f",
  muted: "#6f716d",
  green: "#0e6b4f",
  greenDeep: "#0a5640",
  greenSoft: "#6b8f72",
  accent: "#c89b6b",
  accentSoft: "#e6d3ba",
  line: "#ded8c9",
} as const;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Greedy wrap so a long Place name never runs past the right margin. */
function wrap(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  return lines.slice(0, maxLines);
}

/** Each motif draws into a 380x380 box centred on (0,0). */
function motifArt(motif: DemoMotif): string {
  const g = PALETTE.green;
  const deep = PALETTE.greenDeep;
  const soft = PALETTE.greenSoft;
  const accent = PALETTE.accent;

  switch (motif) {
    case "soup-bowl":
      return `
        <path d="M-150 -40 q10 -46 34 -22 q14 -52 34 -6 q22 -44 34 4 q26 -34 30 14 q26 -12 22 26" fill="none" stroke="${soft}" stroke-width="9" stroke-linecap="round" opacity="0.8"/>
        <path d="M-150 -30 h300 a150 150 0 0 1 -300 0 z" fill="${g}"/>
        <rect x="-150" y="-34" width="300" height="20" rx="10" fill="${deep}"/>
        <circle cx="-70" cy="-70" r="34" fill="${accent}"/>
        <circle cx="10" cy="-84" r="38" fill="${PALETTE.accentSoft}"/>
        <circle cx="86" cy="-64" r="30" fill="${accent}"/>`;
    case "corn":
      return `
        <g>
          ${[-90, 0, 90]
            .map(
              (x, index) => `<g transform="translate(${x} ${index === 1 ? -20 : 0}) rotate(${index === 1 ? 0 : index === 0 ? -10 : 10})">
                <ellipse cx="0" cy="0" rx="34" ry="86" fill="${index === 1 ? accent : g}"/>
                ${Array.from({ length: 5 }, (_, row) =>
                  Array.from(
                    { length: 3 },
                    (_, col) =>
                      `<circle cx="${-18 + col * 18}" cy="${-56 + row * 28}" r="7" fill="${index === 1 ? PALETTE.accentSoft : PALETTE.greenSoft}" opacity="0.85"/>`,
                  ).join(""),
                ).join("")}
                <path d="M0 -86 q46 -26 58 -70 q-40 8 -58 40 z" fill="${soft}"/>
              </g>`,
            )
            .join("")}
        </g>`;
    case "leaf-wrapped":
      return `
        <path d="M-140 -50 h280 a26 26 0 0 1 26 26 v150 a26 26 0 0 1 -26 26 h-280 a26 26 0 0 1 -26 -26 v-150 a26 26 0 0 1 26 -26 z" fill="${g}"/>
        <path d="M-140 -50 h280 v58 h-280 z" fill="${deep}"/>
        <rect x="-150" y="140" width="300" height="26" rx="13" fill="${soft}"/>
        ${Array.from({ length: 4 }, (_, i) => `<rect x="${-110 + i * 62}" y="16" width="46" height="90" rx="14" fill="${i % 2 ? PALETTE.accentSoft : PALETTE.accent}"/>`).join("")}
        <path d="M-160 -70 q80 -66 160 -12 q-78 62 -160 12 z" fill="${soft}"/>`;
    case "tofu":
      return `
        <rect x="-140" y="-60" width="150" height="140" rx="18" fill="${PALETTE.paper}" stroke="${soft}" stroke-width="6"/>
        <rect x="10" y="-30" width="130" height="130" rx="18" fill="${PALETTE.accentSoft}" stroke="${accent}" stroke-width="6"/>
        <rect x="-80" y="50" width="120" height="110" rx="18" fill="${g}"/>
        <rect x="-118" y="-38" width="106" height="20" rx="10" fill="${deep}" opacity="0.25"/>`;
    case "bamboo":
      return `
        ${[-100, 0, 100]
          .map(
            (x, i) => `<g transform="translate(${x} 0)">
              <rect x="-30" y="-150" width="60" height="300" rx="26" fill="${i === 1 ? g : soft}"/>
              ${Array.from({ length: 4 }, (_, k) => `<rect x="-30" y="${-116 + k * 76}" width="60" height="12" rx="6" fill="${PALETTE.cream}" opacity="0.85"/>`).join("")}
            </g>`,
          )
          .join("")}
        <path d="M60 -150 q90 -50 150 -20 q-80 40 -150 20 z" fill="${accent}"/>
        <path d="M-40 -150 q-90 -46 -146 -14 q76 36 146 14 z" fill="${PALETTE.accentSoft}"/>`;
    case "batik":
      return `
        <rect x="-140" y="-150" width="280" height="300" rx="24" fill="${g}"/>
        ${Array.from({ length: 5 }, (_, row) =>
          Array.from(
            { length: 4 },
            (_, col) =>
              `<path d="M${-120 + col * 72} ${-120 + row * 72} l40 22 l-40 22 l-40 -22 z" fill="${(row + col) % 2 ? accent : PALETTE.accentSoft}" opacity="0.95"/>`,
          ).join(""),
        ).join("")}
        <rect x="-140" y="-150" width="280" height="300" rx="24" fill="none" stroke="${deep}" stroke-width="8"/>`;
    case "weaving":
      return `
        <rect x="-150" y="-130" width="300" height="260" rx="20" fill="none" stroke="${deep}" stroke-width="12"/>
        ${Array.from({ length: 8 }, (_, i) => `<rect x="${-136 + i * 38}" y="-130" width="18" height="260" fill="${i % 2 ? soft : g}"/>`).join("")}
        ${Array.from({ length: 7 }, (_, i) => `<rect x="-150" y="${-118 + i * 38}" width="300" height="18" fill="${i % 2 ? accent : PALETTE.accentSoft}" opacity="0.9"/>`).join("")}
        <path d="M-30 -10 l120 -46 l0 92 z" fill="${deep}"/>`;
    case "lantern":
      return `
        <ellipse cx="0" cy="20" rx="120" ry="150" fill="${accent}"/>
        <ellipse cx="0" cy="20" rx="120" ry="150" fill="none" stroke="${deep}" stroke-width="8"/>
        <rect x="-56" y="-150" width="112" height="28" rx="10" fill="${deep}"/>
        <rect x="-56" y="160" width="112" height="26" rx="10" fill="${deep}"/>
        ${Array.from({ length: 5 }, (_, i) => `<rect x="${-120 + i * 48}" y="-120" width="14" height="280" fill="${g}" opacity="0.35"/>`).join("")}
        <path d="M-40 -150 q40 -70 80 0" fill="none" stroke="${soft}" stroke-width="10" stroke-linecap="round"/>`;
    case "herbs":
      return `
        <path d="M-110 40 h220 l-30 130 a24 24 0 0 1 -23 18 h-114 a24 24 0 0 1 -23 -18 z" fill="${g}"/>
        <rect x="-126" y="24" width="252" height="26" rx="13" fill="${deep}"/>
        ${[-70, 0, 70]
          .map(
            (x, i) => `<g transform="translate(${x} 20) rotate(${i === 0 ? -16 : i === 2 ? 16 : 0})">
              <rect x="-5" y="-150" width="10" height="160" rx="5" fill="${deep}"/>
              <ellipse cx="-34" cy="-90" rx="34" ry="18" fill="${soft}" transform="rotate(-24 -34 -90)"/>
              <ellipse cx="34" cy="-52" rx="34" ry="18" fill="${accent}" transform="rotate(24 34 -52)"/>
              <ellipse cx="-30" cy="-16" rx="30" ry="16" fill="${soft}" transform="rotate(-20 -30 -16)"/>
            </g>`,
          )
          .join("")}`;
    case "seedling":
      return `
        <rect x="-150" y="20" width="300" height="120" rx="20" fill="${g}"/>
        <rect x="-150" y="20" width="300" height="34" rx="17" fill="${deep}"/>
        ${[-95, 0, 95]
          .map(
            (x) => `<g transform="translate(${x} 20)">
              <rect x="-36" y="-34" width="72" height="40" rx="12" fill="${accent}"/>
              <rect x="-5" y="-70" width="10" height="40" rx="5" fill="${deep}"/>
              <path d="M0 -70 q-56 -22 -58 -66 q46 6 58 66 z" fill="${soft}"/>
              <path d="M0 -70 q56 -22 58 -66 q-46 6 -58 66 z" fill="${g}"/>
            </g>`,
          )
          .join("")}`;
    case "palm-sugar":
      return `
        <rect x="-16" y="-160" width="32" height="220" rx="14" fill="${deep}"/>
        ${[-1, 1].map((side) => `<path d="M0 -150 q${side * 150} -70 ${side * 170} -140 q-70 60 -170 140 z" fill="${soft}"/>`).join("")}
        <path d="M-120 40 h240 a30 30 0 0 1 30 30 v70 a30 30 0 0 1 -30 30 h-240 a30 30 0 0 1 -30 -30 v-70 a30 30 0 0 1 30 -30 z" fill="${accent}"/>
        <rect x="-150" y="30" width="300" height="30" rx="15" fill="${g}"/>
        <path d="M-70 180 q-20 44 10 66 M0 180 q-20 44 10 66 M70 180 q-20 44 10 66" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round"/>`;
    case "coffee":
      return `
        <path d="M-120 -40 h180 v90 a90 90 0 0 1 -180 0 z" fill="${PALETTE.paper}" stroke="${deep}" stroke-width="10"/>
        <path d="M60 -20 h40 a40 40 0 0 1 0 80 h-40" fill="none" stroke="${deep}" stroke-width="12"/>
        <ellipse cx="-30" cy="-40" rx="90" ry="20" fill="${deep}"/>
        <path d="M-110 -100 q30 -30 60 0 q30 -30 60 0" fill="none" stroke="${soft}" stroke-width="12" stroke-linecap="round"/>
        ${[-40, 40, 120].map((x, i) => `<g transform="translate(${x} ${110 + (i % 2) * 24}) rotate(${i * 30 - 30})"><ellipse rx="34" ry="24" fill="${g}"/><path d="M-34 0 q34 -14 68 0" fill="none" stroke="${PALETTE.cream}" stroke-width="7"/></g>`).join("")}`;
    case "tea":
      return `
        <path d="M-110 -10 h180 v110 a40 40 0 0 1 -40 40 h-100 a40 40 0 0 1 -40 -40 z" fill="${g}"/>
        <rect x="-130" y="-40" width="220" height="34" rx="17" fill="${deep}"/>
        <path d="M70 20 h40 a36 36 0 0 1 0 72 h-30" fill="none" stroke="${g}" stroke-width="14"/>
        <path d="M-60 -80 q-34 -34 4 -62 q34 -26 8 -58" fill="none" stroke="${soft}" stroke-width="12" stroke-linecap="round"/>
        <path d="M20 -70 q-34 -34 4 -62 q34 -26 8 -58" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round"/>
        <rect x="-160" y="150" width="320" height="26" rx="13" fill="${PALETTE.accentSoft}"/>`;
    case "kitchen-pot":
      return `
        <path d="M-130 -20 h260 v120 a30 30 0 0 1 -30 30 h-200 a30 30 0 0 1 -30 -30 z" fill="${soft}"/>
        <rect x="-150" y="-50" width="300" height="34" rx="17" fill="${deep}"/>
        <rect x="-140" y="130" width="280" height="26" rx="13" fill="${g}"/>
        <path d="M-70 -90 q-30 -40 6 -66 q32 -24 6 -60 M30 -84 q-30 -40 6 -66 q32 -24 6 -60" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round"/>
        <rect x="-170" y="-30" width="44" height="90" rx="20" fill="${g}"/>
        <rect x="126" y="-30" width="44" height="90" rx="20" fill="${g}"/>`;
    case "clay":
      return `
        <path d="M-90 -60 q-40 90 0 150 q40 60 90 60 q90 0 90 -210 z" fill="${accent}"/>
        <ellipse cx="0" cy="-60" rx="90" ry="26" fill="${deep}"/>
        <rect x="-150" y="150" width="300" height="30" rx="15" fill="${g}"/>
        <path d="M-30 -96 l30 -60 l30 60" fill="none" stroke="${soft}" stroke-width="12" stroke-linecap="round"/>
        ${[0, 1, 2].map((i) => `<rect x="${-140 + i * 110}" y="180" width="86" height="22" rx="11" fill="${i % 2 ? soft : g}"/>`).join("")}`;
    case "timber":
      return `
        <rect x="-150" y="-140" width="300" height="86" rx="18" fill="${accent}"/>
        <rect x="-150" y="-40" width="300" height="86" rx="18" fill="${g}"/>
        <rect x="-150" y="60" width="300" height="86" rx="18" fill="${soft}"/>
        ${[-90, 0, 90].map((x) => `<circle cx="${x}" cy="-97" r="14" fill="${PALETTE.cream}" opacity="0.7"/><circle cx="${x}" cy="3" r="14" fill="${PALETTE.cream}" opacity="0.7"/><circle cx="${x}" cy="103" r="14" fill="${PALETTE.cream}" opacity="0.7"/>`).join("")}`;
    case "tools":
      return `
        <path d="M-150 40 l90 -90 a40 40 0 0 1 56 56 l-90 90 a40 40 0 0 1 -56 -56 z" fill="${g}"/>
        <circle cx="-104" cy="-4" r="18" fill="${PALETTE.cream}"/>
        ${Array.from({ length: 8 }, (_, i) => `<rect x="${-30 + i * 26}" y="-140" width="16" height="120" rx="8" fill="${i % 2 ? soft : deep}"/>`).join("")}
        <circle cx="120" cy="80" r="76" fill="none" stroke="${accent}" stroke-width="20"/>
        <circle cx="120" cy="80" r="26" fill="${PALETTE.accentSoft}"/>`;
    case "honey":
      return `
        <path d="M-80 -110 h160 a26 26 0 0 1 26 26 v200 a40 40 0 0 1 -40 40 h-132 a40 40 0 0 1 -40 -40 v-200 a26 26 0 0 1 26 -26 z" fill="${accent}"/>
        <rect x="-96" y="-140" width="192" height="36" rx="18" fill="${deep}"/>
        <rect x="-70" y="-20" width="140" height="90" rx="16" fill="${PALETTE.accentSoft}"/>
        <path d="M-110 -160 l40 -70 M110 -160 l-40 -70" stroke="${deep}" stroke-width="16" stroke-linecap="round"/>
        <path d="M0 -170 l-22 40 h44 z" fill="${deep}"/>`;
    case "grain":
      return `
        ${[-80, 0, 80]
          .map(
            (x, i) => `<g transform="translate(${x} 150) rotate(${i === 0 ? -12 : i === 2 ? 12 : 0})">
              <rect x="-6" y="-230" width="12" height="230" rx="6" fill="${i === 1 ? deep : g}"/>
              ${[-160, -110, -60, -10, 40]
                .map((y) => `<ellipse cx="-22" cy="${y}" rx="20" ry="12" fill="${accent}" transform="rotate(-28 -22 ${y})"/><ellipse cx="22" cy="${y}" rx="20" ry="12" fill="${PALETTE.accentSoft}" transform="rotate(28 22 ${y})"/>`)
                .join("")}
            </g>`,
          )
          .join("")}`;
    case "spice":
      return `
        <path d="M-110 -40 h220 l-30 170 a26 26 0 0 1 -26 20 h-108 a26 26 0 0 1 -26 -20 z" fill="${soft}"/>
        <rect x="-140" y="-70" width="280" height="34" rx="17" fill="${g}"/>
        <rect x="-14" y="-190" width="28" height="140" rx="14" fill="${deep}" transform="rotate(18)"/>
        <circle cx="-30" cy="-70" r="18" fill="${accent}"/>
        <circle cx="20" cy="-76" r="14" fill="${PALETTE.accentSoft}"/>
        <circle cx="60" cy="-70" r="16" fill="${accent}"/>`;
    case "seafood":
      return `
        <path d="M-150 0 q90 -90 190 0 q-90 90 -190 0 z" fill="${g}"/>
        <path d="M40 0 l110 -70 v140 z" fill="${soft}"/>
        <circle cx="-40" cy="-8" r="16" fill="${PALETTE.cream}"/>
        <path d="M-150 0 q-60 -60 -70 -130 q70 40 90 130 q-20 90 -90 130 q10 -70 70 -130 z" fill="${accent}"/>
        <circle cx="-60" cy="-130" r="10" fill="${PALETTE.cream}" opacity="0.85"/>
        <circle cx="-10" cy="-158" r="8" fill="${PALETTE.cream}" opacity="0.85"/>`;
    case "soap":
      return `
        <rect x="-130" y="-30" width="180" height="110" rx="34" fill="${soft}"/>
        <rect x="-70" y="-140" width="180" height="110" rx="34" fill="${accent}"/>
        <rect x="-30" y="90" width="160" height="90" rx="34" fill="${g}"/>
        ${[
          [-110, -170, 16],
          [40, -190, 22],
          [130, -120, 14],
          [-60, 30, 18],
        ]
          .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${deep}" stroke-width="7" opacity="0.7"/>`)
          .join("")}`;
    case "glassware":
      return `
        <path d="M-70 -140 h140 l-24 120 a40 40 0 0 1 -30 30 h-32 a40 40 0 0 1 -30 -30 z" fill="${g}"/>
        <rect x="-60" y="20" width="120" height="150" rx="26" fill="${soft}"/>
        <rect x="-90" y="-160" width="180" height="30" rx="15" fill="${deep}"/>
        ${[40, 110].map((x, i) => `<circle cx="${x}" cy="${-160 - i * 40}" r="${12 + i * 6}" fill="none" stroke="${accent}" stroke-width="6" opacity="0.8"/>`).join("")}`;
    case "leather":
      return `
        <path d="M-120 -110 q60 -60 120 0 q60 60 120 0 l0 220 a30 30 0 0 1 -30 30 h-180 a30 30 0 0 1 -30 -30 z" fill="${accent}"/>
        <path d="M-120 -110 q60 60 120 0 q60 -60 120 0" fill="none" stroke="${deep}" stroke-width="10" stroke-dasharray="18 14"/>
        <rect x="-14" y="-190" width="28" height="90" rx="14" fill="${deep}" transform="rotate(24)"/>
        ${[40, 90, 140].map((y) => `<rect x="-90" y="${y}" width="180" height="12" rx="6" fill="${PALETTE.cream}" opacity="0.35"/>`).join("")}`;
    case "wheel":
      return `
        <circle cx="0" cy="0" r="130" fill="none" stroke="${deep}" stroke-width="20"/>
        <circle cx="0" cy="0" r="20" fill="${g}"/>
        ${Array.from({ length: 10 }, (_, i) => `<rect x="-5" y="-128" width="10" height="256" rx="5" fill="${soft}" transform="rotate(${i * 18})"/>`).join("")}
        <path d="M-150 -150 h150 v60 h-150 z" fill="${g}"/>
        <circle cx="20" cy="-120" r="16" fill="${accent}"/>`;
    case "flower":
      return `
        <circle cx="0" cy="0" r="34" fill="${accent}"/>
        ${Array.from({ length: 8 }, (_, i) => `<ellipse rx="46" ry="26" cy="-96" fill="${i % 2 ? soft : g}" transform="rotate(${i * 45})"/>`).join("")}
        <rect x="-14" y="-160" width="28" height="320" rx="14" fill="${deep}"/>
        <path d="M0 60 q-90 0 -110 -70 q80 -6 110 70 z" fill="${soft}"/>
        <path d="M0 140 q90 0 110 -70 q-80 -6 -110 70 z" fill="${PALETTE.accentSoft}"/>`;
    case "workshop":
    default:
      return `
        <rect x="-140" y="-40" width="280" height="150" rx="26" fill="${g}"/>
        <path d="M-140 -40 l70 -80 h140 l70 80 z" fill="${deep}"/>
        <rect x="-50" y="110" width="100" height="90" rx="16" fill="${soft}"/>
        <circle cx="0" cy="-10" r="42" fill="${PALETTE.paper}" opacity="0.9"/>
        <circle cx="0" cy="-10" r="20" fill="${accent}"/>
        ${[-120, 120].map((x) => `<rect x="${x - 12}" y="20" width="24" height="180" rx="12" fill="${PALETTE.accentSoft}"/>`).join("")}`;
  }
}

export type DemoCoverArtInput = {
  name: string;
  motif: DemoMotif;
  area?: string | null;
  kindLabel?: string | null;
};

/**
 * Build the full demo cover SVG. Every rendering carries the DEMO badge and
 * the "not a real Producer photo" caption — that is the whole point of it.
 */
export function buildDemoCoverSvg(input: DemoCoverArtInput): string {
  const nameLines = wrap(input.name, 20, 3);
  const areaLine = wrap(input.area ?? "—", 30, 1)[0];

  const nameText = nameLines
    .map(
      (line, index) =>
        `<text x="640" y="${300 + index * 62}" font-family="Poppins, DejaVu Sans, sans-serif" font-size="56" font-weight="700" fill="${PALETTE.ink}">${esc(line)}</text>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DEMO_COVER_WIDTH}" height="${DEMO_COVER_HEIGHT}" viewBox="0 0 ${DEMO_COVER_WIDTH} ${DEMO_COVER_HEIGHT}">
  <rect width="${DEMO_COVER_WIDTH}" height="${DEMO_COVER_HEIGHT}" fill="${PALETTE.cream}"/>
  <rect x="0" y="0" width="${DEMO_COVER_WIDTH}" height="12" fill="${PALETTE.green}"/>
  <circle cx="330" cy="400" r="212" fill="${PALETTE.paper}"/>
  <circle cx="330" cy="400" r="212" fill="none" stroke="${PALETTE.line}" stroke-width="4"/>
  <g transform="translate(330 400)">${motifArt(input.motif)}</g>
  <g>
    <rect x="640" y="170" width="220" height="46" rx="23" fill="${PALETTE.green}"/>
    <text x="750" y="201" text-anchor="middle" font-family="Poppins, DejaVu Sans, sans-serif" font-size="24" font-weight="700" letter-spacing="3" fill="${PALETTE.paper}">SINGGAH LOKAL</text>
    <text x="640" y="262" font-family="Poppins, DejaVu Sans, sans-serif" font-size="26" font-weight="600" fill="${PALETTE.muted}">${esc(input.kindLabel ?? "Demo Place")} • ${esc(areaLine)}</text>
    ${nameText}
    <rect x="640" y="470" width="480" height="4" rx="2" fill="${PALETTE.line}"/>
    <text x="640" y="522" font-family="Poppins, DejaVu Sans, sans-serif" font-size="26" fill="${PALETTE.muted}">Gambar demo untuk Discovery DEV.</text>
  </g>
  <g>
    <rect x="900" y="60" width="240" height="72" rx="36" fill="${PALETTE.accent}"/>
    <text x="1020" y="108" text-anchor="middle" font-family="Poppins, DejaVu Sans, sans-serif" font-size="36" font-weight="700" letter-spacing="4" fill="${PALETTE.paper}">DEMO</text>
  </g>
  <text x="40" y="712" font-family="Poppins, DejaVu Sans, sans-serif" font-size="24" fill="${PALETTE.muted}">Ilustrasi demo — bukan foto Producer, bukan bukti kepemilikan.</text>
</svg>`;
}