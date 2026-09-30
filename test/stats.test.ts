import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { formatStats, statsCard, turnStats } from '../src/core/stats.js';
import { applyRestore, undoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

function twoTurns() {
  const p = tempProject('turnback-stats-');
  p.write('a.txt', 'a');
  p.write('b.txt', 'b');
  p.write('c.txt', 'c');
  hook(p.root, 'turn-start', 't1');
  hook(p.root, 'shell', 't1', { command: 'rm a.txt b.txt' });
  rmSync(p.file('a.txt'));
  rmSync(p.file('b.txt'));
  p.write('new.txt', 'n');
  hook(p.root, 'turn-end', 't1');
  hook(p.root, 'turn-start', 't2');
  hook(p.root, 'edit', 't2', { paths: [p.file('c.txt')] });
  p.write('c.txt', 'c2');
  hook(p.root, 'turn-end', 't2');
  const store = new Store(p.root);
  applyRestore(store, undoTarget(store)!, { operation: 'undo' });
  return new Store(p.root);
}

it('counts turns, files by change, shell commands, and files brought back', () => {
  const s = turnStats(twoTurns(), 7);
  expect(s).toMatchObject({ turns: 2, byAgent: { codex: 2 }, created: 1, modified: 1, deleted: 2, commands: 1, restores: 1, restoredFiles: 1 });
});

it('leaves out turns older than the window', () => {
  const s = turnStats(twoTurns(), 7, Date.now() + 8 * 24 * 60 * 60 * 1000);
  expect(s.turns).toBe(0);
  expect(s.restores).toBe(0);
});

it('formats text and an SVG card with escaped text', () => {
  const s = turnStats(twoTurns(), 7);
  const text = formatStats(s);
  expect(text).toMatch(/^Turns +2 +\(codex 2\)$/m);
  expect(text).toMatch(/deleted 2/);
  const svg = statsCard({ ...s, byAgent: { '<script>': 1 } });
  expect(svg).toMatch(/^<svg /);
  expect(svg).toContain('deleted 2 files');
  expect(svg).not.toContain('<script>');
});

it('says commands, not agents, when every turn came from turnback run', () => {
  const s = turnStats(twoTurns(), 7);
  expect(statsCard({ ...s, byAgent: { manual: 2 } })).toContain('Commands deleted 2 files this week.');
  expect(statsCard({ ...s, byAgent: { manual: 1, codex: 1 } })).toContain('Agents deleted 2 files this week.');
});
