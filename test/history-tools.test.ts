import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveRef } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

function twoTurns() {
  const p = tempProject('turnback-history-');
  p.write('a.txt', '0');
  hook(p.root, 'turn-start', 't1', { prompt: 'Fix the login bug' });
  hook(p.root, 'shell', 't1', { command: 'npm test -- login' });
  p.write('a.txt', '1');
  hook(p.root, 'turn-end', 't1');
  hook(p.root, 'turn-start', 't2', { prompt: 'Add docs' });
  hook(p.root, 'edit', 't2', { paths: [p.file('README.md')] });
  p.write('README.md', 'docs');
  hook(p.root, 'turn-end', 't2');
  return p;
}

it('searches prompts, commands, and paths case-insensitively', () => {
  const p = twoTurns();
  const store = new Store(p.root);
  expect(store.searchTurns('LOGIN').map(t => t.prompt)).toEqual(['Fix the login bug']);
  expect(store.searchTurns('readme').map(t => t.prompt)).toEqual(['Add docs']);
  expect(store.searchTurns('npm test').map(t => t.prompt)).toEqual(['Fix the login bug']);
  expect(store.searchTurns('nothing')).toEqual([]);
});

it('resolves turns, marks, and refs, and probes the current files', () => {
  const p = twoTurns();
  const store = new Store(p.root);
  expect(resolveRef(store, 't1')).toBe(store.findTurn('t1')!.baseline);
  const mark = store.mark('checkpoint');
  expect(resolveRef(store, 'checkpoint')).toBe(mark.ref);
  expect(() => resolveRef(store, 'nope')).toThrow(/Unknown turn/);

  p.write('a.txt', 'uncommitted');
  const now = store.probe();
  expect(store.repo.diffPatch(resolveRef(store, 't1'), now)).toContain('+uncommitted');
});

it('lets gc remove day-old probes, which are never a snapshot base', () => {
  const p = twoTurns();
  const store = new Store(p.root);
  const base = store.latestRef()!;
  p.write('a.txt', 'x');
  const old = store.probe();
  p.write('a.txt', 'y');
  const latest = store.probe();
  expect(store.latestRef()).toBe(base);
  store.gc({ now: Date.now() + 2 * 24 * 3600 * 1000 });
  expect(store.repo.refExists(old)).toBe(false);
  expect(store.repo.refExists(latest)).toBe(false);
  expect(store.repo.refExists(base)).toBe(true);
  // The next snapshot still builds on the kept base.
  hook(p.root, 'shell', 't3', { command: 'after gc' });
  expect(store.findTurn('t3')?.baseline).toMatch(/^refs\//);
});

it('keeps a mid-turn probe from crediting the user edits to the agent', () => {
  const p = tempProject('turnback-probe-turn-');
  p.write('a.txt', '0');
  p.write('b.txt', 'user 0');
  const store = new Store(p.root);
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', '1');
  p.write('b.txt', 'user 1');
  store.probe();
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', '2');
  hook(p.root, 'turn-end', 't');
  const turn = store.findTurn('t')!;
  expect(store.repo.diffNames(turn.baseline, turn.end!)).toEqual(['a.txt']);
});

it('refuses to probe in edits-only mode', () => {
  const p = twoTurns();
  const store = new Store(p.root);
  writeFileSync(path.join(store.dir, 'mode.json'), JSON.stringify({ mode: 'edits-only' }));
  expect(() => store.probe()).toThrow(/edits-only/);
});
