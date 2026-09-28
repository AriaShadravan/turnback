import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { record } from '../src/recorder.js';
import type { HookEvent } from '../src/types.js';

export const CLI = path.resolve('dist/cli.js');

/** Temporary git project with a separate TURNBACK_HOME. */
export function tempProject(prefix = 'turnback-test-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const home = mkdtempSync(path.join(tmpdir(), `${prefix}data-`));
  process.env.TURNBACK_HOME = home;
  spawnSync('git', ['init', '-q', root]);
  return {
    root,
    home,
    write: (rel: string, content: string | Buffer) => writeFileSync(path.join(root, rel), content),
    read: (rel: string) => readFileSync(path.join(root, rel), 'utf8'),
    file: (rel: string) => path.join(root, rel),
  };
}

/** Record one Codex hook event for turn `turn`. */
export function hook(root: string, kind: HookEvent['kind'], turn = 't1', extra: Partial<HookEvent> = {}) {
  return record({ agent: 'codex', session: 's', turn, cwd: root, kind, ...extra });
}
