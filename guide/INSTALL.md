# Installation

In Claude Code, the plugin is the simplest install: `claude plugin marketplace add MFaizR77/turnback`, then `claude plugin install turnback@turnback`. It brings the hooks, the MCP server, and the `/turnback:undo`, `/turnback:turns`, and `/turnback:diff-turn` commands. While the plugin is enabled, `turnback install claude` skips Claude Code so hooks do not run twice; run `turnback uninstall claude` if you installed hooks manually before.

Run `npm ci && npm run build`, then `node dist/cli.js install all` for the user config, or add `--project` for the current repo. Pick one of `claude`, `codex`, `gemini`, `cursor`, `opencode`, `antigravity` for a single agent. Run `uninstall` at the same level to remove Turnback entries. Installing again does not duplicate hooks.

Hooks call `node <absolute path>/dist/cli.js hook <agent>` and the MCP server calls `node <absolute path>/dist/cli.js mcp`. Keep the build output where it is after installing. After changing the code, run `npm run build` again. Restart the agent so it reads the config. Codex runs project hooks only in a trusted project, and skips every new or changed hook until you trust it in `/hooks`; `codex exec` can bypass that for one run with `--dangerously-bypass-hook-trust`. Codex starts MCP servers with a minimal environment, so the installer forwards `TURNBACK_HOME` through `env_vars`.

Config locations:

| Agent | Project hooks | User hooks | MCP |
|---|---|---|---|
| Claude Code | `.claude/settings.json` | `~/.claude/settings.json` | `.mcp.json` / `~/.claude.json` |
| Codex | `.codex/hooks.json` | `~/.codex/hooks.json` | `.codex/config.toml` / `~/.codex/config.toml` |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` | `mcpServers` in the same settings |
| Cursor | `.cursor/hooks.json` | `~/.cursor/hooks.json` | `.cursor/mcp.json` / `~/.cursor/mcp.json` |
| OpenCode | `.opencode/plugins/turnback.js` | `~/.config/opencode/plugins/turnback.js` | `mcp` in `opencode.json` / `~/.config/opencode/opencode.json` (an existing `opencode.jsonc` is used instead) |
| Antigravity CLI | `.agents/hooks.json` | `~/.gemini/config/hooks.json` | `~/.gemini/config/mcp_config.json` (user level only) |

Hook formats were checked against [Claude Code](https://code.claude.com/docs/en/hooks), [Codex](https://learn.chatgpt.com/docs/hooks), [Gemini CLI](https://geminicli.com/docs/hooks/reference/), and [Cursor](https://prod.cursor.com/docs/hooks). Codex provides `turn_id`; Gemini needs a local per-session turn ID. Cursor must receive valid permission JSON from permission hooks, so Turnback returns `{"permission":"allow"}`.

OpenCode has no command hooks. The installer writes a small plugin that forwards `session.created`, `chat.message`, `tool.execute.before`, and `session.idle` to `turnback hook opencode`; tool calls wait for the snapshot. OpenCode reads `XDG_CONFIG_HOME` when it is set, and so does the installer. Checked against [OpenCode plugins](https://opencode.ai/docs/plugins/) and OpenCode 1.18.

Antigravity CLI hooks ([docs](https://antigravity.google/docs/hooks/)) live under a `turnback` key in `hooks.json`. Its payloads do not name the event, so each hook passes it as an argument, and a turn starts at the `PreInvocation` with `invocationNum` 0. Turnback prints nothing from `PreToolUse`: `{}` or an empty `decision` denies the tool, and `allow` would skip the user's permission prompt. On Windows Antigravity runs hook commands without a shell and passes quotes through, so the CLI path is left unquoted unless it contains spaces; a hook that fails to start blocks the tool. Workspace hooks load only in trusted folders. Antigravity has no project-level MCP config, so `install antigravity --project` installs hooks only; use the user-level install or `agy mcp add turnback node <path>/dist/cli.js mcp` for the MCP server. `agy -p` works in a scratch folder unless the project is passed with `--add-dir`.
