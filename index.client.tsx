import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { onNotesChanged } from "./client/events.ts";
import { POLL_MS } from "./client/note-view.tsx";
import { LegacyNoteCard, NoteCard, PillPopover, SettingsScreen } from "./client/panels.tsx";
import { CARD_KIND, CARD_VERSION, legacyNoteSchema, listNotes, noteSchema } from "./shared/notes.ts";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: noteSchema, Component: NoteCard });
  client.addTimelineRenderer({ kind: CARD_KIND, version: 1, schema: legacyNoteSchema, Component: LegacyNoteCard });
  client.addSettingsScreen({ id: "observer", title: "You should know", icon: "Sparkles", Component: SettingsScreen });

  // A pill with the open-note count, only on agents that have open notes.
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  // Only the newest response is applied, so a slow older poll cannot overwrite a newer one.
  let latest = 0;

  async function refresh() {
    const seq = ++latest;
    const { agents } = await client.rpc(listNotes, {});
    if (stopped || seq !== latest) return;
    const seen = new Set<string>();
    for (const { agentId, workspaceId, notes } of agents) {
      seen.add(agentId);
      const label = String(notes.length);
      const existing = pills.get(agentId);
      if (existing) existing.update({ label });
      else
        pills.set(
          agentId,
          client.addComposerPill({
            id: "notes",
            workspaceId,
            agentId,
            button: { title: "You should know", icon: "Sparkles", label, behavior: { kind: "popover", Content: PillPopover } },
          }),
        );
    }
    for (const [agentId, pill] of pills) {
      if (seen.has(agentId)) continue;
      pill.remove();
      pills.delete(agentId);
    }
  }

  const tick = () =>
    refresh().catch((err) => {
      if (!stopped) console.error("[you-should-know] refresh failed", err);
    });
  void tick();
  const timer = setInterval(tick, POLL_MS);
  const unsubscribe = onNotesChanged(() => void tick());

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
