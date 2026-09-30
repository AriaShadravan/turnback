import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { workspaceDataDir, workspaceRoot } from '../core/config.js';
import type { Agent, HookEvent, HookKind } from '../core/types.js';

type Payload = Record<string, any>;

// OpenCode events come from the generated plugin, which names them after the plugin hooks.
const SESSION_START = new Set(['SessionStart', 'sessionStart', 'session.created']);
const TURN_START = new Set(['UserPromptSubmit', 'BeforeAgent', 'beforeSubmitPrompt', 'chat.message']);
const TURN_END = new Set(['Stop', 'AfterAgent', 'stop', 'session.idle']);
const BEFORE_TOOL = new Set(['PreToolUse', 'BeforeTool', 'preToolUse', 'beforeShellExecution', 'tool.execute.before']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell', 'run_shell_command', 'exec_command', 'bash', 'run_command']);
const EDIT_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace', 'Delete', 'StrReplace',
  'edit', 'write', 'multiedit', 'patch', 'write_to_file', 'replace_file_content', 'multi_replace_file_content',
]);
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath', 'TargetFile'];
/** Agents whose end-of-turn hook shows `systemMessage` to the user without changing what the agent does. */
const WARNING_AGENTS = new Set<Agent>(['claude']);
/** Cursor events that must be answered with an explicit permission; empty output can block the tool. */
const CURSOR_PERMISSION_EVENTS = new Set(['preToolUse', 'beforeShellExecution', 'beforeSubmitPrompt']);

/**
 * Translate an agent hook payload into a `HookEvent`, or `undefined` for irrelevant events.
 * `eventName` is used when the payload does not name its event (Antigravity).
 */
export function parseHook(agent: Agent, p: Payload, fallbackCwd = process.cwd(), eventName = ''): HookEvent | undefined {
  const event = String(p.hook_event_name || p.event || eventName);
  const tool = String(p.tool_name || p.toolCall?.name || '');
  const kind = eventKind(event, tool, p);
  if (!kind) return undefined;

  const roots = p.workspace_roots ?? p.workspacePaths;
  const cwd: string = typeof p.cwd === 'string' ? p.cwd : Array.isArray(roots) && roots[0] || fallbackCwd;
  const session = String(p.session_id || p.conversation_id || p.conversationId || 'default');
  const turn = String(p.turn_id || p.prompt_id || p.generation_id || localTurn(cwd, session, kind === 'turn-start'));
  const rawInput = p.tool_input ?? p.toolCall?.args;
  const input: Payload = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const command = String(input.command || input.CommandLine || p.command || '');
  const paths = [...new Set(toolPaths(tool, input, command).map(f => path.resolve(cwd, f)))];
  const prompt = kind === 'turn-start' && typeof p.prompt === 'string' ? p.prompt : undefined;

  return {
    agent, session, turn, cwd, kind,
    paths: paths.length ? paths : undefined,
    command: kind === 'shell' ? command : undefined,
    prompt,
  };
}

/**
 * Neutral response for each agent. Turnback hooks never block a tool.
 * Antigravity gets no output: `{}` or an empty `decision` denies the tool, and `allow` would skip
 * the user's permission prompt.
 */
export function hookResponse(agent: Agent, event?: string, message?: string): string {
  if (agent === 'antigravity') return '';
  // Only `systemMessage`: a Stop `decision` would make the agent keep working.
  if (message && WARNING_AGENTS.has(agent)) return JSON.stringify({ systemMessage: message });
  return agent === 'cursor' && (!event || CURSOR_PERMISSION_EVENTS.has(event)) ? '{"permission":"allow"}' : '{}';
}

function eventKind(event: string, tool: string, p: Payload): HookKind | undefined {
  if (SESSION_START.has(event)) return 'session-start';
  if (TURN_START.has(event)) return 'turn-start';
  // Antigravity calls PreInvocation before every model call; `invocationNum` restarts at 0 each turn.
  if (event === 'PreInvocation') return p.invocationNum === 0 ? 'turn-start' : undefined;
  if (TURN_END.has(event)) return 'turn-end';
  if (!BEFORE_TOOL.has(event)) return undefined;
  if (event === 'beforeShellExecution' || SHELL_TOOLS.has(tool)) return 'shell';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  return undefined;
}

function toolPaths(tool: string, input: Payload, command: string): string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) if (typeof input[key] === 'string') paths.push(input[key]);
  if (Array.isArray(input.edits)) for (const edit of input.edits) if (typeof edit?.file_path === 'string') paths.push(edit.file_path);
  if (tool === 'apply_patch' || tool === 'patch') {
    const patch = String(input.patchText || command);
    for (const m of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File: |Move to: )(.+)$/gm)) paths.push(m[1].trim());
  }
  return paths;
}

/**
 * Agents without a turn ID (Gemini, OpenCode, Antigravity, some Claude Code payloads) use a local per-session ID:
 * created when a turn starts, then read by the following events.
 */
function localTurn(cwd: string, session: string, renew: boolean): string {
  const dir = workspaceDataDir(workspaceRoot(cwd));
  const file = path.join(dir, `active-${encodeURIComponent(session).replaceAll('%', '_')}.json`);
  if (!renew && existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')).turn; } catch { /* create a new one */ }
  }
  const turn = randomUUID();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ turn }));
  return turn;
}
