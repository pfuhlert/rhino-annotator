type Key = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;

// Pan moves the view by screen pixels; zoom multiplies it about its center.
export type ViewAction = { pan: [number, number] } | { zoom: number } | "home";

const STEP = 40;

const PAN: Record<string, [number, number]> = {
  ArrowUp: [0, -STEP],
  ArrowDown: [0, STEP],
  ArrowLeft: [-STEP, 0],
  ArrowRight: [STEP, 0],
};

// OpenSeadragon's keys and step sizes, without its letters and 0: those pick tools and structures.
export function viewAction(e: Key): ViewAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Home") return "home";
  if (e.key === "+" || e.key === "=") return { zoom: 1.1 };
  if (e.key === "-" || e.key === "_") return { zoom: 0.9 };
  const pan = PAN[e.key];
  if (!pan) return null;
  if (e.shiftKey && pan[1]) return { zoom: pan[1] < 0 ? 1.1 : 0.9 };
  return { pan };
}
