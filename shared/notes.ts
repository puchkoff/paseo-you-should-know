import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CARD_KIND = "note";
export const CARD_VERSION = 1;

export const TAGS = ["you_should_know", "heads_up"] as const;
export type Tag = (typeof TAGS)[number];

export const noteSchema = z.object({
  id: z.string(),
  tag: z.enum(TAGS),
  title: z.string(),
  body: z.string(),
  status: z.enum(["open", "dismissed", "sent"]),
});
export type Note = z.output<typeof noteSchema>;

export const listNotes = defineRpc({
  name: "notes.list",
  input: z.object({}),
  output: z.object({
    agents: z.array(z.object({ agentId: z.string(), workspaceId: z.string(), notes: z.array(noteSchema) })),
  }),
});

// Compare-and-set: applies only while the note still has the status the caller saw (note.status).
// The caller sends the whole note so a card that outlived a daemon restart can still be resolved.
export const transitionNote = defineRpc({
  name: "notes.transition",
  input: z.object({ agentId: z.string(), note: noteSchema, to: noteSchema.shape.status }),
  output: z.object({ status: noteSchema.shape.status }),
});

export const MODELS = ["haiku", "sonnet", "opus"] as const;
export const MIN_TOOL_CALLS = [0, 1, 3, 5, 10] as const;

export const preferences = defineSettings({
  id: "observer",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    model: z.enum(MODELS).default("sonnet"),
    // Turns with fewer tool calls are chat, not work, and are skipped to save model calls.
    minToolCalls: z.number().int().min(0).default(3),
  }),
});

export function tagLabel(tag: Tag): string {
  return tag === "heads_up" ? "Heads up" : "You should know";
}

// What "Send to agent" puts in the agent's composer.
export function followUpText(note: Pick<Note, "title" | "body">): string {
  return `A side observer flagged this after your last turn:\n\n${note.title}\n${note.body}\n\nCheck whether it is right. Act on it, or tell me why not.`;
}
