import { randomUUID } from "node:crypto";
import type { PluginHookContext, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { digestTurn } from "./server/digest.ts";
import { firstLine, resolveBin, runCommand } from "./server/exec.ts";
import { gitState } from "./server/git.ts";
import { askObserver, buildInput } from "./server/observer.ts";
import { createStore } from "./server/store.ts";
import { CARD_KIND, CARD_VERSION, type Note, listNotes, preferences, transitionNote } from "./shared/notes.ts";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type Paseo = PluginHookContext["paseo"];

const log = (message: string) => console.log(`[you-should-know] ${message}`);

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const store = createStore();
  const claude = resolveBin("claude");
  const git = resolveBin("git");
  const lifetime = new AbortController();
  // One observer call per agent at a time; a turn that ends meanwhile replaces the queued one.
  const busy = new Set<string>();
  const queued = new Map<string, TurnEnded>();
  // An observer call in flight when its agent is archived must not bring the agent's notes back.
  const archived = new Set<string>();
  let lastSettingsProblem = "";

  const appendCard = (paseo: Paseo, agentId: string, note: Note) =>
    paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: note.id, kind: CARD_KIND, version: CARD_VERSION, data: { ...note } });

  async function observe(event: TurnEnded, paseo: Paseo) {
    const state = await settings.read();
    if (state.status !== "ready") {
      // Logged once per distinct problem: an invalid stored document would otherwise pause the observer silently.
      if (state.error !== lastSettingsProblem) console.error(`[you-should-know] settings unusable, observer paused: ${state.error}`);
      lastSettingsProblem = state.error;
      return;
    }
    lastSettingsProblem = "";
    if (!state.values.enabled) return;
    const { agent } = event;
    if (!agent.workspaceId) return log(`agent ${agent.id}: skipped, it has no workspace to show a note in`);
    const digest = digestTurn(event.timeline);
    if (!digest || digest.toolCalls < state.values.minToolCalls)
      return log(`agent ${agent.id}: skipped, ${digest?.toolCalls ?? 0} tool calls < ${state.values.minToolCalls}`);
    const input = buildInput(digest, await gitState(runCommand, git, agent.cwd, lifetime.signal), agent.cwd, store.titles(agent.id));
    const started = Date.now();
    const finding = await askObserver(runCommand, claude, state.values.model, input, lifetime.signal);
    if (archived.has(agent.id)) return;
    log(`agent ${agent.id}: ${finding ? `${finding.tag} "${finding.title}"` : "nothing"} (${Date.now() - started} ms)`);
    if (!finding) return;
    const note: Note = { id: randomUUID(), ...finding, status: "open" };
    await appendCard(paseo, agent.id, note);
    store.add(agent.id, agent.workspaceId, note);
  }

  async function drain(agentId: string, paseo: Paseo) {
    busy.add(agentId);
    try {
      for (let event = queued.get(agentId); event; event = queued.get(agentId)) {
        queued.delete(agentId);
        try {
          await observe(event, paseo);
        } catch (err) {
          if (lifetime.signal.aborted) return;
          console.error(`[you-should-know] agent ${agentId}: ${firstLine(err)}`);
        }
      }
    } finally {
      busy.delete(agentId);
    }
  }

  server.on("agent.turn_ended", (event, { paseo }) => {
    // Canceled and failed turns already have the user's eye. parentAgentId is not a filter: it marks
    // agents started by another Paseo agent (handoffs, advisors), which do real work too.
    if (event.outcome.kind !== "completed" || archived.has(event.agent.id))
      return log(`agent ${event.agent.id}: skipped, turn ${event.outcome.kind}${archived.has(event.agent.id) ? ", agent archived" : ""}`);
    queued.set(event.agent.id, event);
    // Not awaited: the model call can outlast the 30 s hook timeout.
    if (!busy.has(event.agent.id)) void drain(event.agent.id, paseo);
  });

  server.on("agent.archived", ({ agent }) => {
    archived.add(agent.id);
    queued.delete(agent.id);
    store.forget(agent.id);
  });

  server.handle(listNotes, () => ({ agents: store.open() }));

  server.handle(transitionNote, async ({ agentId, note: seen, to }, { paseo }) => {
    const { note, changed } = store.transition(agentId, seen, to);
    if (changed) await appendCard(paseo, agentId, note);
    return { status: note.status };
  });

  return () => lifetime.abort();
}
