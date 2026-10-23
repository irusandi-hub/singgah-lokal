"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CURATED_TAB_DRAG_THRESHOLD_PX,
  CURATED_TAB_HANDLE_THRESHOLD_PX,
  CURATED_TAB_KEYBOARD_STEP_RATIO,
  CURATED_TAB_STORAGE_KEY,
  clampCuratedTabDrag,
  resolveCuratedTabArea,
  resolveCuratedTabPosition,
  snapCuratedTabPlacement,
  type CuratedTabSide,
} from "@/lib/live/ui";

/**
 * FLOATING "TEMPAT PILIHAN" TAB (product decision, 2026-10-21).
 *
 * The tab used to hang off the results sheet's header, where it competed with
 * the drag handle and could only ever sit at one x position. It is now a real
 * floating control over the map that the visitor can move — one instance, the
 * SAME `aria-pressed` / `activateCuratedFilter` / LIVE-exclusivity rules, and
 * the same curated dataset behind it.
 *
 * INTERACTION CONTRACT
 *  · TAP toggles BOTH WAYS (2026-10-22): a tap on the inactive tab enters the
 *    curated layer; a tap on the active tab leaves it and the previous
 *    distance preset becomes the active filter again. A press only becomes a
 *    drag after the finger travels more than 8px (2px when started on the
 *    small grip), so a tap can never be mistaken for a drag and vice versa,
 *    and a drag NEVER toggles.
 *  · DRAG uses pointer events + pointer capture: the gesture stays on this
 *    element even when the finger leaves it, `touch-action: none` stops it
 *    from scrolling the page, and the map's own one-finger pan is already
 *    locked off. The sheet handle is a different element, so sheet drag is
 *    never in play.
 *  · BOUNDS come from `resolveCuratedTabArea` / `clampCuratedTabDrag`: the tab
 *    stays inside the visible map band, clears the filter/search chrome (top
 *    190px), the right-hand control column, the OSM attribution, and the
 *    sheet. On release it SNAPS to the nearer edge.
 *  · PERSISTENCE stores only `{ side, ratio }`, never pixels, so a rotation, a
 *    sheet move, or a different phone re-clamps to a legal spot instead of
 *    restoring an off-screen one. It is stored in sessionStorage: a dragged
 *    position belongs to the current browsing session and is intentionally
 *    NOT restored on a later visit. Any older localStorage value is ignored
 *    outright (the key is no longer read from localStorage).
 *  · RESET: double-tap the grip. That is the ONLY reset control — the "?"
 *    panel is information only and carries no reset button.
 *  · PRESENTATION (2026-10-22): ONE whole capsule, no divider and no ≡ icon —
 *    the grip is six faint dots inside the same surface. Inactive is an
 *    opaque white pill with dark-green text and a soft layered shadow; active
 *    is a smooth dark-green gradient with white text and a hairline ring; a
 *    drag lifts it 1.04 with a deeper shadow (transition removed under
 *    prefers-reduced-motion). Height stays 44px in every state.
 *  · KEYBOARD: focusable; Enter/Space toggle (native button); ArrowLeft /
 *    ArrowRight choose the edge; ArrowUp / ArrowDown move it vertically.
 *  · HIDDEN when the sheet reaches `full` (the map is no longer visible).
 */
export type CuratedMapTabProps = {
  pressed: boolean;
  onToggle: () => void;
  stageWidth: number;
  stageHeight: number;
  sheetVisiblePx: number;
};

type Placement = { side: CuratedTabSide; ratio: number };

const DEFAULT_PLACEMENT: Placement = { side: "left", ratio: 1 };
const DOUBLE_TAP_MS = 350;

// ---------------------------------------------------------------------------
// PERSISTED PLACEMENT — an external store, not effect-driven state.
// ---------------------------------------------------------------------------
// Reading sessionStorage in a mount effect and calling setState is both a lint
// error (cascading render) and a hydration hazard. `useSyncExternalStore` is
// the supported way to read browser-only state: the server snapshot is `null`
// (the default corner), and the client picks the stored value up right after
// hydration without a mismatch. Writes go through `writePlacement`, which
// refreshes the cached snapshot and notifies every mounted tab — that is also
// how a double-tap reset reaches the tab without a nonce or an effect.
//
// SESSION-ONLY (2026-10-23): the position is persisted per browsing session.
// A stale `localStorage` value from the previous behaviour is never read.
let cachedPlacementRaw: string | null = null;
const placementListeners = new Set<() => void>();

function notifyPlacementListeners() {
  for (const listener of placementListeners) listener();
}

function readPlacementSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CURATED_TAB_STORAGE_KEY);
    if (raw !== cachedPlacementRaw) cachedPlacementRaw = raw;
    return cachedPlacementRaw;
  } catch {
    return null;
  }
}

function subscribeToPlacement(listener: () => void): () => void {
  placementListeners.add(listener);
  return () => {
    placementListeners.delete(listener);
  };
}

function parsePlacement(raw: string | null): Placement {
  if (!raw) return DEFAULT_PLACEMENT;
  try {
    const parsed = JSON.parse(raw) as { side?: unknown; ratio?: unknown };
    return {
      side: parsed.side === "right" ? "right" : "left",
      ratio:
        typeof parsed.ratio === "number" && Number.isFinite(parsed.ratio)
          ? Math.min(1, Math.max(0, parsed.ratio))
          : 1,
    };
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

function writePlacement(next: Placement) {
  try {
    const raw = JSON.stringify(next);
    window.sessionStorage.setItem(CURATED_TAB_STORAGE_KEY, raw);
    cachedPlacementRaw = raw;
  } catch {
    // Storage unavailable: the position simply does not survive a reload.
  }
  notifyPlacementListeners();
}

/**
 * Reset the floating tab to its default bottom-left corner. Safe to call from
 * anywhere. Symmetric with `writePlacement`: the session copy is the only one
 * that exists, and the legacy localStorage key is left untouched/ignored.
 */
export function resetCuratedTabPlacement() {
  try {
    window.sessionStorage.removeItem(CURATED_TAB_STORAGE_KEY);
    cachedPlacementRaw = null;
  } catch {
    // Storage unavailable: nothing to remove.
  }
  notifyPlacementListeners();
}

export default function CuratedMapTab({
  pressed,
  onToggle,
  stageWidth,
  stageHeight,
  sheetVisiblePx,
}: CuratedMapTabProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The tab must be IN the DOM to be measured, so it renders hidden until its
  // size is known.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const storedRaw = useSyncExternalStore(
    subscribeToPlacement,
    readPlacementSnapshot,
    () => null,
  );
  const placement = useMemo(() => parsePlacement(storedRaw), [storedRaw]);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
    fromHandle: boolean;
    onToggle: boolean;
  } | null>(null);
  const dragPosRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const lastHandleTapRef = useRef(0);

  // MEASURE ON EVERY ATTACH (2026-10-21 bug fix). The tab returns `null` at
  // `full`, and a layout effect with `[]` deps cannot re-run when the node comes
  // back — meanwhile the observer had already reported the removed node as 0×0.
  // A CALLBACK REF re-measures each time React attaches a node, so the tab is
  // never stranded invisible after the sheet returns to small/mid.
  const measureObserverRef = useRef<ResizeObserver | null>(null);
  const attachWrapper = useCallback((node: HTMLDivElement | null) => {
    wrapperRef.current = node;
    measureObserverRef.current?.disconnect();
    measureObserverRef.current = null;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    measureObserverRef.current = observer;
  }, []);

  useEffect(() => () => measureObserverRef.current?.disconnect(), []);

  const resetPlacement = useCallback(() => {
    setDragPos(null);
    dragPosRef.current = null;
    resetCuratedTabPlacement();
  }, []);

  const persist = useCallback((next: Placement) => {
    writePlacement(next);
  }, []);


  const area = useMemo(
    () =>
      resolveCuratedTabArea({
        stageWidth,
        stageHeight,
        sheetVisiblePx,
        tabWidth: size.width,
        tabHeight: size.height,
      }),
    [stageWidth, stageHeight, sheetVisiblePx, size.width, size.height],
  );

  const resolved = area ? resolveCuratedTabPosition(area, placement) : null;
  const position = dragPos ?? resolved;

  const beginDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (!position || !area) return;
      // A new gesture owns the next click: clear any suppression left by the
      // previous one.
      suppressClickRef.current = false;
      const target = event.target as Element | null;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: position.x,
        baseY: position.y,
        moved: false,
        fromHandle: Boolean(target?.closest("[data-curated-tab-handle]")),
        onToggle: Boolean(target?.closest("[data-curated-tab-toggle]")),
      };
      dragPosRef.current = { x: position.x, y: position.y };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [area, position],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !area) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const threshold = drag.fromHandle ? CURATED_TAB_HANDLE_THRESHOLD_PX : CURATED_TAB_DRAG_THRESHOLD_PX;
      if (!drag.moved && Math.hypot(dx, dy) <= threshold) return;
      drag.moved = true;
      const next = clampCuratedTabDrag({
        area,
        stageWidth,
        tabWidth: size.width,
        tabHeight: size.height,
        x: drag.baseX + dx,
        y: drag.baseY + dy,
      });
      dragPosRef.current = next;
      setDragPos(next);
      event.preventDefault();
    },
    [area, size.height, size.width, stageWidth],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const released = dragPosRef.current;
      dragPosRef.current = null;
      if (drag.moved && !cancelled && area && released) {
        const next = snapCuratedTabPlacement({
          area,
          stageWidth,
          tabWidth: size.width,
          x: released.x,
          y: released.y,
        });
        persist(next);
        setDragPos(null);
        // The pointer sequence that just ended must not also toggle. The flag
        // is held until the NEXT pointerdown or keydown (a fixed 0ms timer was
        // too short: Chrome can dispatch the click a task after pointerup).
        suppressClickRef.current = true;
        return;
      }
      setDragPos(null);
      if (!cancelled && drag.onToggle) {
        // A captured pointerup can swallow the native click, so the tap is
        // resolved HERE and any click that still fires is suppressed.
        onToggle();
        suppressClickRef.current = true;
        return;
      }
      if (!cancelled && drag.fromHandle) {
        // Double-tap the grip = back to the default corner. Implemented from
        // the pointer sequence itself so it works on touch, where a synthetic
        // dblclick is not reliable.
        const now = performance.now();
        if (now - lastHandleTapRef.current <= DOUBLE_TAP_MS) {
          lastHandleTapRef.current = 0;
          resetPlacement();
        } else {
          lastHandleTapRef.current = now;
        }
      }
    },
    [area, onToggle, persist, resetPlacement, size.width, stageWidth],
  );

  // Keyboard activation (Enter/Space) and any pointer click that the capture
  // did not swallow end up here. A pointer tap is already resolved in
  // `endDrag`, so exactly ONE click is skipped through `suppressClickRef`.
  const handleToggleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      // Keyboard activation is never the suppressed pointer click.
      suppressClickRef.current = false;
      if (!area) return;
      const range = Math.max(1, area.maxY - area.minY);
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const current = resolveCuratedTabPosition(area, placement);
        const step = (event.key === "ArrowUp" ? -1 : 1) * range * CURATED_TAB_KEYBOARD_STEP_RATIO;
        const next = snapCuratedTabPlacement({
          area,
          stageWidth,
          tabWidth: size.width,
          x: current.x,
          y: current.y + step,
        });
        persist(next);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (event.key === "ArrowRight" && !area.rightAvailable) return;
        event.preventDefault();
        const side: CuratedTabSide = event.key === "ArrowLeft" ? "left" : "right";
        const minY = side === "right" ? area.rightMinY : area.minY;
        const currentY = resolveCuratedTabPosition(area, placement).y;
        const ratio = Math.min(1, Math.max(0, (currentY - minY) / Math.max(1, area.maxY - minY)));
        const next: Placement = { side, ratio };
        persist(next);
      }
    },
    [area, persist, placement, size.width, stageWidth],
  );

  // `full` means the sheet owns the screen: the tab goes away with the map.
  if (stageHeight > 0 && sheetVisiblePx >= stageHeight) return null;

  const dragging = dragPos !== null;
  return (
    <div
      ref={attachWrapper}
      data-curated-map-tab
      style={{
        left: position?.x ?? 12,
        top: position?.y ?? 190,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={(event) => endDrag(event, false)}
      onPointerCancel={(event) => endDrag(event, true)}
      onLostPointerCapture={(event) => endDrag(event, true)}
      className={`singgah-curated-tab absolute z-[1100] flex h-11 touch-none select-none items-center overflow-hidden rounded-full ${
        dragging ? "is-dragging scale-[1.04] cursor-grabbing" : "cursor-grab"
      } ${
        pressed
          ? "is-active bg-[linear-gradient(135deg,#127a5a_0%,var(--brand-primary)_52%,var(--brand-primary-deep)_100%)] text-white shadow-[0_1px_1px_rgb(10_86_64/0.18),0_6px_14px_rgb(10_86_64/0.26),0_14px_28px_rgb(10_86_64/0.16)] ring-1 ring-white/30"
          : "bg-white text-brand-primary shadow-[0_1px_2px_rgb(32_35_31/0.06),0_5px_12px_rgb(32_35_31/0.10),0_12px_24px_rgb(32_35_31/0.06)]"
      }`}
    >
      {/* GRIP — the explicit drag affordance, now six faint dots inside the
          SAME capsule (no divider, no ≡ glyph). A double tap here restores
          the default corner; a single tap does nothing (it never toggles). */}
      <span
        data-curated-tab-handle
        aria-hidden
        title="Geser untuk memindahkan · ketuk dua kali untuk posisi awal"
        className="singgah-curated-tab-grip inline-flex h-11 w-[20px] shrink-0 items-center justify-center pl-1"
      >
        <svg aria-hidden viewBox="0 0 6 14" width="6" height="14" fill="currentColor">
          <circle cx="1.1" cy="2" r="0.95" />
          <circle cx="4.9" cy="2" r="0.95" />
          <circle cx="1.1" cy="7" r="0.95" />
          <circle cx="4.9" cy="7" r="0.95" />
          <circle cx="1.1" cy="12" r="0.95" />
          <circle cx="4.9" cy="12" r="0.95" />
        </svg>
      </span>
      <button
        data-curated-tab-toggle
        type="button"
        aria-pressed={pressed}
        aria-label="Tempat Pilihan"
        title={
          pressed
            ? "Tempat Pilihan aktif — ketuk untuk nonaktifkan, geser untuk memindahkan"
            : "Tempat Pilihan — ketuk untuk aktifkan, geser untuk memindahkan"
        }
        onClick={handleToggleClick}
        onKeyDown={handleKeyDown}
        className={`inline-flex h-11 items-center justify-center gap-1.5 whitespace-nowrap bg-transparent px-3 text-[11.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80 ${
          pressed ? "text-white" : "text-brand-primary"
        }`}
      >
        <span aria-hidden className="singgah-curated-tab-star">
          ✦
        </span>
        Tempat Pilihan
      </button>
    </div>
  );
}
