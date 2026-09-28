import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from './core.js';
import type { Agent, HookEvent, Kind } from './types.js';

type Payload = Record<string, any>;
function active(s: Store, session: string, renew = false): string {
  const f = path.join(s.dir, `active-${encodeURIComponent(session).replaceAll('%', '_')}.json`);
  if (!renew && existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')).turn; } catch { /* renew */ } }
  const turn = randomUUID(); mkdirSync(s.dir, { recursive: true }); writeFileSync(f, JSON.stringify({ turn })); return turn;
}
export function parseHook(agent: Agent, p: Payload, fallback = process.cwd()): HookEvent | undefined {
  const cwd = typeof p.cwd === 'string' ? p.cwd : Array.isArray(p.workspace_roots) && p.workspace_roots[0] || fallback;
  const s = new Store(cwd), event = String(p.hook_event_name || p.event || '');
  const session = String(p.session_id || p.conversation_id || 'default');
  const tool = String(p.tool_name || ''); const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  let kind: Kind | undefined;
  if (/^(SessionStart|sessionStart)$/.test(event)) kind = 'session-start';
  else if (/^(UserPromptSubmit|BeforeAgent|beforeSubmitPrompt)$/.test(event)) kind = 'turn-start';
  else if (/^(Stop|AfterAgent|stop)$/.test(event)) kind = 'turn-end';
  else if (/^(PreToolUse|BeforeTool|preToolUse|beforeShellExecution)$/.test(event)) {
    if (event === 'beforeShellExecution' || /^(Bash|PowerShell|Shell|run_shell_command|exec_command)$/.test(tool)) kind = 'shell';
    else if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|write_file|replace|Delete|StrReplace)$/.test(tool)) kind = 'edit';
  }
  if (!kind) return undefined;
  const turn = String(p.turn_id || p.prompt_id || p.generation_id || active(s, session, kind === 'turn-start'));
  const paths: string[] = [];
  for (const key of ['file_path','notebook_path','path']) if (typeof input[key] === 'string') paths.push(input[key]);
  if (Array.isArray(input.edits)) for (const edit of input.edits) if (typeof edit.file_path === 'string') paths.push(edit.file_path);
  const command = String(input.command || p.command || '');
  if (tool === 'apply_patch') for (const m of command.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File: |Move to: )(.+)$/gm)) paths.push(m[1].trim());
  return { agent, session, turn, cwd, kind, paths: paths.length ? [...new Set(paths)] : undefined, command: kind === 'shell' ? command : undefined };
}
export function hookResponse(agent: Agent, event?: string): string { return agent === 'cursor' && (!event || ['preToolUse','beforeShellExecution','beforeSubmitPrompt'].includes(event)) ? '{"permission":"allow"}' : '{}'; }
