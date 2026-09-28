import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyRestore, planRestore, redoTarget, undoTarget } from '../src/restore.js';
import { Store } from '../src/store.js';
import { hook, tempProject } from './helpers.js';

let p: ReturnType<typeof tempProject>;
beforeEach(() => { p = tempProject(); });

describe('snapshot and restore', () => {
  it('restores tracked, ignored, deleted and byte-exact files without changing user .git', () => {
    const env = Buffer.from([0xef, 0xbb, 0xbf, 13, 10, 0, 255]);
    p.write('.gitignore', '.env\n');
    p.write('.env', env);
    p.write('a.txt', 'before\r\n');
    const gitHead = readFileSync(p.file('.git/HEAD'));

    expect(hook(p.root, 'shell', 't1', { command: 'rm .env' })?.status).toBe('ok');
    p.write('a.txt', 'after');
    p.write('new.txt', 'new');
    rmSync(p.file('.env'));
    expect(hook(p.root, 'turn-end')?.status).toBe('ok');

    const s = new Store(p.root);
    const plan = planRestore(s, 't1');
    expect(plan.scope).toBe('workspace');
    expect(plan.actions.map(a => `${a.action}:${a.path}`)).toEqual(['create:.env', 'modify:a.txt', 'delete:new.txt']);

    const result = applyRestore(s, 't1', { token: plan.token });
    expect(result.failed).toEqual([]);
    expect(p.read('a.txt')).toBe('before\r\n');
    expect(readFileSync(p.file('.env'))).toEqual(env);
    expect(existsSync(p.file('new.txt'))).toBe(false);
    expect(readFileSync(p.file('.git/HEAD'))).toEqual(gitHead);
  });

  it('rejects a stale token and can skip files edited manually', () => {
    p.write('a.txt', 'before');
    hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'agent');
    hook(p.root, 'turn-end');

    const s = new Store(p.root);
    const old = planRestore(s, 't1');
    p.write('a.txt', 'manual');
    expect(() => applyRestore(s, 't1', { token: old.token })).toThrow(/Stale/);

    const current = planRestore(s, 't1');
    expect(current.actions[0].uncertain).toBe(true);
    expect(applyRestore(s, 't1', { token: current.token, skipUncertain: true }).skipped).toEqual(['a.txt']);
    expect(p.read('a.txt')).toBe('manual');
  });

  it('undo walks back one turn at a time and redo reverses it', () => {
    p.write('a.txt', 'zero');
    hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'one');
    hook(p.root, 'turn-end', 't1');
    hook(p.root, 'edit', 't2', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'two');
    hook(p.root, 'turn-end', 't2');

    const s = new Store(p.root);
    expect(undoTarget(s)).toBe('codex:s:t2');
    applyRestore(s, undoTarget(s)!, { operation: 'undo' });
    expect(p.read('a.txt')).toBe('one');
    expect(undoTarget(s)).toBe('codex:s:t1');

    applyRestore(s, redoTarget(s)!, { operation: 'redo' });
    expect(p.read('a.txt')).toBe('two');
    expect(undoTarget(s)).toBe('codex:s:t2');
  });

  it('restores only the selected paths', () => {
    p.write('a.txt', 'a0');
    p.write('b.txt', 'b0');
    hook(p.root, 'shell', 't1', { command: 'edit both' });
    p.write('a.txt', 'a1');
    p.write('b.txt', 'b1');
    hook(p.root, 'turn-end');

    const s = new Store(p.root);
    const plan = planRestore(s, 't1', [p.file('a.txt')]);
    expect(plan.actions.map(a => a.path)).toEqual(['a.txt']);
    applyRestore(s, 't1', { paths: [p.file('a.txt')], token: plan.token });
    expect(p.read('a.txt')).toBe('a0');
    expect(p.read('b.txt')).toBe('b1');
    expect(() => planRestore(s, 't1', [path.resolve(p.root, '..', 'outside.txt')])).toThrow(/outside/);
  });

  it('records a failed snapshot instead of throwing', () => {
    p.write('a.txt', 'x');
    const s = new Store(p.root);
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(s.repo.gitDir, 'broken shadow git');
    expect(s.snapshot('baseline', { agent: 'codex', session: 's', turn: 't1' }, ['a.txt']).status).toBe('failed');
  });
});
