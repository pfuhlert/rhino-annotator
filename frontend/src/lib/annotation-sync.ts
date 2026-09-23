import type { Element } from "./api";

export type Changes = { upsert: Element[]; delete: string[] };

export function createAnnotationSync(
  initial: Element[],
  send: (changes: Changes) => Promise<unknown>,
) {
  let observed = new Map(initial.map((el) => [el.id, JSON.stringify(el)]));
  const pending = new Map<string, Element | null>();
  let running: Promise<void> | null = null;

  async function flush() {
    while (pending.size) {
      const batch = new Map(pending);
      pending.clear();
      try {
        await send({
          upsert: [...batch.values()].filter((el): el is Element => el !== null),
          delete: [...batch].filter(([, el]) => el === null).map(([id]) => id),
        });
      } catch (error) {
        for (const [id, el] of batch) if (!pending.has(id)) pending.set(id, el);
        throw error;
      }
    }
  }

  return {
    accept(elements: Element[]) {
      for (const el of elements) observed.set(el.id, JSON.stringify(el));
    },
    save(elements: Element[]) {
      const next = new Map(elements.map((el) => [el.id, JSON.stringify(el)]));
      for (const id of observed.keys()) if (!next.has(id)) pending.set(id, null);
      for (const el of elements)
        if (observed.get(el.id) !== next.get(el.id)) pending.set(el.id, structuredClone(el));
      observed = next;
      if (!pending.size) return running ?? Promise.resolve();
      running ??= flush().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
