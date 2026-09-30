import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyRestore, planRestore, redoTarget, undoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, removeLater, tempProject } from './helpers.js';

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

  it('keeps original bytes when the project .gitattributes normalizes line endings', () => {
    p.write('.gitattributes', '* text=auto eol=lf\n');
    p.write('a.txt', 'one\r\ntwo\r\n');
    expect(hook(p.root, 'shell', 't1', { command: 'edit' })?.status).toBe('ok');
    p.write('a.txt', 'changed\r\n');
    hook(p.root, 'turn-end');

    applyRestore(new Store(p.root), 't1');
    expect(p.read('a.txt')).toBe('one\r\ntwo\r\n');
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

  it('a new agent turn after an undo becomes the next undo target and clears redo', () => {
    p.write('a.txt', 'zero');
    hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'one');
    hook(p.root, 'turn-end', 't1');
    hook(p.root, 'edit', 't2', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'two');
    hook(p.root, 'turn-end', 't2');

    const s = new Store(p.root);
    applyRestore(s, undoTarget(s)!, { operation: 'undo' });
    expect(p.read('a.txt')).toBe('one');

    hook(p.root, 'edit', 't3', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'three');
    hook(p.root, 'turn-end', 't3');

    expect(undoTarget(s)).toBe('codex:s:t3');
    // Redo would bring back the undone state on top of the new turn's work.
    expect(redoTarget(s)).toBeUndefined();
    applyRestore(s, undoTarget(s)!, { operation: 'undo' });
    expect(p.read('a.txt')).toBe('one');
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

  it('accepts paths spelled through an alias of the workspace (symlink, macOS /var, Windows 8.3)', () => {
    const alias = `${p.root}-alias`;
    symlinkSync(p.root, alias, 'junction');
    removeLater(alias);
    const viaAlias = path.join(alias, 'a.txt');
    p.write('a.txt', 'before');
    expect(hook(p.root, 'edit', 't1', { paths: [viaAlias] })?.status).toBe('ok');
    p.write('a.txt', 'after');
    hook(p.root, 'turn-end');

    const s = new Store(p.root);
    expect(s.summarize(s.findTurn('t1')!).changedFiles).toBe(1);
    const plan = planRestore(s, 't1', [viaAlias]);
    expect(plan.actions.map(a => a.path)).toEqual(['a.txt']);
    applyRestore(s, 't1', { paths: [viaAlias], token: plan.token });
    expect(p.read('a.txt')).toBe('before');
  });
});

describe('files changed during a turn that has not ended', () => {
  /** t1 is finished; t2 is still running. */
  function runningTurn() {
    p.write('a.txt', 'a0');
    p.write('b.txt', 'b0');
    p.write('c.txt', 'c0');
    hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'a1');
    hook(p.root, 'turn-end', 't1');
    hook(p.root, 'edit', 't2', { paths: [p.file('a.txt')] });
    p.write('a.txt', 'a2');
    return new Store(p.root);
  }

  it('does not mark files the running turn edited through an edit tool as manual edits', () => {
    const s = runningTurn();
    const plan = planRestore(s, 'codex:s:t2');
    expect(plan.actions).toEqual([{ path: 'a.txt', action: 'modify', uncertain: false }]);
    applyRestore(s, 'codex:s:t2', { token: plan.token, skipUncertain: true });
    expect(p.read('a.txt')).toBe('a1');
  });

  it('still marks files changed by a shell command or by hand during the running turn', () => {
    const s = runningTurn();
    hook(p.root, 'shell', 't2', { command: 'echo b2 > b.txt' });
    p.write('b.txt', 'b2');
    p.write('c.txt', 'c-by-hand');
    const marked = Object.fromEntries(planRestore(s, 'codex:s:t2').actions.map(a => [a.path, a.uncertain]));
    expect(marked).toEqual({ 'a.txt': false, 'b.txt': true, 'c.txt': true });
  });
});
