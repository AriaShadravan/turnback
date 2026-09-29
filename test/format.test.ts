import { expect, it } from 'vitest';
import { formatTurns } from '../src/format.js';
import type { TurnSummary } from '../src/store.js';

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
