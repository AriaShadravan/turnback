import { expect, it } from 'vitest';
import { applyRestore, redoTarget } from '../src/restore.js';
import { Store } from '../src/store.js';
import { hook, tempProject } from './helpers.js';

/** One turn: edit a.txt (v1), shell (v2), edit a.txt (v3). */
function threeSteps() {
  const p = tempProject('turnback-steps-');
  p.write('a.txt', 'v0');
  hook(p.root, 'turn-start', 't');
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'v1');
  hook(p.root, 'shell', 't', { command: 'echo v2 > a.txt' });
  p.write('a.txt', 'v2');
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'v3');
  hook(p.root, 'turn-end', 't');
  return p;
}

it('lists the edit and shell steps of a turn in order', () => {
  const p = threeSteps();
  const steps = new Store(p.root).steps('t');
  expect(steps.map(s => [s.n, s.kind, s.status])).toEqual([[1, 'edit', 'ok'], [2, 'shell', 'ok'], [3, 'edit', 'ok']]);
  expect(steps[0].paths).toEqual(['a.txt']);
  expect(steps[1].command).toBe('echo v2 > a.txt');
});

it('restores to just before a step and can redo it', () => {
  const p = threeSteps();
  const store = new Store(p.root);
  applyRestore(store, store.stepRef('t', 3));
  expect(p.read('a.txt')).toBe('v2');
  applyRestore(store, store.stepRef('t', 2));
  expect(p.read('a.txt')).toBe('v1');
  applyRestore(store, redoTarget(store)!, { operation: 'redo' });
  expect(p.read('a.txt')).toBe('v2');
});

it('refuses steps that do not exist or have no snapshot', () => {
  const p = threeSteps();
  const store = new Store(p.root);
  expect(() => store.stepRef('t', 9)).toThrow(/has 3 steps/);
  expect(() => store.stepRef('t', 0)).toThrow(/has 3 steps/);
  store.log({ agent: 'codex', session: 's', turn: 't', kind: 'shell', command: 'rm -rf x', status: 'unprotected' });
  expect(() => store.stepRef('t', 4)).toThrow(/no snapshot/);
});

it('refuses a step whose snapshot may miss an earlier step without one', () => {
  const p = tempProject('turnback-steps-gap-');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) p.write(f, '0');
  const store = new Store(p.root);
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', '1');
  // The snapshot for editing b.txt timed out on the lock.
  store.log({ agent: 'codex', session: 's', turn: 't', kind: 'edit', paths: [p.file('b.txt')], status: 'skipped' });
  p.write('b.txt', '1');
  hook(p.root, 'edit', 't', { paths: [p.file('c.txt')] });
  p.write('c.txt', '1');
  hook(p.root, 'turn-end', 't');

  const steps = store.steps('t');
  expect(steps[2].ref).toBeUndefined();
  expect(steps[2].reason).toMatch(/earlier step/);
  expect(() => store.stepRef('t', 3)).toThrow(/earlier step/);
  expect(store.stepRef('t', 1)).toMatch(/^refs\//);
});
