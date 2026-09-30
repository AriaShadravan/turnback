# Architecture

```
agent hook ──► adapters.ts ──► HookEvent ──► recorder.ts ──► Store ──► shadow git repo (~/.turnback/<hash>/repo.git)
                                                              │           journal.jsonl
CLI (main.ts) ─────────────────────────────────────────────────┤
MCP server (server.ts) ────────────────────────────────────────┘──► restore.ts ──► workspace files
```

## Recording

1. The agent runs a hook command, `turnback hook <agent> [event]`, with a JSON payload on stdin.
2. `src/agents/adapters.ts` turns the payload into a `HookEvent`: agent, session, turn, working directory, kind (`session-start`, `turn-start`, `edit`, `shell`, `turn-end`), and the edited paths or shell command. Payloads that don't matter return `undefined`.
3. `src/core/recorder.ts` decides what to snapshot:
   - the first mutating tool of a turn takes the turn **baseline**;
   - a **shell** command snapshots the whole workspace, because it can change anything;
   - an **edit** snapshots only the paths it is about to change;
   - **turn-end** snapshots the result.
4. `src/core/store.ts` writes the snapshot through `src/git/shadow.ts` and appends a journal entry. Each workspace has its own folder under `~/.turnback`, keyed by a hash of its root.
5. The hook prints the agent's neutral response (`hookResponse` in `adapters.ts`) whatever happened.

The first snapshot of a workspace is "warmed" in a background process at install and session start, using `git fast-import`, so the first hook does not pay for it. `src/workspace/workspace.ts` decides which files are in scope: up to 5 MB each, without build output or dependency folders, plus `.turnbackignore`.

## Turns and steps

The journal is a list of entries. `Store.turns()` groups them by agent, session, and turn ID into turns with a baseline and an end snapshot. Each edit or shell entry inside a turn is a step, and its snapshot is the state just before that step. Agents that don't send a turn ID get a local one per session (`localTurn` in `adapters.ts`).

## Restoring

`src/core/restore.ts`:

1. `planRestore` compares the target snapshot with the current files and lists what would be created, reverted, or removed. Files that changed since Turnback's last snapshot are marked uncertain (probably edited by the user). The plan carries a token.
2. `applyRestore` checks the token again under the workspace lock, takes a **safety snapshot** of the current files, then writes the target content. `redo` restores that safety snapshot.

The CLI shows the plan and needs `--yes`; the MCP `restore` tool returns the plan and a `confirm_token` and needs a second call.

## Other readers of the history

All of these only read the journal and snapshots: `list`/`steps`/`log`/`search` (`store.ts`), `report` (`report.ts`), `compare` (`compare.ts`), `export` (`export.ts`, the only code that writes to the user's repository), `turnback ui` (`src/ui/`), and the MCP tools (`src/mcp/server.ts`).

## Folders

| Folder | Contents |
|---|---|
| `src/cli/` | CLI and hook entry point, argument parsing |
| `src/core/` | recorder, store, restore, text output, journal, locking, config, types, report, compare, export, warnings |
| `src/git/` | shadow repo wrapper |
| `src/workspace/` | workspace scan and exclusion rules |
| `src/agents/` | payload adapters, per-agent installation, generated OpenCode plugin |
| `src/mcp/` | stdio MCP server |
| `src/ui/` | read-only local timeline |
| `test/` | vitest suites; `test/fixtures/<agent>.json` holds a sample payload per agent |
