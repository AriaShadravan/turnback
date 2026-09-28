import { WARM_WAIT_MS } from './config.js';
import { turnKey } from './journal.js';
import { originFields, Store } from './store.js';
import type { Entry, HookEvent } from './types.js';

/**
 * Terapkan aturan snapshot untuk satu event hook:
 * - tool pengubah pertama dalam giliran mengambil baseline,
 * - edit berikutnya hanya men-snapshot path terkait,
 * - perintah shell men-snapshot seluruh tree,
 * - akhir giliran men-snapshot hasilnya.
 * Pada mode `edits-only`, shell tidak di-snapshot dan semua snapshot dibatasi pada path edit.
 */
export function record(event: HookEvent): Entry | undefined {
  const store = new Store(event.cwd);
  const turn = store.entries().filter(e => turnKey(e) === turnKey(event));
  const origin = originFields(event);

  switch (event.kind) {
    case 'session-start':
    case 'turn-start':
      return store.log({ ...origin, kind: event.kind, status: 'ok' });
    case 'turn-end':
      return endTurn(store, event, turn);
    default:
      return recordChange(store, event, turn);
  }
}

function recordChange(store: Store, event: HookEvent, turn: Entry[]): Entry {
  const origin = originFields(event);
  const editsOnly = store.mode() === 'edits-only';

  if (editsOnly && (event.kind === 'shell' || !event.paths?.length)) {
    return store.log({ ...origin, kind: event.kind, status: 'unprotected', note: 'edits-only mode: only edited paths are snapshotted' });
  }
  if (!turn.some(e => e.kind === 'baseline' && e.status === 'ok')) {
    return takeBaseline(store, event, editsOnly);
  }
  if (event.kind === 'edit' && (editsOnly || !hadShell(turn))) {
    // Simpan hasil edit sebelumnya dan isi path yang akan diubah sekarang.
    const previous = turn.findLast(e => e.paths?.length);
    return store.snapshot('edit', origin, [...(previous?.paths ?? []), ...(event.paths ?? [])]);
  }
  return store.snapshot(event.kind, origin);
}

function takeBaseline(store: Store, event: HookEvent, editsOnly: boolean): Entry {
  const origin = originFields(event);
  if (editsOnly) return store.snapshot('baseline', origin, event.paths);

  const start = Date.now();
  const warm = store.waitWarm();
  if (!warm && Date.now() - start >= WARM_WAIT_MS) {
    return store.log({ ...origin, kind: event.kind, status: 'unprotected', note: 'Warm baseline exceeded 30 seconds' });
  }
  const baseline = warm
    ? store.log({ ...origin, kind: 'baseline', ref: warm, status: 'ok' })
    : store.snapshot('baseline', origin);
  if (baseline.status !== 'ok') {
    return store.log({ ...origin, kind: event.kind, status: 'unprotected', note: 'Baseline unavailable' });
  }
  return baseline;
}

function endTurn(store: Store, event: HookEvent, turn: Entry[]): Entry {
  const origin = originFields(event);
  if (!turn.some(e => e.kind === 'baseline')) return store.log({ ...origin, kind: 'turn-end', status: 'ok' });

  const edited = [...new Set(turn.flatMap(e => e.paths ?? []))];
  const pathsOnly = store.mode() === 'edits-only' || !hadShell(turn);
  return store.snapshot('turn-end', origin, pathsOnly && edited.length ? edited : undefined);
}

/** Adapter hanya mengisi `command` untuk event shell. */
const hadShell = (turn: Entry[]) => turn.some(e => e.command !== undefined);
