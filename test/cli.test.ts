import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { CLI, tempProject } from './helpers.js';

const AGENTS = ['claude', 'codex', 'gemini', 'cursor'];

function cli(root: string, home: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: 'utf8', env: { ...process.env, TURNBACK_HOME: home } });
}

it('every agent hook fails open when storage cannot be created', () => {
  const p = tempProject('turnback-hooks-');
  p.write('a.txt', 'x');
  const blockedHome = p.file('blocking-file');
  writeFileSync(blockedHome, 'not a directory');
  for (const agent of AGENTS) {
    const payload = readFileSync(path.resolve(`test/fixtures/${agent}.json`), 'utf8');
    const r = cli(p.root, blockedHome, ['hook', agent], payload);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(agent === 'cursor' ? { permission: 'allow' } : {});
  }
});

it('serializes ten concurrent hooks without blocking agent tools', async () => {
  const p = tempProject('turnback-parallel-');
  p.write('a.txt', 'x');
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: p.root });
  const run = () => new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(process.execPath, [CLI, 'hook', 'codex'], { cwd: p.root, env: { ...process.env, TURNBACK_HOME: p.home }, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.on('close', code => resolve({ code, output }));
    child.stdin.end(payload);
  });

  const results = await Promise.all(Array.from({ length: 10 }, run));
  expect(results.every(r => r.code === 0 && r.output.trim() === '{}')).toBe(true);
  const entries = new Store(p.root).entries().filter(e => e.agent === 'codex');
  expect(entries.length).toBeGreaterThanOrEqual(10);
  expect(entries.every(e => e.status === 'ok' || e.status === 'skipped')).toBe(true);
}, 30_000);

it('undoes a destructive shell turn end to end through the CLI', () => {
  const p = tempProject('turnback-e2e-');
  mkdirSync(p.file('src'));
  p.write('src/app.ts', 'export const app = 1;\n');
  p.write('.gitignore', '.env\n');
  p.write('.env', 'SECRET=1\n');
  const send = (payload: object) => cli(p.root, p.home, ['hook', 'claude'], JSON.stringify({ session_id: 's', cwd: p.root, ...payload }));

  send({ hook_event_name: 'UserPromptSubmit', prompt: 'clean up' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf src .env' } });
  rmSync(p.file('src'), { recursive: true });
  rmSync(p.file('.env'));
  p.write('junk.txt', 'junk');
  send({ hook_event_name: 'Stop' });

  const list = JSON.parse(cli(p.root, p.home, ['list']).stdout);
  expect(list).toHaveLength(1);
  expect(list[0].changedFiles).toBe(3);

  const dry = cli(p.root, p.home, ['undo', '--dry-run']);
  expect(dry.status).toBe(0);
  expect(existsSync(p.file('src/app.ts'))).toBe(false);

  const undo = cli(p.root, p.home, ['undo', '--yes']);
  expect(undo.status).toBe(0);
  expect(p.read('src/app.ts')).toBe('export const app = 1;\n');
  expect(p.read('.env')).toBe('SECRET=1\n');
  expect(existsSync(p.file('junk.txt'))).toBe(false);

  expect(cli(p.root, p.home, ['redo', '--yes']).status).toBe(0);
  expect(existsSync(p.file('src/app.ts'))).toBe(false);
  expect(p.read('junk.txt')).toBe('junk');
}, 30_000);

it('prints usage and exits 2 for an unknown command', () => {
  const p = tempProject('turnback-usage-');
  const r = cli(p.root, p.home, ['bogus']);
  expect(r.status).toBe(2);
  expect(r.stdout).toMatch(/Usage:/);
});
