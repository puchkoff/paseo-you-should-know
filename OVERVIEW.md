A side observer for your agents. After an agent finishes a turn, a separate model reads that turn and the git state of the agent's working directory, and looks for what you are likely to miss. When it finds something, a note appears in the agent's timeline, right after the agent's reply. Most turns produce no note.

The note reads like the reply itself, with no box: the line **Things you should know:** and one to four bullets. Each bullet starts with a bold lead naming the subject, then says what is true and what to do. Typical findings:

- Something is wrong, unfinished or risky and the reply hides or understates it. For example, success claimed while a test failed, work committed but not pushed, or part of the request skipped.
- The agent is stuck, for example the same command failing again and again, a file edited back and forth, or a check silenced instead of fixed.
- The agent does far more work than needed, and the note names the concrete smaller path.
- A non-obvious fact from the turn that matters for your next decision.

Under the bullets, **Send to agent** sends the note to the agent as your next message, and **Dismiss** hides it. Agents with open notes get a pill in the composer showing the count. Tap it to see the notes.

## How it works

The plugin watches completed turns of every agent on the daemon, including agents that other agents started. Canceled and failed turns are skipped. For each turn it builds a short digest: your recent requests, the agent's reply, a brief outline of the two turns before, its tool calls (with output only for commands that look failed, and a clipped diff of each edit), the commands and files it repeated, the branch, uncommitted files and unpushed commits. It sends that digest to `claude -p`, with no tools, settings, MCP servers or saved session, so the side call cannot act or edit files. Only one call per agent runs at a time. The main agent is never interrupted.

## Setup

Needs the `claude` CLI on the daemon machine, logged in. Each observed turn is one model call on your account. Settings → Plugins → You should know has the following options:

- **Watch agent turns**: turns the observer on or off.
- **Model**: sonnet (default), haiku (faster, about 3 to 5 seconds per turn, but weak at spotting a stuck agent or a simpler path) or opus.
- **Skip turns with fewer tool calls than**: default 3. Short chat turns are skipped.

## Limits

Notes live in daemon memory, like the timeline rows that show them. A daemon restart clears them. The observer sees a digest, not full file contents or command output, so it can be wrong. Check a note before acting on it.
