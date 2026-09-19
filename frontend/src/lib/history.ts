import type { Mark } from "./draw";

export function createHistory(initial: Mark[], limit = 10) {
  const states = [structuredClone(initial)];
  let i = 0;
  function step(delta: number) {
    const j = i + delta;
    if (j < 0 || j >= states.length) return null;
    i = j;
    return structuredClone(states[i]);
  }
  return {
    commit(marks: Mark[]) {
      states.length = i + 1;
      states.push(structuredClone(marks));
      if (states.length > limit + 1) states.shift();
      else i++;
    },
    undo: () => step(-1),
    redo: () => step(1),
  };
}
