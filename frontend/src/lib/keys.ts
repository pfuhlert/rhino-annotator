export function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement &&
      target.closest("[data-slot='select-content'],[role=menu],[role=dialog]"))
  );
}
