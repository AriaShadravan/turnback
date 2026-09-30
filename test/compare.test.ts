import { expect, it } from 'vitest';
import { compareTurns } from '../src/core/compare.js';
import { applyRestore } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

it('compares the results of two attempts at the same task', () => {
  const p = tempProject('turnback-compare-');
  p.write('a.txt', 'base\n');
  p.write('shared.txt', 'base\n');
  const store = new Store(p.root);

  hook(p.root, 'shell', 'ta', { command: 'attempt a' });
  p.write('a.txt', 'from a\n');
  p.write('shared.txt', 'same\n');
  p.write('only-a.txt', 'a\n');
  hook(p.root, 'turn-end', 'ta');
  applyRestore(store, 'ta');

  hook(p.root, 'shell', 'tb', { command: 'attempt b' });
  p.write('a.txt', 'from b\n');
  p.write('shared.txt', 'same\n');
  p.write('only-b.txt', 'b\n');
  hook(p.root, 'turn-end', 'tb');

  const c = compareTurns(store, 'ta', 'tb');
  expect(c.onlyA).toEqual(['only-a.txt']);
  expect(c.onlyB).toEqual(['only-b.txt']);
  expect(c.both).toEqual(['a.txt']);
  expect(c.same).toEqual(['shared.txt']);
  expect(c.patch).toContain('-from a');
  expect(c.patch).toContain('+from b');
  expect(() => compareTurns(store, 'ta', 'nope')).toThrow(/Unknown or incomplete turn/);
});
