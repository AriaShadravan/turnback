import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, MAX_FILE_BYTES, pathKey, sha256, sleep } from './config.js';
import type { TreeItem } from './shadow.js';
import type { Store } from './store.js';
import type { Entry } from './types.js';
import type { FileState } from './workspace.js';

export type Operation = 'restore' | 'undo' | 'redo';

export interface RestoreAction {
  path: string;
  action: 'create' | 'modify' | 'delete';
  /** File berubah sejak snapshot terakhir Turnback, kemungkinan diedit manual oleh pengguna. */
  uncertain: boolean;
}

export interface RestorePlan {
  target: string;
  ref: string;
  paths?: string[];
  /** `workspace`: seluruh tree dibandingkan. `recorded-paths` (mode edits-only): hanya path yang pernah dicatat. */
  scope: 'workspace' | 'recorded-paths';
  actions: RestoreAction[];
  token: string;
  skippedLarge: string[];
}

export interface RestoreOptions {
  paths?: string[];
  /** Token dari rencana; kalau diisi, restore ditolak bila workspace sudah berubah. */
  token?: string;
  skipUncertain?: boolean;
  operation?: Operation;
}

export interface RestoreResult {
  applied: string[];
  skipped: string[];
  failed: string[];
  safety: string;
  plan: RestorePlan;
}

export function planRestore(store: Store, target: string, selected?: string[]): RestorePlan {
  return buildPlan(store, target, selected).plan;
}

/** Rencana restore plus sumber isi file yang dituju untuk tiap path. */
function buildPlan(store: Store, target: string, selected?: string[]) {
  const entries = store.entries();
  const { ref, since } = resolveTarget(store, entries, target);
  const editsOnly = store.mode() === 'edits-only';
  const oidLength = store.repo.objectIdLength();
  const allowed = selected?.map(p => {
    const rel = store.workspace.relative(p);
    if (!rel) throw new Error(`Path outside workspace: ${p}`);
    return rel;
  });

  let source: (rel: string) => TreeItem | undefined;
  let candidates: string[], skippedLarge: string[];
  if (editsOnly) {
    const recorded = recordedSources(store, entries.slice(since));
    const trees = new Map<string, Map<string, TreeItem>>();
    source = rel => {
      const snapshot = recorded.get(rel)!;
      if (!trees.has(snapshot)) trees.set(snapshot, store.repo.tree(snapshot));
      return trees.get(snapshot)!.get(rel);
    };
    candidates = [...recorded.keys()];
    skippedLarge = candidates.filter(p => (store.workspace.stat(p)?.size ?? 0) > MAX_FILE_BYTES);
  } else {
    const desired = store.repo.tree(ref);
    source = rel => desired.get(rel);
    const scan = store.workspace.scan();
    candidates = [...desired.keys(), ...scan.paths];
    skippedLarge = scan.skipped;
  }

  const large = new Set(skippedLarge);
  const lastEnd = entries.findLast(e => (e.kind === 'turn-end' || e.kind === 'post-restore') && e.ref)?.ref;
  const lastSeen = lastEnd ? store.repo.tree(lastEnd) : new Map<string, TreeItem>();
  const current = new Map<string, FileState>();
  const actions: RestoreAction[] = [];

  for (const p of [...new Set(candidates)].sort()) {
    if (store.workspace.excluded(p) || large.has(p)) continue;
    const have = store.workspace.fileState(p, oidLength);
    if (have) current.set(p, have);
    if (allowed?.length && !allowed.some(a => p === a || p.startsWith(a + '/'))) continue;
    const want = source(p);
    if (!want && !have) continue;
    if (want && have && sameFile(want, have)) continue;
    const seen = lastSeen.get(p);
    actions.push({
      path: p,
      action: !want ? 'delete' : have ? 'modify' : 'create',
      uncertain: !!seen && !!have && !sameFile(seen, have),
    });
  }

  const state = sha256(JSON.stringify([...current].sort(([a], [b]) => a.localeCompare(b))));
  const token = sha256(JSON.stringify({ root: pathKey(store.root), ref, allowed, actions, state }));
  const plan: RestorePlan = {
    target,
    ref,
    paths: allowed,
    scope: editsOnly ? 'recorded-paths' : 'workspace',
    actions,
    token,
    skippedLarge: [...large],
  };
  return { plan, source };
}

/**
 * Mode edits-only: tree snapshot hanya lengkap untuk path yang dicatat di entri itu.
 * Keadaan sebuah path pada titik target = snapshot pertama sesudahnya yang mencatat path itu,
 * karena snapshot tersebut diambil sebelum path diubah. Path yang tidak pernah dicatat tidak disentuh.
 */
function recordedSources(store: Store, entries: Entry[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const e of entries) {
    if (!e.ref || e.status !== 'ok' || !e.paths) continue;
    for (const rel of store.relativePaths(e.paths)) if (!sources.has(rel)) sources.set(rel, e.ref);
  }
  return sources;
}

/**
 * Pulihkan workspace ke `target`. Keadaan sekarang disimpan dulu sebagai snapshot pengaman,
 * sehingga restore selalu bisa dibatalkan dengan `redo`.
 */
export function applyRestore(store: Store, target: string, options: RestoreOptions = {}): RestoreResult {
  const { paths, token, skipUncertain = false, operation = 'restore' } = options;
  return store.locked(() => {
    const { plan, source } = buildPlan(store, target, paths);
    if (token && token !== plan.token) throw new Error('Stale or invalid confirmation token');

    const scope = plan.scope === 'recorded-paths' ? plan.actions.map(a => a.path) : undefined;
    const safety = store.snapshotLocked('pre-restore', { agent: 'turnback', session: 'restore', turn: randomUUID(), paths: scope }, scope);
    if (!safety.ref) throw new Error('Safety snapshot failed');

    const applied: string[] = [], skipped: string[] = [], failed: string[] = [];
    for (const action of plan.actions) {
      if (skipUncertain && action.uncertain) {
        skipped.push(action.path);
        continue;
      }
      try {
        withRetry(() => writeAction(store, action.path, source(action.path)));
        applied.push(action.path);
      } catch {
        failed.push(action.path);
      }
    }

    store.log({
      agent: 'turnback', session: 'restore', turn: target, kind: operation, ref: safety.ref,
      status: failed.length ? 'failed' : 'ok', paths: applied, note: JSON.stringify({ target, skipped, failed }),
    });
    if (applied.length) {
      const after = plan.scope === 'recorded-paths' ? applied : undefined;
      store.snapshotLocked('post-restore', { agent: 'turnback', session: 'restore', turn: target, paths: after }, after);
    }
    return { applied, skipped, failed, safety: safety.ref, plan };
  });
}

/** Giliran berikutnya untuk `undo`: setiap undo berturut-turut mundur satu giliran lagi. */
export function undoTarget(store: Store): string | undefined {
  let depth = 0;
  for (const e of store.entries()) {
    if (e.status !== 'ok') continue;
    if (e.kind === 'restore') depth = 0;
    else if (e.kind === 'undo') depth++;
    else if (e.kind === 'redo') depth = Math.max(0, depth - 1);
  }
  return store.turns()[depth]?.id;
}

/** Snapshot pengaman dari restore/undo terakhir yang belum di-redo. */
export function redoTarget(store: Store): string | undefined {
  const stack: string[] = [];
  for (const e of store.entries()) {
    if (e.status !== 'ok') continue;
    if ((e.kind === 'restore' || e.kind === 'undo') && e.ref) stack.push(e.ref);
    else if (e.kind === 'redo') stack.pop();
  }
  return stack.at(-1);
}

/** Target berupa ID giliran (dipulihkan ke baseline-nya) atau ref snapshot. */
function resolveTarget(store: Store, entries: Entry[], target: string): { ref: string; since: number } {
  const turn = store.findTurn(target);
  if (turn) {
    const baseline = turn.entries.find(e => e.kind === 'baseline' && e.ref)!;
    return { ref: turn.baseline, since: entries.findIndex(e => e.id === baseline.id) };
  }
  const since = entries.findIndex(e => e.ref === target);
  if (since >= 0 && store.repo.refExists(target)) return { ref: target, since };
  throw new Error(`Unknown turn or snapshot: ${target}`);
}

const sameFile = (a: TreeItem | FileState, b: TreeItem | FileState) => a.oid === b.oid && a.mode === b.mode;

/** Tulis satu file byte-per-byte dari shadow repo, atau hapus kalau tidak ada di target. */
function writeAction(store: Store, rel: string, object: TreeItem | undefined): void {
  const abs = store.workspace.abs(rel);
  assertNoSymlinkParent(store.root, abs);
  if (existsSync(abs)) {
    if (lstatSync(abs).isDirectory()) throw new Error(`Directory blocks file: ${rel}`);
    rmSync(abs, { force: true });
  }
  if (!object) {
    removeEmptyParents(store.root, abs);
    return;
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  const content = store.repo.blob(object.oid);
  if (object.mode === '120000') {
    symlinkSync(content.toString(), abs);
    return;
  }
  writeFileSync(abs, content);
  if (process.platform !== 'win32') chmodSync(abs, object.mode === '100755' ? 0o755 : 0o644);
}

/** Jangan pernah menulis menembus symlink direktori ke luar workspace. */
function assertNoSymlinkParent(root: string, abs: string): void {
  for (let dir = path.dirname(abs); isInside(root, dir); dir = path.dirname(dir)) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`Symlink parent: ${dir}`);
  }
}

function removeEmptyParents(root: string, abs: string): void {
  for (let dir = path.dirname(abs); isInside(root, dir); dir = path.dirname(dir)) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/** File yang sedang dibuka program lain di Windows gagal dengan EBUSY/EPERM; coba lagi sebentar. */
function withRetry(fn: () => void, attempts = 3): void {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== 'EBUSY' && code !== 'EPERM')) throw e;
      sleep(100 * i);
    }
  }
}
