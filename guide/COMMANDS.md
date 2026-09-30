# Commands

Every command prints text for people. Where noted, `--json` prints the raw data instead.

| Command | What it does |
|---|---|
| `install <agent\|all> [--project] [--no-mcp]` | Adds Turnback hooks (and the MCP server unless `--no-mcp`) to the agent's config. Without `--project` it writes the user-level config. Other config is kept. |
| `uninstall <agent\|all> [--project]` | Removes only Turnback entries. |
| `list [--json]` | Turns, newest first: prompt, agent, and changed file count. |
| `diff <turn>` | Patch of what the turn changed. |
| `undo [--dry-run \| --yes] [--json]` | Returns the files to how they were before the latest turn. Run again to go one turn further back. |
| `redo [--dry-run \| --yes] [--json]` | Returns to the safety snapshot taken before the last restore or undo. |
| `restore <turn\|mark\|snapshot> [--path <p>...] [--dry-run \| --yes] [--json]` | Returns to the start of a turn, a mark, or a snapshot ref. `--path` limits it to some files. Without `--yes` it only prints the plan. |
| `recover <file> [--dry-run \| --yes] [--json]` | Brings back one file: the newest snapshot whose version differs from the file on disk, or, for a deleted file, the last snapshot that still had it. Other files are left alone. |
| `steps <turn> [--json]` | Each edit and shell command of a turn. |
| `restore <turn> --before-step N` | Returns to just before step N and keeps the earlier steps. |
| `log <file\|folder> [--json]` | Turns that changed that path. |
| `search <text> [--json]` | Turns whose prompt, command, or paths match. |
| `mark <label>` / `marks [--json]` | Saves the whole workspace as a checkpoint that `restore <label>` returns to. |
| `ui [--port <n>] [--no-open]` | Read-only timeline of turns, steps, and diffs in the browser. |
| `report [--session <id>]` | Markdown summary of the latest session, for a PR description or an audit. |
| `compare <a> <b> [--json]` | How two turns' results differ, for example two agents given the same task. |
| `export <turn...> [--out <file>]` | Prints the turns as a patch, or writes it to a file. |
| `export <turn...> --commit [--message <text>]` | Commits just those turns' files to your repository with the prompt as message, and refuses if they changed since. It is the only command that writes to your own git repository. |
| `status [--json]` | Workspace, mode, storage, and any failed or skipped snapshots. |
| `gc` | Cleans up turns older than 7 days that are outside the last 50. Runs automatically at most once a day. |
| `mcp` | Starts the stdio MCP server (see [MCP](MCP.md)). |

Restoring changes project files; the agent's conversation is not restored, so tell the agent what changed.

Set `{"prompts": false}` in `~/.turnback/config.json` to stop recording prompts.
