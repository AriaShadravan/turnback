import { existsSync, rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyRestore, findRecoverable, redoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

/** Turn t1 deletes gone.txt and edits a.txt; turn t2 edits a.txt again. */
function history() {
  const p = tempProject('turnback-recover-');
  p.write('gone.txt', 'keep me\n');
  p.write('a.txt', 'a0');
  hook(p.root, 'turn-start', 't1');
  hook(p.root, 'shell', 't1', { command: 'rm gone.txt' });
  rmSync(p.file('gone.txt'));
  p.write('a.txt', 'a1');
  hook(p.root, 'turn-end', 't1');
  hook(p.root, 'turn-start', 't2');
  hook(p.root, 'edit', 't2', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'a2');
  hook(p.root, 'turn-end', 't2');
  return p;
}

it('brings back a file deleted turns ago without touching other files', () => {
  const p = history();
  const store = new Store(p.root);
  const found = findRecoverable(store, p.file('gone.txt'))!;
  expect(found).toBeDefined();
  expect(found.turn?.id).toContain('t1');
  applyRestore(store, found.ref, { paths: [p.file('gone.txt')] });
  expect(p.read('gone.txt')).toBe('keep me\n');
  expect(p.read('a.txt')).toBe('a2');
  applyRestore(store, redoTarget(store)!, { operation: 'redo' });
  expect(existsSync(p.file('gone.txt'))).toBe(false);
});

it('picks the newest version that differs from the file on disk', () => {
  const p = history();
  const found = findRecoverable(new Store(p.root), p.file('a.txt'))!;
  const store = new Store(p.root);
  applyRestore(store, found.ref, { paths: [p.file('a.txt')] });
  expect(p.read('a.txt')).toBe('a1');
});

it('returns nothing for a file no snapshot has', () => {
  const p = history();
  p.write('new.txt', 'x');
  expect(findRecoverable(new Store(p.root), p.file('never.txt'))).toBeUndefined();
});
