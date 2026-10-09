import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { HEADING, type Note, followUpText, transitionNote } from "../shared/notes.ts";
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

function Action({ theme, label, disabled, onPress }: { theme: PluginTheme; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textDecorationLine: "underline" }}>{label}</Text>
    </Pressable>
  );
}

// Plain text like an agent reply: a heading, bullets with a bold lead, no box.
export function NoteView({ theme, agentId, note }: { theme: PluginTheme; agentId: string; note: Note }) {
  const { pending, error, dismiss, send } = useNoteActions(agentId, note);

  if (note.status !== "open") {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {HEADING} {note.status === "sent" ? "sent to agent" : "dismissed"} ({note.items.map((i) => i.lead).join(", ")})
      </Text>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{HEADING}</Text>
      {note.items.map((item, index) => (
        <View key={index} style={{ flexDirection: "row", gap: 8, paddingLeft: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>•</Text>
          <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>
            <Text style={{ fontWeight: "700" }}>{item.lead}:</Text> {item.text}
          </Text>
        </View>
      ))}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 12, paddingLeft: 4 }}>
        <Action theme={theme} label="Send to agent" disabled={pending} onPress={() => void send()} />
        <Action theme={theme} label="Dismiss" disabled={pending} onPress={() => void dismiss()} />
      </View>
    </View>
  );
}
