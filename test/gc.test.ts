import { spawnSync } from 'node:child_process';
import { beforeEach, expect, it } from 'vitest';
import { applyRestore, planRestore } from '../src/restore.js';
import { Store } from '../src/store.js';
import { hook, tempProject } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
let p: ReturnType<typeof tempProject>;

beforeEach(() => {
  p = tempProject('turnback-gc-');
  p.write('a.txt', 'v0');
  for (const [i, turn] of ['t1', 't2', 't3'].entries()) {
    hook(p.root, 'edit', turn, { paths: [p.file('a.txt')] });
    p.write('a.txt', `v${i + 1}`);
    hook(p.root, 'turn-end', turn);
  }
});

const refCount = (s: Store) =>
  spawnSync('git', [`--git-dir=${s.repo.gitDir}`, 'for-each-ref', 'refs/turnback'], { encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean).length;

it('keeps recent turns under the default retention', () => {
  const s = new Store(p.root);
  expect(s.gc()).toEqual({ expired: 0, deletedRefs: 0 });
  expect(s.turns()).toHaveLength(3);
});

it('expires old turns, deletes only unshared refs, and keeps the rest restorable', () => {
  const s = new Store(p.root);
  const before = refCount(s);
  const result = s.gc({ now: Date.now() + 8 * DAY, keepTurns: 1 });
  expect(result.expired).toBe(2);
  expect(result.deletedRefs).toBeGreaterThan(0);
  expect(refCount(s)).toBe(before - result.deletedRefs);
  expect(s.turns().map(t => t.id)).toEqual(['codex:s:t3']);
  expect(() => planRestore(s, 't1')).toThrow(/Unknown/);

  applyRestore(s, 't3');
  expect(p.read('a.txt')).toBe('v2');
});

it('runs automatic gc at most once a day', () => {
  const s = new Store(p.root);
  expect(s.gcIfDue()).toBeDefined();
  expect(s.gcIfDue()).toBeUndefined();
  expect(s.gcIfDue(Date.now() + 2 * DAY)).toBeDefined();
});
