"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { cn } from "cn";
import { aiTaskId, type Element, type Job, type Times } from "@/lib/api";
import { measurePolygon, type Measures } from "@/lib/geometry";

// Far below the job's typical size usually means a stray click or an AI fragment.
const TINY_SHARE_OF_MEDIAN = 0.1;
const TINY_MIN_GROUP = 4;

function rounded(n: number) {
  return n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toLocaleString("en-US");
}

function formatArea(px2: number, nmPerPx: number | null) {
  if (!nmPerPx) return `${Math.round(px2).toLocaleString("en-US")} px²`;
  return `${rounded((px2 * nmPerPx * nmPerPx) / 1e6)} µm²`;
}

function formatLength(px: number, nmPerPx: number | null) {
  if (!nmPerPx) return `${Math.round(px).toLocaleString("en-US")} px`;
  return `${rounded((px * nmPerPx) / 1e3)} µm`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function ago(seconds: number | null, now: number) {
  if (seconds === null) return <span className="text-muted-foreground">Unknown</span>;
  const elapsed = Math.max(0, now / 1000 - seconds);
  const [unit, size] = UNITS.find(([, s]) => elapsed >= s) ?? ["second", 1];
  const label = unit === "second" ? "just now" : relative.format(-Math.floor(elapsed / size), unit);
  return <time title={new Date(seconds * 1000).toLocaleString()}>{label}</time>;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function Details({
  measures: m,
  time,
  nmPerPx,
}: {
  measures: Measures;
  time: [number | null, number | null] | undefined;
  nmPerPx: number | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // Times arrive with the save response, so a just-drawn annotation has none yet.
  const unsaved = <span className="text-muted-foreground">Not saved yet</span>;
  const rows: [string, React.ReactNode][] = [
    ["Perimeter", formatLength(m.perimeter, nmPerPx)],
    [
      "Feret min / max",
      `${formatLength(m.feretMin, nmPerPx)} / ${formatLength(m.feretMax, nmPerPx)}`,
    ],
    ["Created", time ? ago(time[0], now) : unsaved],
    ["Edited", time ? ago(time[1], now) : unsaved],
  ];
  return (
    <dl
      data-testid="annotation-details"
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-0.5 pr-2 pb-2 pl-9 text-xs"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AnnotationList({
  marks,
  jobs,
  selectedId,
  times,
  nmPerPx,
  onHover,
  onSelect,
  onDelete,
}: {
  marks: Element[];
  jobs: Job[];
  selectedId: string | null;
  times: Times;
  nmPerPx: number | null;
  onHover: (id: string | null) => void;
  onSelect: (mark: Element) => void;
  onDelete: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Brush mode has no canvas selection, so the list tracks its open row itself and follows the
  // canvas selection whenever that changes.
  const [openId, setOpenId] = useState(selectedId);
  const [seenSelected, setSeenSelected] = useState(selectedId);
  if (selectedId !== seenSelected) {
    setSeenSelected(selectedId);
    setOpenId(selectedId);
  }
  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector(`[data-mark-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // Normalizing each polygon runs a clipping pass, so only redo it when the marks change.
  const measures = useMemo(
    () => new Map(marks.filter((m) => m.type === "polygon").map((m) => [m.id, measurePolygon(m)])),
    [marks],
  );
  const groups = jobs
    .map((job) => {
      const polygons = marks.filter((m) => m.type === "polygon" && m.jobId === job.id);
      const areas = polygons.map((m) => measures.get(m.id)?.area ?? 0);
      const mid = median(areas);
      return {
        job,
        polygons,
        points: marks.filter((m) => m.type === "point" && m.jobId === job.id).length,
        tiny: (area: number) => areas.length >= TINY_MIN_GROUP && area < mid * TINY_SHARE_OF_MEDIAN,
      };
    })
    .filter((g) => g.polygons.length);

  if (!groups.length)
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">No annotations on this image yet.</p>
    );

  return (
    <div
      ref={listRef}
      data-testid="annotation-list"
      className="flex flex-col gap-3"
      onPointerLeave={() => onHover(null)}
    >
      {groups.map(({ job, polygons, points, tiny }) => (
        <section key={job.id} className="flex flex-col gap-0.5">
          <h3
            data-testid={`annotation-group-${job.id}`}
            className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-sidebar-foreground/70"
          >
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: job.color }} />
            <span className="truncate">{job.name}</span>
            <span className="tabular-nums">{polygons.length}</span>
            {points > 0 && (
              <span className="shrink-0 font-normal text-muted-foreground tabular-nums">
                · {points} {points === 1 ? "point" : "points"}
              </span>
            )}
          </h3>
          {polygons.map((mark, i) => {
            const m = measures.get(mark.id);
            const open = mark.id === openId;
            return (
              <div
                key={mark.id}
                data-mark-id={mark.id}
                className={cn(
                  "group rounded-md hover:bg-sidebar-accent",
                  open && "bg-sidebar-accent",
                )}
                onPointerEnter={() => onHover(mark.id)}
              >
                <div className="flex items-center">
                  <button
                    type="button"
                    data-testid={`annotation-${mark.id}`}
                    aria-pressed={mark.id === selectedId}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                    onClick={() => {
                      setOpenId(mark.id);
                      onSelect(mark);
                    }}
                  >
                    <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate tabular-nums">
                      {formatArea(m?.area ?? 0, nmPerPx)}
                    </span>
                    {m && tiny(m.area) && (
                      <span
                        data-testid={`annotation-tiny-${mark.id}`}
                        title="Much smaller than this job's other annotations"
                        className="shrink-0 text-amber-500"
                      >
                        <TriangleAlertIcon aria-label="Unusually small" className="size-3.5" />
                      </span>
                    )}
                    {aiTaskId(mark.id) && (
                      <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                        AI
                      </span>
                    )}
                    <span
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      title="Maximum Feret diameter"
                    >
                      ⌀ {formatLength(m?.feretMax ?? 0, nmPerPx)}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid={`delete-annotation-${mark.id}`}
                    aria-label="Delete annotation"
                    className="mr-1 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                    onClick={() => onDelete(mark.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
                {open && m && <Details measures={m} time={times[mark.id]} nmPerPx={nmPerPx} />}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
