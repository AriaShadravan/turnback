import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { exportCommit, exportPatch } from '../src/core/export.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, IDENTITY);
const git = (root: string, ...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });

/** A committed project, then one agent turn that edits a.txt and adds b.txt. */
function project() {
  const p = tempProject('turnback-export-');
  p.write('a.txt', 'one\n');
  p.write('.gitignore', '.env\n');
  git(p.root, 'add', '-A');
  git(p.root, 'commit', '-qm', 'init');
  hook(p.root, 'turn-start', 't', { prompt: 'Update a and add b' });
  hook(p.root, 'shell', 't', { command: 'edit' });
  p.write('a.txt', 'two\n');
  p.write('b.txt', 'new\n');
  p.write('.env', 'SECRET=1\n');
  hook(p.root, 'turn-end', 't');
  return p;
}

it('writes a patch that applies to the original tree', () => {
  const p = project();
  const patch = exportPatch(new Store(p.root), ['t']);
  git(p.root, 'stash', '-u', '-q');
  const apply = spawnSync('git', ['-C', p.root, 'apply', '--exclude=.env', '-'], { input: patch, encoding: 'utf8', windowsHide: true });
  expect(apply.status, apply.stderr).toBe(0);
  expect(p.read('a.txt')).toBe('two\n');
  expect(p.read('b.txt')).toBe('new\n');
});

it('commits only the turn paths with the prompt as message, skipping ignored files', () => {
  const p = project();
  p.write('other.txt', 'staged by the user\n');
  git(p.root, 'add', 'other.txt');
  const result = exportCommit(new Store(p.root), ['t']);
  expect(result.paths.sort()).toEqual(['a.txt', 'b.txt']);
  expect(result.ignored).toEqual(['.env']);
  expect(git(p.root, 'log', '-1', '--format=%s').stdout.trim()).toBe('Update a and add b');
  expect(git(p.root, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort()).toEqual(['a.txt', 'b.txt']);
  expect(git(p.root, 'diff', '--cached', '--name-only').stdout.trim()).toBe('other.txt');
});

it('refuses when files changed again after the turn', () => {
  const p = project();
  p.write('a.txt', 'three\n');
  expect(() => exportCommit(new Store(p.root), ['t'])).toThrow(/a\.txt/);
  expect(git(p.root, 'log', '--format=%s').stdout.trim()).toBe('init');
});

it('refuses outside a git repository', () => {
  const p = project();
  rmSync(p.file('.git'), { recursive: true, force: true });
  expect(() => exportCommit(new Store(p.root), ['t'])).toThrow(/Not a git repository/);
});
