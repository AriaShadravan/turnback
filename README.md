# Turnback

Turnback records file state before and during a coding agent's turn, then restores it through the CLI or MCP. The shadow Git repo lives in `~/.turnback` (or `TURNBACK_HOME`), separate from the project's `.git`.

Supports Claude Code, Codex, Gemini CLI, Cursor, OpenCode, and Antigravity CLI. Requires Node.js 22+ and Git 2.25+. Claude Code, Codex, OpenCode, and Antigravity CLI have been tested live; Gemini CLI and Cursor are covered by tests built from their documented hook payloads.

```bash
npm install -g turnback
turnback install all --project
turnback list
turnback diff <turn-id>
turnback undo --dry-run
turnback undo --yes
```

`install all` without `--project` installs the user-level config. `uninstall all [--project]` removes only Turnback entries. `--no-mcp` installs hooks without MCP. Other config is kept.

Available commands: `install`, `uninstall`, `list`, `diff`, `status`, `restore`, `undo`, `redo`, `gc`, and `mcp`. `restore <turn> --path <file> --dry-run` shows the plan. `--yes` applies it. `redo --yes` returns to the safety snapshot taken before the last restore. Restoring changes project files; the agent's conversation context is not restored.

Documentation: [installation](guide/INSTALL.md), [restore](guide/RESTORE.md), [MCP](guide/MCP.md), and [scope](guide/LIMITS.md).

## How it works

The hook before a mutating tool takes the turn baseline. The hook before a shell command captures the whole tree; later edits capture the affected paths. The end of the turn captures the result. The initial snapshot is warmed in the background on install and session start. Hooks always let the agent continue when recording fails; a `failed`, `skipped`, or `unprotected` state is visible through `status`.

Tracked, untracked, and gitignored files up to 5 MB are covered. Build output and dependency directories are excluded. Extra rules use gitignore syntax in `.turnbackignore`; global rules go in `~/.turnback/config.json` as `{"exclude":["pattern"]}`.

Workspaces above 100k files or 2 GB switch to `edits-only` mode: only paths touched by edit tools are snapshotted, shell commands are recorded as `unprotected`, and restore touches only recorded paths. Turns older than 7 days and outside the last 50 turns are cleaned up automatically, at most once a day.

## Development

| Module | Contents |
|---|---|
| `src/cli.ts` | CLI and hook entry point |
| `src/adapters.ts` | Each agent's hook payload → `HookEvent` |
| `src/recorder.ts` | Snapshot rules per event |
| `src/store.ts` | Journal, snapshots, turn history, status, `gc` |
| `src/restore.ts` | Restore planning and execution, undo, redo |
| `src/shadow.ts` | Shadow git repo wrapper |
| `src/workspace.ts` | Workspace scanning and exclusion rules |
| `src/journal.ts`, `src/lock.ts`, `src/config.ts` | JSONL journal, per-workspace lock, constants |
| `src/install.ts` | Hook and MCP installation per agent |
| `src/mcp.ts` | Stdio MCP server |

```bash
npm run check
npm run bench
```

The benchmark creates a temporary 10k-file repo and reports latency without making it a strict CI gate. CI runs the tests and benchmark on Windows, macOS, and Linux × Node 22/24.

From a clone, run `npm ci && npm run build` and use `node dist/cli.js` in place of `turnback`.

## Releasing

Set the same version in `package.json` and in both version fields of `server.json`, commit, then push a `v<version>` tag. The `Publish` workflow checks that the versions match, runs the tests, publishes to npm through trusted publishing (provenance is attached automatically), and publishes `server.json` to the MCP registry as `io.github.MFaizR77/turnback`.

npm trusted publishing is configured on the package page at npmjs.com (repository `MFaizR77/turnback`, workflow `publish.yml`), which needs the package to exist. The first version is therefore published once by hand with `npm publish --access public`; pushing its tag afterwards skips npm (the version exists) and only publishes to the MCP registry. Later tags do both.

## License

MIT
