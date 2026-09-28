import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, WARM_WAIT_MS, workspaceRoot, workspaceRootForFile } from './config.js';
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
 *
 * Edit dicatat di workspace yang memuat filenya, bukan selalu di folder kerja sesi, supaya
 * file di proyek lain tetap terlindungi. Perintah shell tetap memakai folder kerja sesi.
 */
export function record(event: HookEvent): Entry | undefined {
  const home = new Store(event.cwd);
  if (event.kind === 'edit' && event.paths?.length) return recordEdit(home, event, event.paths);
  if (event.kind === 'turn-end') {
    for (const root of takeForeignRoots(home, event)) recordIn(new Store(root), { ...event, cwd: root });
  }
  return recordIn(home, event);
}

function recordEdit(home: Store, event: HookEvent, paths: string[]): Entry | undefined {
  const groups = new Map<string, string[]>();
  for (const file of paths) {
    const root = isInside(home.root, file) ? home.root : workspaceRootForFile(file);
    groups.set(root, [...(groups.get(root) ?? []), file]);
  }
  let result: Entry | undefined;
  for (const [root, group] of groups) {
    const local = root === home.root;
    if (!local) rememberForeignRoot(home, event, root);
    const entry = recordIn(local ? home : new Store(root), { ...event, cwd: root, paths: group });
    if (local || !result) result = entry;
  }
  return result;
}

function recordIn(store: Store, event: HookEvent): Entry | undefined {
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

/**
 * Workspace lain yang disentuh edit dalam giliran ini, disimpan di folder data workspace sesi.
 * Saat giliran berakhir, workspace itu ikut mendapat snapshot akhir giliran.
 */
const foreignFile = (home: Store) => path.join(home.dir, 'foreign-turns.json');

function readForeign(home: Store): Record<string, string[]> {
  try { return JSON.parse(readFileSync(foreignFile(home), 'utf8')); } catch { return {}; }
}

function rememberForeignRoot(home: Store, event: HookEvent, root: string): void {
  const all = readForeign(home);
  const key = turnKey(event);
  if (all[key]?.includes(root)) return;
  all[key] = [...(all[key] ?? []), root];
  mkdirSync(home.dir, { recursive: true });
  writeFileSync(foreignFile(home), JSON.stringify(all));
}

function takeForeignRoots(home: Store, event: HookEvent): string[] {
  const all = readForeign(home);
  const roots = all[turnKey(event)] ?? [];
  if (!roots.length) return [];
  delete all[turnKey(event)];
  writeFileSync(foreignFile(home), JSON.stringify(all));
  return roots.filter(root => workspaceRoot(root) !== home.root);
}

/** Adapter hanya mengisi `command` untuk event shell. */
const hadShell = (turn: Entry[]) => turn.some(e => e.command !== undefined);
