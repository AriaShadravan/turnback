import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { hookResponse, parseHook } from '../src/adapters.js';

const root = mkdtempSync(path.join(tmpdir(), 'turnback-adapters-'));
process.env.TURNBACK_HOME = mkdtempSync(path.join(tmpdir(), 'turnback-adapters-data-'));

it('maps all agents to neutral events', () => {
  const cases = [
    ['claude', { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'rm a' }, cwd: root }, 'shell'],
    ['codex', { hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', tool_name: 'apply_patch', tool_input: { command: '*** Update File: a.txt' }, cwd: root }, 'edit'],
    ['gemini', { hook_event_name: 'BeforeTool', session_id: 's', tool_name: 'write_file', tool_input: { file_path: 'a.txt' }, cwd: root }, 'edit'],
    ['cursor', { hook_event_name: 'beforeShellExecution', conversation_id: 's', generation_id: 't', command: 'rm a', cwd: root }, 'shell'],
    ['opencode', { hook_event_name: 'tool.execute.before', session_id: 's', tool_name: 'edit', tool_input: { filePath: 'a.txt' }, cwd: root }, 'edit'],
    ['opencode', { hook_event_name: 'session.idle', session_id: 's', cwd: root }, 'turn-end'],
    ['claude', { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, cwd: root }, undefined],
  ] as const;
  for (const [agent, payload, kind] of cases) expect(parseHook(agent, payload)?.kind).toBe(kind);
});

it('resolves edit paths against the hook cwd, including apply_patch moves', () => {
  const sub = path.join(root, 'sub');
  const event = parseHook('codex', {
    hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', tool_name: 'apply_patch', cwd: sub,
    tool_input: { command: '*** Update File: a.txt\n*** Move to: b.txt\n*** Add File: dir/c.txt' },
  });
  expect(event?.paths).toEqual(['a.txt', 'b.txt', 'dir/c.txt'].map(f => path.resolve(sub, f)));
});

it('keeps one local turn id per session until the next prompt', () => {
  const base = { session_id: 'g', cwd: root };
  const start = parseHook('gemini', { ...base, hook_event_name: 'BeforeAgent' })!;
  const tool = parseHook('gemini', { ...base, hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: 'a' } })!;
  const next = parseHook('gemini', { ...base, hook_event_name: 'BeforeAgent' })!;
  expect(tool.turn).toBe(start.turn);
  expect(next.turn).not.toBe(start.turn);
});

it('reads Antigravity events from the argument and tool calls from toolCall', () => {
  const base = { conversationId: 'c', workspacePaths: [root] };
  const parse = (event: string, extra: object = {}) => parseHook('antigravity', { ...base, ...extra }, root, event);
  expect(parse('PreInvocation', { invocationNum: 0 })?.kind).toBe('turn-start');
  expect(parse('PreInvocation', { invocationNum: 3 })).toBeUndefined();
  const edit = parse('PreToolUse', { toolCall: { name: 'replace_file_content', args: { TargetFile: 'C:/x/a.txt' } } });
  expect(edit).toMatchObject({ kind: 'edit', session: 'c', cwd: root, paths: [path.resolve(root, 'C:/x/a.txt')] });
  expect(parse('PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'rm a' } } })).toMatchObject({ kind: 'shell', command: 'rm a' });
  expect(parse('PreToolUse', { toolCall: { name: 'view_file', args: { AbsolutePath: 'a' } } })).toBeUndefined();
  expect(parse('Stop')?.kind).toBe('turn-end');
});

it('reads OpenCode apply_patch paths from patchText', () => {
  const event = parseHook('opencode', {
    hook_event_name: 'tool.execute.before', session_id: 's', cwd: root, tool_name: 'apply_patch',
    tool_input: { patchText: '*** Begin Patch\n*** Add File: n.txt\n+x\n*** End Patch' },
  });
  expect(event?.paths).toEqual([path.resolve(root, 'n.txt')]);
});

it('answers Cursor permission hooks explicitly', () => {
  expect(hookResponse('cursor', 'preToolUse')).toBe('{"permission":"allow"}');
  expect(hookResponse('cursor', 'stop')).toBe('{}');
  expect(hookResponse('claude', 'PreToolUse')).toBe('{}');
  expect(hookResponse('antigravity', 'PreToolUse')).toBe('');
});
