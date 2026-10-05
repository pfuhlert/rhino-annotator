"use client";

import { useEffect, useRef } from "react";
import type { AiWorkerState } from "@/lib/api";

const OFFSET_PX = 18;
const BADGE_PX = 22;
const RING_PX = 2;

// An anti-aliased SVG arc from 20° to 345° with round caps masks a conic gradient, so the comet
// fades in along its tail and ends in a clean rounded head.
function cometRing() {
  const r = (BADGE_PX - RING_PX) / 2;
  const c = BADGE_PX / 2;
  const at = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${c + r * Math.sin(a)} ${c - r * Math.cos(a)}`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BADGE_PX} ${BADGE_PX}"><path d="M${at(20)}A${r} ${r} 0 1 1 ${at(345)}" fill="none" stroke="#000" stroke-width="${RING_PX}" stroke-linecap="round"/></svg>`;
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / 100% 100% no-repeat`;
  return {
    background: "conic-gradient(transparent 20deg, #fff 345deg)",
    mask,
    WebkitMask: mask,
  };
}
const COMET_RING = cometRing();
const BADGE = {
  width: BADGE_PX,
  height: BADGE_PX,
  boxShadow: `inset 0 0 0 ${RING_PX}px rgb(255 255 255 / 0.1), 0 2px 8px rgb(0 0 0 / 0.4)`,
};
const WORKER_NOTE: Record<AiWorkerState, string | null> = {
  ready: null,
  loading: "warming up",
  offline: "offline",
};

export function AiCursorStatus({ count, worker }: { count: number; worker: AiWorkerState }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const area = el?.parentElement;
    if (!el || !area) return;
    const move = (e: PointerEvent) => {
      el.style.transform = `translate(${e.clientX + OFFSET_PX}px, ${e.clientY + OFFSET_PX}px)`;
      el.dataset.inside = "";
    };
    const leave = () => delete el.dataset.inside;
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerdown", move);
    area.addEventListener("pointerleave", leave);
    return () => {
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerdown", move);
      area.removeEventListener("pointerleave", leave);
    };
  }, []);

  const note = WORKER_NOTE[worker];
  return (
    <div
      ref={ref}
      data-testid="ai-status"
      data-worker={worker}
      data-pending={count}
      role="status"
      className={`pointer-events-none fixed top-0 left-0 z-30 hidden items-center gap-1 text-white will-change-transform ${count > 0 ? "data-inside:flex" : ""}`}
    >
      <span
        className="relative grid place-items-center rounded-full bg-black/55 text-[10px] leading-none font-semibold tabular-nums backdrop-blur-sm"
        style={BADGE}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-[spin_0.8s_linear_infinite]"
          style={COMET_RING}
        />
        <span className="sr-only">AI annotations pending:</span>
        {count}
      </span>
      {note && (
        <span className="rounded-full bg-black/55 px-1.5 py-[3px] text-[10px] leading-none whitespace-nowrap text-white/70">
          {note}
        </span>
      )}
    </div>
  );
}
