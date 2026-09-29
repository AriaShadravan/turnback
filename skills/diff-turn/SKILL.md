---
name: diff-turn
description: Show the file changes made during one agent turn recorded by Turnback. Use when the user asks what a specific turn changed.
argument-hint: "[turn-id]"
---

1. If "$ARGUMENTS" is empty, call `list_turns` from the `turnback` MCP server with `limit` 1 and use that turn's ID; otherwise use "$ARGUMENTS". Always pass `workspace` set to the current project directory.
2. Call `diff_turn` with that `turn` and `patch` true.
3. Summarize the changes per file in a few lines, then show the patch. If the result says `truncated`, say so and offer to run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" diff <turn>` for the full patch.
