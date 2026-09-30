import { expect, it } from 'vitest';
import { formatBlame, formatConfigFiles, formatMarks, formatPlan, formatRestoreResult, formatStatus, formatSteps, formatTurns } from '../src/core/format.js';
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

it('formats a restore plan with one line per file and a footer', () => {
  const text = formatPlan('Undo turn "clean up" (claude, 2026-09-29 14:03)', {
    scope: 'workspace',
    actions: [
      { path: '.env', action: 'create', uncertain: false },
      { path: 'src/app.ts', action: 'modify', uncertain: true },
      { path: 'junk.txt', action: 'delete', uncertain: false },
    ],
    skippedLarge: ['big.bin'],
  });
  expect(text).toMatch(/^Undo turn "clean up"/);
  expect(text).toMatch(/^ {2}restore +\.env$/m);
  expect(text).toMatch(/^ {2}revert +src\/app\.ts +\(changed since Turnback's last snapshot/m);
  expect(text).toMatch(/^ {2}remove +junk\.txt$/m);
  expect(text).toContain('Skipped, over 5 MB: big.bin');
  expect(text).toContain('3 files');
  const applying = formatPlan('Undo', { scope: 'workspace', actions: [{ path: 'a', action: 'modify', uncertain: false }], skippedLarge: [] }, true);
  expect(applying).not.toContain('would change');
  expect(formatPlan('Redo', { scope: 'workspace', actions: [], skippedLarge: [] })).toContain('Nothing to change.');
  expect(formatPlan('Undo', { scope: 'recorded-paths', actions: [], skippedLarge: [] })).toContain('edits-only');
});

it('formats a restore result with the way back', () => {
  const undo = formatRestoreResult({ applied: ['a', 'b'], failed: [], safety: 'refs/turnback/s/x' }, 'undo', true);
  expect(undo).toMatch(/^Restored 2 files\./);
  expect(undo).toContain('turnback redo --yes');
  expect(undo).toContain('conversation is not restored');
  expect(formatRestoreResult({ applied: ['a'], failed: [], safety: 'r' }, 'restore', false)).not.toContain('conversation');
  const failed = formatRestoreResult({ applied: ['a'], failed: ['b'], safety: 'refs/turnback/s/x' }, 'redo', false);
  expect(failed).toMatch(/^Restored 1 file\./);
  expect(failed).toContain('Failed: b');
  expect(failed).toContain('refs/turnback/s/x');
});

it('formats status as aligned fields', () => {
  const text = formatStatus({
    workspace: '/p', storage: '/h/abc', storageBytes: 30_949, mode: 'full', turns: 3, lastGc: undefined,
    skippedFiles: [], failures: [], corrupt: [],
  });
  expect(text).toMatch(/^Workspace +\/p$/m);
  expect(text).toMatch(/^Mode +full$/m);
  expect(text).toMatch(/^Turns +3$/m);
  expect(text).toMatch(/^Storage +30\.2 kB in \/h\/abc$/m);
  expect(text).toMatch(/^Problems +none$/m);
});

it('formats installed and removed config files', () => {
  expect(formatConfigFiles('Installed Turnback in', ['/p/.claude/settings.json'], '/p')).toBe('Installed Turnback in:\n  .claude/settings.json');
  expect(formatConfigFiles('Removed Turnback from', [], '/p')).toBe('Removed Turnback from: nothing to change.');
});

it('formats blame with one label per run of lines', () => {
  const t = turn({ id: 'codex:s:t1', agent: 'codex', prompt: 'add a long prompt that will not fit in the label column at all' });
  const text = formatBlame([
    { line: 1, text: 'import x', source: 'turn', turn: t },
    { line: 2, text: 'import y', source: 'turn', turn: t },
    { line: 3, text: '', source: 'before' },
    { line: 4, text: '// todo', source: 'outside' },
  ], new Map([['codex:s:t1', 2]]));
  const rows = text.split('\n');
  expect(rows[0]).toMatch(/^#2 codex \d\d-\d\d \d\d:\d\d "add a long.*…" +│ 1 │ import x$/);
  expect(rows[0].indexOf('│')).toBeLessThanOrEqual(61);
  expect(rows[1]).toMatch(/^ +│ 2 │ import y$/);
  expect(rows[2]).toMatch(/^\(before Turnback\) +│ 3 │ $/);
  expect(rows[3]).toMatch(/^\(outside a turn\) +│ 4 │ \/\/ todo$/);
  expect(formatBlame([], new Map())).toBe('(empty file)');
});
