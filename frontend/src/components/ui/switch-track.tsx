import { cn } from "cn";

// The look of an on/off switch; the menu item around it handles the click.
export function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
        on ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "size-3 rounded-full bg-background shadow-sm transition-transform",
          on && "translate-x-3",
        )}
      />
    </span>
  );
}
