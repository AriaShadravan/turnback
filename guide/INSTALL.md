# Installation

Run `npm ci && npm run build`, then `node dist/cli.js install all` for the user config, or add `--project` for the current repo. Pick one of `claude`, `codex`, `gemini`, `cursor` for a single agent. Run `uninstall` at the same level to remove Turnback entries. Installing again does not duplicate hooks.

Hooks call `node <absolute path>/dist/cli.js hook <agent>` and the MCP server calls `node <absolute path>/dist/cli.js mcp`. Keep the build output where it is after installing. After changing the code, run `npm run build` again. Restart the agent so it reads the config. Codex also asks you to review trust for new hooks via `/hooks`.

Config locations:

| Agent | Project hooks | User hooks | MCP |
|---|---|---|---|
| Claude Code | `.claude/settings.json` | `~/.claude/settings.json` | `.mcp.json` / `~/.claude.json` |
| Codex | `.codex/hooks.json` | `~/.codex/hooks.json` | `.codex/config.toml` / `~/.codex/config.toml` |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` | `mcpServers` in the same settings |
| Cursor | `.cursor/hooks.json` | `~/.cursor/hooks.json` | `.cursor/mcp.json` / `~/.cursor/mcp.json` |

Hook formats were checked against [Claude Code](https://code.claude.com/docs/en/hooks), [Codex](https://learn.chatgpt.com/docs/hooks), [Gemini CLI](https://geminicli.com/docs/hooks/reference/), and [Cursor](https://prod.cursor.com/docs/hooks). Codex provides `turn_id`; Gemini needs a local per-session turn ID. Cursor must receive valid permission JSON from permission hooks, so Turnback returns `{"permission":"allow"}`.
