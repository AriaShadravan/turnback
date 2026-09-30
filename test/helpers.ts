import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { record } from '../src/core/recorder.js';
import type { HookEvent } from '../src/core/types.js';

export const CLI = path.resolve('dist/cli.js');

const created: string[] = [];

/** A temporary folder, removed when its test file finishes (see test/setup.ts). */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Remove `file` (a link or folder next to a temporary project) with this test file's temporary folders. */
export function removeLater(file: string): void {
  created.push(file);
}

/** Remove this test file's temporary folders; one still held by a background process is left behind. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* still in use */ }
  }
}

/** Temporary git project with a separate TURNBACK_HOME. */
export function tempProject(prefix = 'turnback-test-') {
  const root = tempDir(prefix);
  const home = tempDir(`${prefix}data-`);
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
