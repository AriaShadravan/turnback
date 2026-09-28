import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, renameSync, writeFileSync } from 'node:fs';
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
const CORRUPT_PREFIX = 'corrupt-';

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

/** All Turnback data for one workspace: journal, shadow repo, and recording mode. */
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
   * `edits-only` is used for workspaces above 100k files or 2 GB: only paths touched
   * by edit tools are snapshotted. The mode is decided by `warm` and persisted.
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

  /**
   * Snapshot under the lock. Failures or lock timeouts are recorded in the journal, not thrown.
   * If the snapshot failed because the shadow repo is corrupt, it is moved aside and the
   * snapshot is retried once on a fresh repo, which then serves as the new baseline.
   */
  snapshot(kind: EntryKind, origin: EntryOrigin, scope?: string[]): Entry {
    try {
      return this.locked(() => {
        try {
          return this.snapshotLocked(kind, origin, scope);
        } catch (e) {
          if (!this.repo.isCorrupt()) throw e;
          const folder = this.quarantine();
          this.log({ ...originFields(origin), kind: 'repair', status: 'ok', note: `Corrupt shadow repo moved to ${folder}: ${e}` });
          return this.snapshotLocked(kind, origin, scope);
        }
      });
    } catch (e) {
      return this.log({ ...originFields(origin), kind, status: e instanceof LockTimeoutError ? 'skipped' : 'failed', note: String(e) });
    }
  }

  /**
   * Save the workspace state as a new commit. Without `scope`, the whole tree is compared
   * with the previous snapshot; with `scope`, only those paths are updated in the index.
   * The first full snapshot is written through `git fast-import` (see `ShadowRepo.importSnapshot`).
   * Must be called inside the lock.
   */
  snapshotLocked(kind: EntryKind, origin: EntryOrigin, scope?: string[]): Entry {
    this.repo.init();
    const previous = this.latestRef();
    let skipped: string[] = [];

    if (!previous && !scope) {
      const scan = this.workspace.scan();
      const ref = this.repo.importSnapshot(scan.paths, rel => this.workspace.read(rel), kind);
      return this.log({ ...originFields(origin), kind, ref, status: 'ok', note: skippedNote(scan.skipped) });
    }

    if (!previous) {
      this.repo.load();
      this.repo.stage(this.relativePaths(scope!).filter(p => this.workspace.snapshotable(p)));
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
    return this.log({ ...originFields(origin), kind, ref, status: 'ok', note: skippedNote(skipped) });
  }

  /**
   * Move the unusable shadow repo and its journal into `corrupt-<time>/`; nothing is deleted.
   * The lock file stays in place, so other processes keep waiting on the same lock.
   */
  private quarantine(): string {
    const folder = path.join(this.dir, `${CORRUPT_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(folder, { recursive: true });
    for (const name of ['repo.git', 'journal.jsonl', 'index-ref']) {
      const from = path.join(this.dir, name);
      if (existsSync(from)) renameSync(from, path.join(folder, name));
    }
    return folder;
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

  // ---- Background baseline ----

  /** The expensive first snapshot, run in the background on install and session start. */
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
   * Wait for warm to finish, then return the last snapshot if it still matches the work-tree.
   * That way the turn baseline does not need a new snapshot.
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

  // ---- Turn history ----

  /** Agent turns that have a baseline, newest first. Turns removed by gc are excluded. */
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

  /** Find a turn by full ID (`agent:session:turn`) or by turn ID alone. */
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

  // ---- Status and cleanup ----

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
      corrupt: existsSync(this.dir)
        ? readdirSync(this.dir).filter(name => name.startsWith(CORRUPT_PREFIX)).map(name => path.join(this.dir, name))
        : [],
    };
  }

  /**
   * Delete turns older than 7 days that are not among the last 50 turns.
   * Refs still used by other turns or by internal Turnback snapshots are kept.
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

  /** Run `gc` if the last one was more than 24 hours ago. */
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
      try { total += item.isDirectory() ? directorySize(file) : lstatSync(file).size; } catch { /* removed by gc */ }
    }
  } catch { /* no snapshot yet */ }
  return total;
}

const skippedNote = (skipped: string[]) =>
  skipped.length ? `Skipped ${skipped.length}: ${skipped.slice(0, 20).join(', ')}` : undefined;
