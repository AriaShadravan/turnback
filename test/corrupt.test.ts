import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyRestore } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

let p: ReturnType<typeof tempProject>;
const PATH = process.env.PATH;
beforeEach(() => { p = tempProject(); });
afterEach(() => { process.env.PATH = PATH; });

const quarantined = (store: Store) => readdirSync(store.dir).filter(name => name.startsWith('corrupt-'));

// Corruption is found when a snapshot has to write objects; unchanged hooks reuse the last ref unchecked.
it('moves a shadow repo with missing objects aside and starts a new baseline', () => {
  p.write('a.txt', 'zero');
  p.write('b.txt', 'kept');
  const store = new Store(p.root);
  expect(store.warm().status).toBe('ok');
  const objects = path.join(store.repo.gitDir, 'objects');
  for (const dir of readdirSync(objects)) if (dir !== 'info') rmSync(path.join(objects, dir), { recursive: true });
  mkdirSync(path.join(objects, 'pack'));
  p.write('a.txt', 'one');

  expect(hook(p.root, 'shell', 't1', { command: 'edit' })?.status).toBe('ok');
  p.write('a.txt', 'two');
  hook(p.root, 'turn-end');

  const [folder] = quarantined(store);
  expect(existsSync(path.join(store.dir, folder, 'repo.git'))).toBe(true);
  expect(existsSync(path.join(store.dir, folder, 'journal.jsonl'))).toBe(true);
  expect(store.status().corrupt).toEqual([path.join(store.dir, folder)]);

  applyRestore(store, 't1');
  expect(p.read('a.txt')).toBe('one');
  expect(p.read('b.txt')).toBe('kept');
});

it('recovers when the shadow git directory is not a repository at all', () => {
  p.write('a.txt', 'x');
  const store = new Store(p.root);
  mkdirSync(store.dir, { recursive: true });
  writeFileSync(store.repo.gitDir, 'broken shadow git');
  expect(store.snapshot('baseline', { agent: 'codex', session: 's', turn: 't1' }, ['a.txt']).status).toBe('ok');
  expect(quarantined(store)).toHaveLength(1);
});

it('does not quarantine a healthy repo when git itself cannot run', () => {
  p.write('a.txt', 'x');
  const store = new Store(p.root);
  expect(store.warm().status).toBe('ok');
  p.write('a.txt', 'y');
  process.env.PATH = '';
  expect(store.snapshot('shell', { agent: 'codex', session: 's', turn: 't1' }).status).toBe('failed');
  process.env.PATH = PATH;
  expect(quarantined(store)).toEqual([]);
  expect(store.status().corrupt).toEqual([]);
});
