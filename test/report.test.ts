import { expect, it } from 'vitest';
import { record } from '../src/core/recorder.js';
import { sessionReport } from '../src/core/report.js';
import { Store } from '../src/core/store.js';
import { tempProject } from './helpers.js';

function turn(p: ReturnType<typeof tempProject>, session: string, id: string, prompt: string, change: () => void) {
  const base = { agent: 'codex' as const, session, turn: id, cwd: p.root };
  record({ ...base, kind: 'turn-start', prompt });
  record({ ...base, kind: 'shell', command: `run ${id}` });
  change();
  record({ ...base, kind: 'turn-end' });
}

it('summarizes the latest session as markdown', () => {
  const p = tempProject('turnback-report-');
  p.write('a.txt', '0');
  turn(p, 'old', 't0', 'older session', () => p.write('a.txt', '1'));
  turn(p, 's1', 't1', 'Add b', () => p.write('b.txt', 'b'));
  turn(p, 's1', 't2', 'Change a', () => p.write('a.txt', '2'));
  const text = sessionReport(new Store(p.root));
  expect(text).toMatch(/^# Turnback report/m);
  expect(text).toContain('Session `s1`');
  expect(text).toContain('2 turns');
  expect(text).toMatch(/## 1\. Add b[\s\S]*## 2\. Change a/);
  expect(text).toContain('`run t1`');
  expect(text).toContain('`b.txt` (added)');
  expect(text).toContain('`a.txt` (modified)');
  expect(text).not.toContain('older session');
  expect(sessionReport(new Store(p.root), 'old')).toContain('older session');
});

it('says so when there is nothing to report', () => {
  const p = tempProject('turnback-report-empty-');
  expect(sessionReport(new Store(p.root))).toBe('No turns recorded yet.');
  expect(() => sessionReport(new Store(p.root), 'nope')).toThrow(/No turns in session nope/);
});
