import type { PatchImage, SlideView, ViewRect } from "@/lib/api";

const SIDE = 208;

export default function SlideMap({
  slide,
  image,
  view,
}: {
  slide: SlideView;
  image: PatchImage;
  view: ViewRect | null;
}) {
  // Only worth drawing once the user has zoomed into part of the patch.
  const zoomed = view && (view.width < image.width * 0.98 || view.height < image.height * 0.98);
  const scale = SIDE / Math.max(slide.width, slide.height);
  const [x, y, w, h] = slide.tiles[slide.current];
  const visited = slide.tiles.filter((tile) => tile[4]).length;
  return (
    <figure
      data-testid="slide-map"
      className="pointer-events-none absolute right-4 bottom-4 z-20 rounded-lg border border-white/10 bg-zinc-950/85 p-2 shadow-lg backdrop-blur"
    >
      <svg
        width={slide.width * scale}
        height={slide.height * scale}
        viewBox={`0 0 ${slide.width} ${slide.height}`}
        className="block overflow-visible bg-white"
        aria-label={`Tile ${slide.current + 1} of ${slide.tiles.length} on ${slide.name}`}
      >
        <image
          href={slide.thumbnail_url}
          width={slide.width}
          height={slide.height}
          preserveAspectRatio="none"
        />
        {slide.tiles.map(([tx, ty, tw, th, seen], i) => (
          <rect
            key={i}
            x={tx}
            y={ty}
            width={tw}
            height={th}
            vectorEffect="non-scaling-stroke"
            className={seen ? "fill-sky-500/15 stroke-sky-700/40" : "fill-none stroke-zinc-900/20"}
          />
        ))}
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          vectorEffect="non-scaling-stroke"
          strokeWidth={2}
          className="fill-none stroke-amber-400"
        />
        {zoomed && (
          <rect
            data-testid="slide-map-view"
            x={image.left + view.left}
            y={image.top + view.top}
            width={view.width}
            height={view.height}
            vectorEffect="non-scaling-stroke"
            strokeWidth={1.5}
            className="fill-white/20 stroke-white"
          />
        )}
      </svg>
      <figcaption className="mt-1.5 flex max-w-52 justify-between gap-3 text-[11px] text-zinc-300">
        <span className="truncate">{slide.name}</span>
        <span className="shrink-0 tabular-nums">
          {visited} / {slide.tiles.length} visited
        </span>
      </figcaption>
    </figure>
  );
}
