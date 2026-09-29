---
name: turns
description: List recent agent turns recorded by Turnback, with their prompts and changed files. Use when the user asks what the agent changed recently or which turn to undo.
argument-hint: "[limit]"
---

Call the `list_turns` tool from the `turnback` MCP server with `workspace` set to the current project directory and `limit` set to "$ARGUMENTS" if it is a number, otherwise 10. Show the result as returned: one line per turn with its number, time, agent, changed files, and prompt, followed by its ID. Mention that `/turnback:diff-turn <id>` shows a turn's changes and `/turnback:undo <id>` restores it.
