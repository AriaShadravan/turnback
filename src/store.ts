import { mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EDITS_ONLY_BYTES, editsOnlyFiles, GC_INTERVAL_MS, LOCK_TIMEOUT_MS, RETENTION, WARM_WAIT_MS,
  workspaceDataDir, workspaceRoot,
} from './config.js';
import { Journal, turnKey } from './journal.js';
import { LockTimeoutError, waitForUnlock, withLock } from './lock.js';
import { ShadowRepo } from './shadow.js';
import type { Entry, EntryKind, EntryOrigin, Mode, NewEntry, Turn } from './types.js';
import { Workspace, type Scan } from './workspace.js';

const WARM_ORIGIN: EntryOrigin = { agent: 'turnback', session: 'warm', turn: 'warm' };

export interface TurnSummary {
  id: string;
  agent: Turn['agent'];
  time: string;
  status: Turn['status'];
  baseline: string;
  end?: string;
  changedFiles: number;
}

export interface GcOptions {
  now?: number;
  keepDays?: number;
  keepTurns?: number;
}

/** Semua data Turnback untuk satu workspace: journal, shadow repo, dan mode perekaman. */
export class Store {
  readonly root: string;
  readonly dir: string;
  readonly workspace: Workspace;
  readonly repo: ShadowRepo;
  private readonly journal: Journal;

  constructor(cwd: string) {
    this.root = workspaceRoot(cwd);
    this.dir = workspaceDataDir(this.root);
    this.workspace = new Workspace(this.root);
    this.repo = new ShadowRepo(this.dir, this.root);
    this.journal = new Journal(path.join(this.dir, 'journal.jsonl'));
  }

  entries(): Entry[] {
    return this.journal.read();
  }

  log(entry: NewEntry): Entry {
    return this.journal.append(entry);
  }

  latestRef(): string | undefined {
    return this.entries().filter(e => e.ref && e.status === 'ok').at(-1)?.ref;
  }

  locked<T>(fn: () => T): T {
    return withLock(this.dir, LOCK_TIMEOUT_MS, fn);
  }

  // ---- Mode ----

  /**
   * `edits-only` dipakai untuk workspace di atas 100 ribu file atau 2 GB: hanya path
   * yang disentuh tool edit yang di-snapshot. Mode ini ditetapkan oleh `warm` dan disimpan.
   */
  mode(): Mode {
    try {
      return JSON.parse(readFileSync(this.modeFile, 'utf8')).mode === 'edits-only' ? 'edits-only' : 'full';
    } catch {
      return 'full';
    }
  }

  private get modeFile(): string {
    return path.join(this.dir, 'mode.json');
  }

  private static modeFor(scan: Scan): Mode {
    return scan.paths.length > editsOnlyFiles() || scan.bytes > EDITS_ONLY_BYTES ? 'edits-only' : 'full';
  }

  // ---- Snapshot ----

  /** Snapshot dengan lock. Gagal atau lock habis waktu dicatat di journal, tidak dilempar. */
  snapshot(kind: EntryKind, origin: EntryOrigin, scope?: string[]): Entry {
    try {
      return this.locked(() => this.snapshotLocked(kind, origin, scope));
    } catch (e) {
      return this.log({ ...originFields(origin), kind, status: e instanceof LockTimeoutError ? 'skipped' : 'failed', note: String(e) });
    }
  }

  /**
   * Simpan keadaan workspace sebagai commit baru. Tanpa `scope`, seluruh tree dibandingkan
   * dengan snapshot sebelumnya; dengan `scope`, hanya path itu yang diperbarui di index.
   * Harus dipanggil di dalam lock.
   */
  snapshotLocked(kind: EntryKind, origin: EntryOrigin, scope?: string[]): Entry {
    this.repo.init();
    const previous = this.latestRef();
    let skipped: string[] = [];

    if (!previous) {
      this.repo.load();
      if (scope) {
        this.repo.stage(this.relativePaths(scope).filter(p => this.workspace.snapshotable(p)));
      } else {
        const scan = this.workspace.scan();
        skipped = scan.skipped;
        this.repo.stage(scan.paths);
      }
    } else {
      this.repo.load(previous);
      const changes = this.classify(scope ? this.relativePaths(scope) : this.repo.changedPaths());
      skipped = changes.skipped;
      this.repo.unstage(changes.remove);
      this.repo.stage(changes.add);
      if (!changes.add.length && !changes.remove.length) {
        return this.log({ ...originFields(origin), kind, ref: previous, status: 'ok' });
      }
    }

    const ref = this.repo.commit(kind);
    const note = skipped.length ? `Skipped ${skipped.length}: ${skipped.slice(0, 20).join(', ')}` : undefined;
    return this.log({ ...originFields(origin), kind, ref, status: 'ok', note });
  }

  relativePaths(paths: string[]): string[] {
    return [...new Set(paths.flatMap(p => this.workspace.relative(p) ?? []))];
  }

  private classify(paths: string[]) {
    const add: string[] = [], remove: string[] = [], skipped: string[] = [];
    for (const p of new Set(paths)) {
      if (this.workspace.excluded(p)) {
        remove.push(p);
        continue;
      }
      const st = this.workspace.stat(p);
      if (!st) remove.push(p);
      else if (!st.isFile() && !st.isSymbolicLink()) continue;
      else if (this.workspace.snapshotable(p)) add.push(p);
      else {
        skipped.push(p);
        remove.push(p);
      }
    }
    return { add, remove, skipped };
  }

  // ---- Baseline di latar belakang ----

  /** Snapshot pertama yang mahal, dijalankan di latar belakang saat install dan awal sesi. */
  warm(): Entry {
    try {
      const scan = this.workspace.scan();
      if (Store.modeFor(scan) === 'edits-only') {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(this.modeFile, JSON.stringify({ mode: 'edits-only' }));
        return this.log({ ...WARM_ORIGIN, kind: 'warm', status: 'ok', note: 'edits-only mode; shell commands are not snapshotted' });
      }
      return this.locked(() => this.snapshotLocked('warm', WARM_ORIGIN));
    } catch (e) {
      return this.log({ ...WARM_ORIGIN, kind: 'warm', status: 'failed', note: String(e) });
    }
  }

  /**
   * Tunggu warm selesai, lalu kembalikan snapshot terakhir kalau masih sama dengan work-tree.
   * Dengan begitu baseline giliran tidak perlu snapshot baru.
   */
  waitWarm(): string | undefined {
    waitForUnlock(this.dir, WARM_WAIT_MS);
    const ref = this.latestRef();
    if (!ref) return undefined;
    try {
      return this.repo.indexMatches(ref, rel => this.workspace.excluded(rel)) ? ref : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- Riwayat giliran ----

  /** Giliran agen yang punya baseline, terbaru lebih dulu. Giliran yang sudah di-gc tidak ikut. */
  turns(): Turn[] {
    const expired = new Set(this.expiredTurns());
    const groups = new Map<string, Entry[]>();
    for (const e of this.entries()) {
      if (e.agent === 'turnback' || e.kind === 'session-start') continue;
      const key = turnKey(e);
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const turns: Turn[] = [];
    for (const [id, entries] of groups) {
      const baseline = entries.find(e => e.kind === 'baseline' && e.ref)?.ref;
      if (!baseline || expired.has(id)) continue;
      turns.push({
        id,
        agent: entries[0].agent,
        time: entries[0].time,
        baseline,
        end: entries.findLast(e => e.ref)?.ref,
        status: entries.every(e => e.status === 'ok') ? 'ok' : 'partial',
        entries,
      });
    }
    return turns.reverse();
  }

  /** Cari giliran dari ID lengkap (`agen:sesi:giliran`) atau ID giliran saja. */
  findTurn(id: string): Turn | undefined {
    return this.turns().find(t => t.id === id || t.id.endsWith(':' + id));
  }

  summarize(turn: Turn): TurnSummary {
    const { entries, ...rest } = turn;
    return { ...rest, changedFiles: turn.end ? this.repo.diffNames(turn.baseline, turn.end).length : 0 };
  }

  turnDiff(id: string, patch: boolean): { turn: string; diff: string } {
    const turn = this.findTurn(id);
    if (!turn?.end) throw new Error(`Unknown or incomplete turn: ${id}`);
    const diff = patch ? this.repo.diffPatch(turn.baseline, turn.end) : this.repo.diffStat(turn.baseline, turn.end);
    return { turn: turn.id, diff };
  }

  // ---- Status dan pembersihan ----

  status() {
    const scan = this.workspace.scan();
    const entries = this.entries();
    return {
      workspace: this.root,
      storage: this.dir,
      storageBytes: directorySize(this.dir),
      mode: this.mode() === 'edits-only' || Store.modeFor(scan) === 'edits-only' ? 'edits-only' : 'full',
      turns: this.turns().length,
      lastGc: entries.findLast(e => e.kind === 'gc' && e.status === 'ok')?.time,
      skippedFiles: scan.skipped,
      failures: entries.filter(e => e.status !== 'ok').slice(-20),
    };
  }

  /**
   * Hapus giliran yang lebih tua dari 7 hari dan tidak termasuk 50 giliran terakhir.
   * Ref yang masih dipakai giliran lain atau snapshot internal Turnback tetap disimpan.
   */
  gc({ now = Date.now(), keepDays = RETENTION.days, keepTurns = RETENTION.turns }: GcOptions = {}) {
    return this.locked(() => {
      const turns = this.turns();
      const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
      const expired = turns.filter((t, i) => i >= keepTurns && Date.parse(t.time) < cutoff);
      const expiredIds = new Set(expired.map(t => t.id));

      const keep = new Set(this.entries().filter(e => e.agent === 'turnback').flatMap(e => e.ref ?? []));
      for (const t of turns) if (!expiredIds.has(t.id)) for (const e of t.entries) if (e.ref) keep.add(e.ref);
      const deleted = new Set(expired.flatMap(t => t.entries.flatMap(e => e.ref && !keep.has(e.ref) ? [e.ref] : [])));

      for (const ref of deleted) this.repo.deleteRef(ref);
      if (expired.length) {
        writeFileSync(this.expiredFile, JSON.stringify([...new Set([...this.expiredTurns(), ...expiredIds])]));
      }
      if (deleted.size) this.repo.prune();
      this.log({ agent: 'turnback', session: 'gc', turn: 'gc', kind: 'gc', status: 'ok', note: `Expired ${expired.length} turns` });
      return { expired: expired.length, deletedRefs: deleted.size };
    });
  }

  /** Jalankan `gc` kalau yang terakhir sudah lebih dari 24 jam lalu. */
  gcIfDue(now = Date.now()) {
    const last = this.entries().findLast(e => e.kind === 'gc' && e.status === 'ok');
    if (last && now - Date.parse(last.time) < GC_INTERVAL_MS) return undefined;
    return this.gc({ now });
  }

  private get expiredFile(): string {
    return path.join(this.dir, 'expired.json');
  }

  private expiredTurns(): string[] {
    try { return JSON.parse(readFileSync(this.expiredFile, 'utf8')); } catch { return []; }
  }
}

export function originFields(o: EntryOrigin): EntryOrigin {
  return { agent: o.agent, session: o.session, turn: o.turn, paths: o.paths, command: o.command };
}

function directorySize(dir: string): number {
  let total = 0;
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      try { total += item.isDirectory() ? directorySize(file) : lstatSync(file).size; } catch { /* dihapus gc */ }
    }
  } catch { /* belum ada snapshot */ }
  return total;
}
