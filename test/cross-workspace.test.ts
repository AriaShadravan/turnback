import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { applyRestore, planRestore } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

// The agent session runs in `session`, but the agent edits a file in another project (`other`).
let session: ReturnType<typeof tempProject>;
let other: ReturnType<typeof tempProject>;

beforeEach(() => {
  other = tempProject('turnback-other-');
  session = tempProject('turnback-session-');
  process.env.TURNBACK_HOME = session.home;
  session.write('main.txt', 'session');
  other.write('notes.txt', 'original');
});

it('snapshots an edited file in the workspace that contains it, not the session cwd', () => {
  expect(hook(session.root, 'edit', 't1', { paths: [other.file('notes.txt')] })?.status).toBe('ok');
  other.write('notes.txt', 'overwritten by agent');
  hook(session.root, 'turn-end', 't1');

  const foreign = new Store(other.root);
  const turn = foreign.findTurn('t1');
  expect(turn).toBeDefined();
  expect(foreign.summarize(turn!).changedFiles).toBe(1);
  expect(new Store(session.root).findTurn('t1')).toBeUndefined();

  applyRestore(foreign, 't1');
  expect(other.read('notes.txt')).toBe('original');
});

it('splits one edit event across the workspaces it touches', () => {
  hook(session.root, 'edit', 't1', { paths: [session.file('main.txt'), other.file('notes.txt')] });
  session.write('main.txt', 'changed');
  other.write('notes.txt', 'changed');
  hook(session.root, 'turn-end', 't1');

  for (const [project, file, before] of [[session, 'main.txt', 'session'], [other, 'notes.txt', 'original']] as const) {
    const store = new Store(project.root);
    expect(planRestore(store, 't1').actions.map(a => a.path)).toEqual([file]);
    applyRestore(store, 't1');
    expect(project.read(file)).toBe(before);
  }
});

it('works when the hook process runs inside a subfolder of the workspace', () => {
  mkdirSync(other.file('sub'));
  other.write('sub/inner.txt', 'inner');
  const previous = process.cwd();
  process.chdir(other.file('sub'));
  try {
    expect(hook(other.root, 'shell', 't1', { command: 'rm -rf ..' })?.status).toBe('ok');
    other.write('notes.txt', 'changed');
    other.write('sub/inner.txt', 'changed');
    other.write('top.txt', 'new');
    expect(hook(other.root, 'turn-end', 't1')?.status).toBe('ok');

    const store = new Store(other.root);
    expect(planRestore(store, 't1').actions.map(a => `${a.action}:${a.path}`)).toEqual(['modify:notes.txt', 'modify:sub/inner.txt', 'delete:top.txt']);
    applyRestore(store, 't1');
  } finally {
    process.chdir(previous);
  }
  expect(other.read('notes.txt')).toBe('original');
  expect(other.read('sub/inner.txt')).toBe('inner');
  expect(existsSync(other.file('top.txt'))).toBe(false);
});

it('handles a new file in a folder that does not exist yet', () => {
  const created = other.file('new/deep/file.txt');
  hook(session.root, 'edit', 't1', { paths: [created] });
  mkdirSync(path.dirname(created), { recursive: true });
  other.write('new/deep/file.txt', 'created');
  hook(session.root, 'turn-end', 't1');

  const foreign = new Store(other.root);
  applyRestore(foreign, 't1');
  expect(existsSync(created)).toBe(false);
  expect(other.read('notes.txt')).toBe('original');
});
