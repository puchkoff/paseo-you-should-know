import { type PluginButtonContentProps, type PluginSurfaceProps, type PluginTimelineItemProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { type z } from "zod";
import { MIN_TOOL_CALLS, MODELS, type Note, fromLegacy, type legacyNoteSchema, listNotes, preferences } from "../shared/notes.ts";
import { NOTES_QUERY_KEY, NoteView, POLL_MS } from "./note-view.tsx";

export function NoteCard({ theme, agentId, item }: PluginTimelineItemProps<Note>) {
  return <NoteView theme={theme} agentId={agentId} note={item.data} />;
}

export function LegacyNoteCard({ theme, agentId, item }: PluginTimelineItemProps<z.output<typeof legacyNoteSchema>>) {
  return <NoteView theme={theme} agentId={agentId} note={fromLegacy(item.data)} />;
}

export function PillPopover(props: PluginButtonContentProps) {
  const { theme } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const list = useRpc(listNotes);
  const query = useQuery({ queryKey: NOTES_QUERY_KEY, queryFn: () => list({}), refetchInterval: POLL_MS });
  const notes = query.data?.agents.find((a) => a.agentId === agentId)?.notes ?? [];

  if (!agentId) return null;
  return (
    <View style={{ gap: 10, minWidth: 280, maxWidth: 420 }}>
      {query.error ? <Text style={{ color: theme.colors.statusDanger }}>{String(query.error)}</Text> : null}
      {notes.length === 0 && !query.isLoading ? <Text style={{ color: theme.colors.foregroundMuted }}>No open notes.</Text> : null}
      {notes.map((note) => (
        <NoteView key={note.id} theme={theme} agentId={agentId} note={note} />
      ))}
    </View>
  );
}

export function SettingsScreen(_props: PluginSurfaceProps) {
  const state = useSettings(preferences);
  if (state.status !== "ready") {
    const message = state.status === "loading" ? "Loading…" : state.error;
    return (
      <SettingsSection title="Observer">
        <SettingsCard>
          <SettingsRow label={message} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const { values, revision } = state;
  const save = (patch: Partial<typeof values>) => void state.save({ ...values, ...patch }, revision);
  return (
    <SettingsSection title="Observer">
      <SettingsCard>
        <SettingsSwitch
          label="Watch agent turns"
          hint="After each completed turn of a top-level agent, a side model looks for something you might miss."
          value={values.enabled}
          disabled={state.saving}
          onValueChange={(enabled) => save({ enabled })}
        />
        <SettingsSelect
          label="Model"
          hint="One call per observed turn. Haiku is cheapest; Sonnet catches more."
          value={values.model}
          options={MODELS.map((m) => ({ label: m, value: m }))}
          disabled={state.saving}
          onValueChange={(model) => {
            const picked = MODELS.find((m) => m === model);
            if (picked) save({ model: picked });
          }}
        />
        <SettingsSelect
          label="Skip turns with fewer tool calls than"
          hint="Short chat turns rarely hide anything."
          value={String(values.minToolCalls)}
          options={MIN_TOOL_CALLS.map((n) => ({ label: String(n), value: String(n) }))}
          disabled={state.saving}
          onValueChange={(n) => save({ minToolCalls: Number(n) })}
        />
        {state.saveError ? <SettingsRow label="Save failed" error={state.saveError} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
