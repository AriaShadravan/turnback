import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { hookResponse, parseHook } from '../src/adapters.js';

const root = mkdtempSync(path.join(tmpdir(), 'turnback-adapters-'));
process.env.TURNBACK_HOME = mkdtempSync(path.join(tmpdir(), 'turnback-adapters-data-'));

it('maps all four agents to neutral events', () => {
  const cases = [
    ['claude', { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'rm a' }, cwd: root }, 'shell'],
    ['codex', { hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', tool_name: 'apply_patch', tool_input: { command: '*** Update File: a.txt' }, cwd: root }, 'edit'],
    ['gemini', { hook_event_name: 'BeforeTool', session_id: 's', tool_name: 'write_file', tool_input: { file_path: 'a.txt' }, cwd: root }, 'edit'],
    ['cursor', { hook_event_name: 'beforeShellExecution', conversation_id: 's', generation_id: 't', command: 'rm a', cwd: root }, 'shell'],
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

it('answers Cursor permission hooks explicitly', () => {
  expect(hookResponse('cursor', 'preToolUse')).toBe('{"permission":"allow"}');
  expect(hookResponse('cursor', 'stop')).toBe('{}');
  expect(hookResponse('claude', 'PreToolUse')).toBe('{}');
});
