import { expect, it } from 'vitest';
import { formatMarks, formatSteps, formatTurns } from '../src/core/format.js';
import type { TurnSummary } from '../src/core/store.js';

const turn = (extra: Partial<TurnSummary>): TurnSummary => ({
  id: 'claude:s:abc', agent: 'claude', time: '2026-09-29T07:03:00.000Z', status: 'ok', baseline: 'r1', end: 'r2', changedFiles: 5, ...extra,
});

it('shows index, agent, file count, prompt and id', () => {
  const text = formatTurns([turn({ prompt: 'refactor auth middleware' })]);
  expect(text).toMatch(/^#1 /);
  expect(text).toContain('claude');
  expect(text).toContain('5 files');
  expect(text).toContain('"refactor auth middleware"');
  expect(text).toContain('claude:s:abc');
});

it('marks partial turns and turns without a prompt', () => {
  const text = formatTurns([turn({ status: 'partial', changedFiles: 1 })]);
  expect(text).toContain('[partial]');
  expect(text).toContain('1 file ');
  expect(text).toContain('(no prompt)');
});

it('says so when nothing is recorded', () => {
  expect(formatTurns([])).toBe('No turns recorded yet.');
});

it('formats steps with their command, paths, and missing snapshots', () => {
  const text = formatSteps([
    { n: 1, kind: 'edit', time: '2026-09-29T07:03:00.000Z', paths: ['src/a.ts', 'src/b.ts'], ref: 'r1', status: 'ok' },
    { n: 2, kind: 'shell', time: '2026-09-29T07:03:05.000Z', command: 'rm -rf src', status: 'unprotected' },
  ]);
  expect(text).toMatch(/^1\. .*edit .*src\/a\.ts, src\/b\.ts/m);
  expect(text).toMatch(/^2\. .*shell .*rm -rf src .*no snapshot: unprotected/m);
  expect(formatSteps([])).toBe('No edit or shell steps in this turn.');
});

it('formats marks with their label and ref', () => {
  const text = formatMarks([{ label: 'before migration', time: '2026-09-29T07:03:00.000Z', ref: 'refs/turnback/s/abc' }]);
  expect(text).toMatch(/^#1 .*"before migration"/);
  expect(text).toContain('refs/turnback/s/abc');
  expect(formatMarks([])).toBe('No marks yet. Create one with `turnback mark <label>`.');
});
