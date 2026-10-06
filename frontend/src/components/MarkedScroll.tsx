"use client";

import {
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "cn";
import { MARK_COLOR } from "@/components/MarkDot";
import type { Mark } from "@/lib/images";

type Bar = { top: number; height: number; marks: { top: number; mark: Mark }[]; inset: number };

// Fractions of the scroll height, and the px where sticky [data-scroll-pin] blocks end once stuck,
// so the track starts below them. Null when nothing overflows.
function measure(el: HTMLElement): Bar | null {
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight <= clientHeight) return null;
  const origin = el.getBoundingClientRect().top - scrollTop;
  const marks = [...el.querySelectorAll<HTMLElement>("[data-scroll-mark]")].map((m) => {
    const r = m.getBoundingClientRect();
    const top = (r.top - origin + r.height / 2) / scrollHeight;
    return { top, mark: m.dataset.scrollMark as Mark };
  });
  const pins = [...el.querySelectorAll<HTMLElement>("[data-scroll-pin]")];
  const inset = Math.max(
    0,
    ...pins.map((p) => parseFloat(getComputedStyle(p).top) + p.offsetHeight),
  );
  return { top: scrollTop / scrollHeight, height: clientHeight / scrollHeight, marks, inset };
}

// A thin overlay scrollbar with a line for every descendant carrying data-scroll-mark.
export default function MarkedScroll({ className, children, ...props }: ComponentProps<"div">) {
  const scroller = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const drag = useRef<{ y: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const el = scroller.current!;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBar(measure(el)));
    };
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const mutate = new MutationObserver(() => {
      for (const child of el.children) resize.observe(child);
      update();
    });
    mutate.observe(el, { subtree: true, childList: true, attributeFilter: ["data-scroll-mark"] });
    for (const child of el.children) resize.observe(child);
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutate.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  function onTrackDown(e: ReactPointerEvent<HTMLDivElement>) {
    const el = scroller.current!;
    const track = e.currentTarget.getBoundingClientRect();
    const onThumb = (e.target as HTMLElement).dataset.thumb !== undefined;
    if (!onThumb) {
      const at = (e.clientY - track.top) / track.height;
      el.scrollTop = at * el.scrollHeight - el.clientHeight / 2;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, scrollTop: el.scrollTop };
  }

  function onTrackMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const el = scroller.current!;
    const track = e.currentTarget.getBoundingClientRect();
    el.scrollTop =
      drag.current.scrollTop + ((e.clientY - drag.current.y) / track.height) * el.scrollHeight;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className={cn("[scrollbar-width:none]", className)} {...props}>
        {children}
      </div>
      {/* Inset past the sidebar resize handle, which covers the panel's right edge. */}
      {bar && (
        <div
          data-testid="marked-scrollbar"
          aria-hidden
          className="group absolute right-1.5 bottom-1 w-2 touch-none"
          style={{ top: bar.inset + 4 }}
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          <div
            data-thumb
            className="absolute right-0 w-1 rounded-full bg-sidebar-foreground/15 transition-colors group-hover:bg-sidebar-foreground/30"
            style={{ top: `${bar.top * 100}%`, height: `${bar.height * 100}%` }}
          />
          {bar.marks.map(({ top, mark }, i) => (
            <div
              key={i}
              data-mark={mark}
              className={cn(
                "pointer-events-none absolute right-0 h-0.5 w-1 -translate-y-1/2 rounded-full",
                MARK_COLOR[mark],
              )}
              style={{ top: `${top * 100}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
