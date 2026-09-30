import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CLI, tempProject } from './helpers.js';

function claudeTurn(p: ReturnType<typeof tempProject>, change: () => void) {
  const send = (payload: object) => spawnSync(process.execPath, [CLI, 'hook', 'claude'], {
    cwd: p.root, input: JSON.stringify({ session_id: 's', cwd: p.root, ...payload }), encoding: 'utf8',
    env: { ...process.env, TURNBACK_HOME: p.home }, windowsHide: true,
  });
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'clean up' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cleanup' } });
  change();
  return send({ hook_event_name: 'Stop' });
}

function manyFiles(p: ReturnType<typeof tempProject>, n: number) {
  mkdirSync(p.file('src'));
  for (let i = 0; i < n; i++) p.write(`src/f${i}.txt`, String(i));
}

it('warns when a turn deletes many files, without a decision field', () => {
  const p = tempProject('turnback-warn-');
  manyFiles(p, 25);
  const r = claudeTurn(p, () => rmSync(p.file('src'), { recursive: true }));
  const out = JSON.parse(r.stdout);
  expect(Object.keys(out)).toEqual(['systemMessage']);
  expect(out.systemMessage).toMatch(/deleted 25 files/);
  expect(out.systemMessage).toContain('turnback undo');
}, 90_000);

it('warns when a turn changes secrets', () => {
  const p = tempProject('turnback-warn-env-');
  p.write('.env', 'A=1\n');
  const r = claudeTurn(p, () => p.write('.env', 'A=2\n'));
  expect(JSON.parse(r.stdout).systemMessage).toMatch(/changed \.env/);
}, 90_000);

it('stays quiet for ordinary turns and respects config', () => {
  const p = tempProject('turnback-warn-quiet-');
  manyFiles(p, 5);
  expect(JSON.parse(claudeTurn(p, () => p.write('src/f1.txt', 'x')).stdout)).toEqual({});

  const q = tempProject('turnback-warn-config-');
  manyFiles(q, 5);
  writeFileSync(path.join(q.home, 'config.json'), JSON.stringify({ warnDeletes: 3 }));
  expect(JSON.parse(claudeTurn(q, () => rmSync(q.file('src'), { recursive: true })).stdout).systemMessage).toMatch(/deleted 5 files/);

  const off = tempProject('turnback-warn-off-');
  manyFiles(off, 25);
  writeFileSync(path.join(off.home, 'config.json'), JSON.stringify({ warnings: false }));
  expect(JSON.parse(claudeTurn(off, () => rmSync(off.file('src'), { recursive: true })).stdout)).toEqual({});
}, 90_000);
