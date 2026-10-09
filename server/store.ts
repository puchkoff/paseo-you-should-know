import { type Note, itemLine } from "../shared/notes.ts";

const MAX_NOTES_PER_AGENT = 20;

interface AgentNotes {
  // Null for notes restored from a card after a restart; they get no composer pill.
  workspaceId: string | null;
  notes: Note[];
}

// In memory, like the timeline rows the notes back: both are lost on a daemon restart.
export function createStore() {
  const byAgent = new Map<string, AgentNotes>();

  return {
    add(agentId: string, workspaceId: string | null, note: Note) {
      const entry = byAgent.get(agentId) ?? { workspaceId, notes: [] };
      entry.notes.push(note);
      if (entry.notes.length > MAX_NOTES_PER_AGENT) entry.notes.shift();
      byAgent.set(agentId, entry);
    },
    shown(agentId: string): string[] {
      return (byAgent.get(agentId)?.notes ?? []).flatMap((n) => n.items.map(itemLine));
    },
    // Returns the note and whether it moved; a note the store lost is restored from the caller's copy.
    transition(agentId: string, seen: Note, to: Note["status"]): { note: Note; changed: boolean } {
      let note = byAgent.get(agentId)?.notes.find((n) => n.id === seen.id);
      if (!note) {
        note = { ...seen };
        this.add(agentId, byAgent.get(agentId)?.workspaceId ?? null, note);
      }
      if (note.status !== seen.status) return { note, changed: false };
      note.status = to;
      return { note, changed: true };
    },
    open() {
      return [...byAgent.entries()]
        .flatMap(([agentId, { workspaceId, notes }]) => (workspaceId ? [{ agentId, workspaceId, notes: notes.filter((n) => n.status === "open") }] : []))
        .filter((a) => a.notes.length > 0);
    },
    forget(agentId: string) {
      byAgent.delete(agentId);
    },
  };
}
