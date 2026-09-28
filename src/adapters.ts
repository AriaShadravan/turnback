import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { workspaceDataDir, workspaceRoot } from './config.js';
import type { Agent, HookEvent, HookKind } from './types.js';

type Payload = Record<string, any>;

const SESSION_START = new Set(['SessionStart', 'sessionStart']);
const TURN_START = new Set(['UserPromptSubmit', 'BeforeAgent', 'beforeSubmitPrompt']);
const TURN_END = new Set(['Stop', 'AfterAgent', 'stop']);
const BEFORE_TOOL = new Set(['PreToolUse', 'BeforeTool', 'preToolUse', 'beforeShellExecution']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell', 'run_shell_command', 'exec_command']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace', 'Delete', 'StrReplace']);
/** Cursor events that must be answered with an explicit permission; empty output can block the tool. */
const CURSOR_PERMISSION_EVENTS = new Set(['preToolUse', 'beforeShellExecution', 'beforeSubmitPrompt']);

/** Translate an agent hook payload into a `HookEvent`, or `undefined` for irrelevant events. */
export function parseHook(agent: Agent, p: Payload, fallbackCwd = process.cwd()): HookEvent | undefined {
  const event = String(p.hook_event_name || p.event || '');
  const tool = String(p.tool_name || '');
  const kind = eventKind(event, tool);
  if (!kind) return undefined;

  const cwd: string = typeof p.cwd === 'string' ? p.cwd : Array.isArray(p.workspace_roots) && p.workspace_roots[0] || fallbackCwd;
  const session = String(p.session_id || p.conversation_id || 'default');
  const turn = String(p.turn_id || p.prompt_id || p.generation_id || localTurn(cwd, session, kind === 'turn-start'));
  const input: Payload = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const command = String(input.command || p.command || '');
  const paths = [...new Set(toolPaths(tool, input, command).map(f => path.resolve(cwd, f)))];

  return {
    agent, session, turn, cwd, kind,
    paths: paths.length ? paths : undefined,
    command: kind === 'shell' ? command : undefined,
  };
}

/** "Allow" response for each agent. Turnback hooks never block a tool. */
export function hookResponse(agent: Agent, event?: string): string {
  return agent === 'cursor' && (!event || CURSOR_PERMISSION_EVENTS.has(event)) ? '{"permission":"allow"}' : '{}';
}

function eventKind(event: string, tool: string): HookKind | undefined {
  if (SESSION_START.has(event)) return 'session-start';
  if (TURN_START.has(event)) return 'turn-start';
  if (TURN_END.has(event)) return 'turn-end';
  if (!BEFORE_TOOL.has(event)) return undefined;
  if (event === 'beforeShellExecution' || SHELL_TOOLS.has(tool)) return 'shell';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  return undefined;
}

function toolPaths(tool: string, input: Payload, command: string): string[] {
  const paths: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path']) if (typeof input[key] === 'string') paths.push(input[key]);
  if (Array.isArray(input.edits)) for (const edit of input.edits) if (typeof edit?.file_path === 'string') paths.push(edit.file_path);
  if (tool === 'apply_patch') {
    for (const m of command.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File: |Move to: )(.+)$/gm)) paths.push(m[1].trim());
  }
  return paths;
}

/**
 * Agents without a turn ID (Gemini, some Claude Code payloads) use a local per-session ID:
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
