import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { record } from './recorder.js';
import { Store } from './store.js';
import type { HookEvent } from './types.js';

export interface RunResult {
  /** Exit code of the command; 130 when it was ended by a signal. */
  status: number;
  turn: string;
  /** Why the snapshot before the command did not succeed, if it did not. */
  unprotected?: string;
}

/**
 * Run a command as one turn of the `manual` agent: turn start, a shell snapshot, the command,
 * then turn end. The turn is recorded even when the command fails or is interrupted.
 */
export function runAsTurn(cwd: string, argv: string[], label?: string): RunResult {
  const command = argv.length === 1 ? argv[0] : argv.map(quoteForShell).join(' ');
  const base: Omit<HookEvent, 'kind'> = { agent: 'manual', session: 'run', turn: randomUUID(), cwd };
  record({ ...base, kind: 'turn-start', prompt: label ?? command });
  const before = record({ ...base, kind: 'shell', command });

  // Ctrl+C reaches the command directly; Turnback stays alive to record the end of the turn.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    const child = spawnSync(command, { cwd, shell: true, stdio: 'inherit', windowsHide: true });
    record({ ...base, kind: 'turn-end' });
    const status = child.error ? 127 : child.status ?? 130;
    return { status, turn: base.turn, unprotected: before?.status === 'ok' ? undefined : before?.note ?? before?.status ?? 'not recorded' };
  } finally {
    process.off('SIGINT', ignore);
  }
}

/** Number of files the turn changed, for the summary line. */
export function changedFiles(cwd: string, turn: string): { index: number; files: number } | undefined {
  const store = new Store(cwd);
  const turns = store.turns();
  const index = turns.findIndex(t => t.id.endsWith(':' + turn));
  return index < 0 ? undefined : { index: index + 1, files: store.summarize(turns[index]).changedFiles };
}

/** Quote one argument for the shell Node uses with `shell: true`: cmd.exe on Windows, sh elsewhere. */
function quoteForShell(arg: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  return process.platform === 'win32' ? `"${arg.replaceAll('"', '""')}"` : `'${arg.replaceAll("'", `'\\''`)}'`;
}
