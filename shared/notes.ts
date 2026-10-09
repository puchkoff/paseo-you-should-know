import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CARD_KIND = "note";
export const CARD_VERSION = 2;
export const HEADING = "Things you should know:";

// One bullet: a bold lead naming the subject, then the plain fact.
export const itemSchema = z.object({ lead: z.string(), text: z.string() });
export type Item = z.output<typeof itemSchema>;

export const noteSchema = z.object({
  id: z.string(),
  items: z.array(itemSchema).min(1),
  status: z.enum(["open", "dismissed", "sent"]),
});
export type Note = z.output<typeof noteSchema>;

// Version 1 cards (one tagged title + body) still sit in live timelines after an upgrade.
export const legacyNoteSchema = z.object({
  id: z.string(),
  tag: z.string(),
  title: z.string(),
  body: z.string(),
  status: noteSchema.shape.status,
});

export function fromLegacy(note: z.output<typeof legacyNoteSchema>): Note {
  return { id: note.id, status: note.status, items: [{ lead: note.title, text: note.body }] };
}

export function itemLine(item: Item): string {
  return `${item.lead}: ${item.text}`;
}

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
    // Sonnet: the stuck and simpler checks need judgment, not pattern matching.
    model: z.enum(MODELS).default("sonnet"),
    // Turns with fewer tool calls are chat, not work, and are skipped to save model calls.
    minToolCalls: z.number().int().min(0).default(3),
  }),
});

// What "Send to agent" puts in the agent's composer.
export function followUpText(note: Pick<Note, "items">): string {
  const bullets = note.items.map((i) => `- ${itemLine(i)}`).join("\n");
  return `A side observer flagged this after your last turn:\n\n${bullets}\n\nCheck whether it is right. Act on it, or tell me why not.`;
}
