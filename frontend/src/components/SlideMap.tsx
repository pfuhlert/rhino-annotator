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
  return (
    <figure
      data-testid="slide-map"
      className="pointer-events-none absolute right-4 bottom-full border-2 border-zinc-500"
    >
      <svg
        width={Math.round(slide.width * scale)}
        height={Math.round(slide.height * scale)}
        viewBox={`0 0 ${slide.width} ${slide.height}`}
        preserveAspectRatio="none"
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
            strokeWidth={seen ? 2 : 1}
            className={
              seen ? "fill-emerald-500/10 stroke-emerald-500" : "fill-none stroke-zinc-900/20"
            }
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
    </figure>
  );
}
