# Adding an agent

Turnback needs four things from an agent's hooks:

| Turnback event | Why | Examples |
|---|---|---|
| turn start | starts a new turn; carries the user's prompt | Claude Code `UserPromptSubmit`, Gemini CLI `BeforeAgent` |
| before a shell command | snapshot the whole workspace | Claude Code `PreToolUse` with `Bash`, Cursor `beforeShellExecution` |
| before a file edit | snapshot the paths about to change | Claude Code `PreToolUse` with `Edit`/`Write`, Codex `apply_patch` |
| turn end | snapshot the result | Claude Code `Stop`, Gemini CLI `AfterAgent` |

Session start is optional (it warms the first snapshot). The hook must run **before** the tool, and Turnback must be able to answer without blocking it. If an agent has no hooks at all, it can't be supported this way.

## Steps

1. **Read the agent's hook documentation** and link it in the PR. Note the event names, the payload fields for session ID, turn ID (if any), working directory, tool name, command, and file paths, and what the hook must print so the tool is allowed and the user's permission prompt still appears.
2. **Capture a real payload** for each event if you can (a hook that runs `cat > payload.json`), and save a representative one as `test/fixtures/<agent>.json`. Remove anything personal.
3. **Add the agent** to the `Agent` type in `src/core/types.ts`.
4. **Map its payloads** in `src/agents/adapters.ts`: add event names to `SESSION_START`, `TURN_START`, `TURN_END`, or `BEFORE_TOOL`, tool names to `SHELL_TOOLS` or `EDIT_TOOLS`, and path keys to `PATH_KEYS`. If it needs a special neutral response, handle it in `hookResponse`.
5. **Install its hooks** in `src/agents/install.ts`: add an `AgentSpec` to `SPECS` (hook file, events and matchers, timeout unit, file layout, where MCP servers are registered) and the agent to `AGENTS`. OpenCode shows how to handle an agent that uses a plugin instead of hook commands.
6. **Tests:**
   - `test/adapters.test.ts`: each event maps to the right `HookEvent`;
   - `test/cli.test.ts`: the fail-open test loops over every agent's fixture, so add yours to `AGENTS` there;
   - `test/install.test.ts`: install and uninstall keep the user's other config.
7. **Try it live** if you use the agent: install into a scratch project with `TURNBACK_HOME` pointing to a scratch folder, let the agent delete a file with a shell command, then `turnback list` and `turnback undo --yes`. Say in the PR whether you tested live or only from the documentation.
8. **Document it** in `guide/INSTALL.md` and the agent list in `README.md`.

Commit `1a9c1f1` (OpenCode and Antigravity CLI) is a complete example, including a payload without event names and an agent that treats any hook output as a decision.
