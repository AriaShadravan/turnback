import { renameSync, rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

/** One turn that renames a.txt to b.txt, edits c.txt, deletes d.txt, and adds e.txt. */
function mixedTurn() {
  const p = tempProject('turnback-diff-');
  p.write('a.txt', 'same content that git would detect as a rename\n'.repeat(20));
  p.write('c.txt', 'c\n');
  p.write('d.txt', 'd\n');
  hook(p.root, 'shell', 't', { command: 'mixed' });
  renameSync(p.file('a.txt'), p.file('b.txt'));
  p.write('c.txt', 'c2\n');
  rmSync(p.file('d.txt'));
  p.write('e.txt', 'e\n');
  hook(p.root, 'turn-end', 't');
  const store = new Store(p.root);
  return { p, store, turn: store.findTurn('t')! };
}

it('reports renames as a delete plus an add', () => {
  const { store, turn } = mixedTurn();
  const changes = store.repo.diffNameStatus(turn.baseline, turn.end!);
  expect(changes).toEqual(expect.arrayContaining([
    { status: 'D', path: 'a.txt' }, { status: 'A', path: 'b.txt' }, { status: 'M', path: 'c.txt' },
    { status: 'D', path: 'd.txt' }, { status: 'A', path: 'e.txt' },
  ]));
  expect(store.repo.diffNames(turn.baseline, turn.end!)).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
});

it('limits a patch to the given paths', () => {
  const { store, turn } = mixedTurn();
  const patch = store.repo.diffPatch(turn.baseline, turn.end!, ['c.txt']);
  expect(patch).toContain('+c2');
  expect(patch).not.toContain('e.txt');
});

it('writes a binary-safe patch without rename detection', () => {
  const { store, turn } = mixedTurn();
  const patch = store.repo.diffBinary(turn.baseline, turn.end!);
  expect(patch).toContain('diff --git a/a.txt b/a.txt');
  expect(patch).toContain('deleted file mode');
  expect(patch).not.toContain('rename from');
});
