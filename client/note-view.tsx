import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Note, followUpText, tagLabel, transitionNote } from "../shared/notes.ts";
import { notesChanged } from "./events.ts";

export const NOTES_QUERY_KEY = ["notes"];
export const POLL_MS = 5_000;

function useNoteActions(agentId: string, note: Note) {
  const paseo = usePaseo();
  const transition = useRpc(transitionNote);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
      notesChanged();
      await queryClient.invalidateQueries({ queryKey: NOTES_QUERY_KEY });
    }
  };

  return {
    pending,
    error,
    dismiss: () => run(() => transition({ agentId, note, to: "dismissed" })),
    // Claim the note before sending, so a second click, the popover copy or another device cannot send it again.
    send: () =>
      run(async () => {
        const claimed = await transition({ agentId, note, to: "sent" });
        if (claimed.status !== "sent") return;
        try {
          await paseo.agents.ref(agentId).send(followUpText(note));
        } catch (err) {
          await transition({ agentId, note: { ...note, status: "sent" }, to: "open" });
          throw err;
        }
      }),
  };
}

function Button({ theme, label, primary, disabled, onPress }: { theme: PluginTheme; label: string; primary?: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
      }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export function NoteView({ theme, agentId, note }: { theme: PluginTheme; agentId: string; note: Note }) {
  const { pending, error, dismiss, send } = useNoteActions(agentId, note);
  const tone = note.tag === "heads_up" ? theme.colors.statusWarning : theme.colors.accent;

  if (note.status !== "open") {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {tagLabel(note.tag)} · {note.status === "sent" ? "sent to agent" : "dismissed"}: {note.title}
      </Text>
    );
  }

  return (
    <View
      style={{
        gap: 6,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: tone,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: tone, fontSize: 12, fontWeight: "600" }}>✦ {tagLabel(note.tag)}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{note.title}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 19 }}>{note.body}</Text>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
        <Button theme={theme} label="Send to agent" primary disabled={pending} onPress={() => void send()} />
        <Button theme={theme} label="Dismiss" disabled={pending} onPress={() => void dismiss()} />
      </View>
    </View>
  );
}
