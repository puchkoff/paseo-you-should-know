// Lets a card or popover action refresh the composer pills now instead of on the next poll.
const listeners = new Set<() => void>();

export function onNotesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notesChanged() {
  for (const listener of listeners) listener();
}
