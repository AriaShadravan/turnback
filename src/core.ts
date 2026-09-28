import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, statSync, openSync, closeSync, unlinkSync, rmSync, rmdirSync, appendFileSync, readlinkSync, symlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { Entry, HookEvent } from './types.js';

const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = Number(process.env.TURNBACK_MAX_FILES || 100000);
const MAX_BYTES = 2 * 1024 ** 3;
const EXCLUDED = new Set(['.git', '.turnback', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.nuxt', '.cache', 'coverage', '.turbo', '.gradle']);
export const dataHome = () => process.env.TURNBACK_HOME || path.join(homedir(), '.turnback');
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const norm = (s: string) => process.platform === 'win32' ? path.resolve(s).replaceAll('\\', '/').toLowerCase() : path.resolve(s);
export function workspace(cwd = process.cwd()): string {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1500 });
  return r.status === 0 ? path.resolve(r.stdout.trim()) : path.resolve(cwd);
}
export class Store {
  readonly root: string; readonly dir: string; readonly gitDir: string;
  private matcher: Ignore;
  constructor(cwd: string) {
    this.root = workspace(cwd); this.dir = path.join(dataHome(), hash(norm(this.root)).slice(0, 24)); this.gitDir = path.join(this.dir, 'repo.git');
    this.matcher = ignore();
    try { this.matcher.add(readFileSync(path.join(this.root,'.turnbackignore'),'utf8')); } catch { /* optional */ }
    try { this.matcher.add((JSON.parse(readFileSync(path.join(dataHome(),'config.json'),'utf8')).exclude || []) as string[]); } catch { /* optional */ }
  }
  private git(args: string[], input?: string | Buffer): string {
    const start = performance.now();
    const r = spawnSync('git', [`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', ...args], { encoding: 'utf8', input, timeout: args[0] === 'add' ? 180000 : 30000, maxBuffer: 64 * 1024 * 1024 });
    if (process.env.TURNBACK_TRACE_GIT) process.stderr.write(`${args[0]} ${Math.round(performance.now()-start)}ms\n`);
    if (r.error && String(r.error).includes('ETIMEDOUT')) { try { unlinkSync(path.join(this.gitDir,'index.lock')); } catch { /* no lock */ } }
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  }
  init(): void {
    if (existsSync(this.gitDir)) return;
    mkdirSync(this.dir, { recursive: true });
    const r = spawnSync('git', ['init', '--bare', this.gitDir], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) throw new Error(r.stderr || 'git init failed');
    mkdirSync(path.join(this.gitDir,'info'),{recursive:true});
    writeFileSync(path.join(this.gitDir,'info','exclude'), [...EXCLUDED].map(x => `${x}/`).join('\n') + '\n');
  }
  lock<T>(fn: () => T, timeout = 3000): T {
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'lock'); const start = Date.now();
    for (;;) {
      try { const fd = openSync(file, 'wx'); writeFileSync(fd, `${process.pid}\n${Date.now()}`); closeSync(fd); break; }
      catch (e) {
        if (!existsSync(file)) continue;
        try { if (Date.now() - statSync(file).mtimeMs > 60000) { unlinkSync(file); continue; } } catch { continue; }
        if (Date.now() - start >= timeout) throw new Error('workspace lock timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      }
    }
    try { return fn(); } finally { try { unlinkSync(file); } catch { /* another process recovered stale lock */ } }
  }
  entries(): Entry[] {
    try { return readFileSync(path.join(this.dir, 'journal.jsonl'), 'utf8').split('\n').flatMap(x => { try { return x ? [JSON.parse(x) as Entry] : []; } catch { return []; } }); }
    catch { return []; }
  }
  log(e: Omit<Entry, 'id' | 'time'>): Entry { const item = { ...e, id: randomUUID(), time: new Date().toISOString() }; mkdirSync(this.dir, { recursive: true }); appendFileSync(path.join(this.dir, 'journal.jsonl'), JSON.stringify(item) + '\n'); return item; }
  private ignored(rel: string): boolean {
    const parts = rel.split('/'); if (parts.some(p => EXCLUDED.has(p))) return true;
    return this.matcher.ignores(rel);
  }
  files(): { paths: string[]; skipped: string[]; fingerprint: string; bytes: number } {
    const paths: string[] = [], skipped: string[] = [], fingerprint = createHash('sha256'); let bytes = 0; const visit = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, item.name), rel = path.relative(this.root, abs).split(path.sep).join('/');
        if (this.ignored(rel)) continue;
        try { const st = lstatSync(abs); if (st.isDirectory()) visit(abs); else if (st.isFile() || st.isSymbolicLink()) { if (st.size > MAX_FILE) skipped.push(rel); else { paths.push(rel); bytes += st.size; fingerprint.update(rel).update(String(st.size)).update(String(st.mtimeMs)).update(String(st.mode)); } } }
        catch { skipped.push(rel); }
      }
    }; visit(this.root); return { paths, skipped, fingerprint: fingerprint.digest('hex'), bytes };
  }
  fingerprint(): string { return this.files().fingerprint; }
  mode(persist = false): 'full' | 'edits-only' {
    try { if (JSON.parse(readFileSync(path.join(this.dir,'mode.json'),'utf8')).mode === 'edits-only') return 'edits-only'; } catch { /* inspect */ }
    const scan = this.files(); const mode = scan.paths.length > MAX_FILES || scan.bytes > MAX_BYTES ? 'edits-only' : 'full';
    if (persist && mode === 'edits-only') { mkdirSync(this.dir,{recursive:true}); writeFileSync(path.join(this.dir,'mode.json'),JSON.stringify({mode})); }
    return mode;
  }
  warm(): Entry {
    if (this.mode(true) === 'edits-only') return this.log({agent:'turnback',session:'warm',turn:'warm',kind:'warm',status:'ok',note:'edits-only mode; shell turns unprotected'});
    try { return this.lock(() => {
        const before = this.fingerprint();
        const entry = this.snapshotLocked('warm', { agent: 'turnback', session: 'warm', turn: 'warm' });
        if (entry.ref && before === this.fingerprint()) writeFileSync(path.join(this.dir,'warm.json'), JSON.stringify({ ref: entry.ref, fingerprint: before }));
        return entry;
      }, 30000);
    } catch (e) { return this.log({ agent: 'turnback', session: 'warm', turn: 'warm', kind: 'warm', status: 'failed', note: String(e) }); }
  }
  warmRef(): string | undefined {
    try {
      const ref = this.latestRef(); if (!ref || readFileSync(path.join(this.dir,'index-ref'),'utf8').trim() !== ref) return undefined;
      const diff = spawnSync('git',[`--git-dir=${this.gitDir}`,`--work-tree=${this.root}`,'diff-files','--quiet'],{timeout:5000});
      if (diff.status !== 0) return undefined;
      for (const args of [['ls-files','-o','--exclude-standard','--directory','-z'],['ls-files','-o','-i','--exclude-standard','--directory','-z']]) {
        for (const raw of this.git(args).split('\0')) {
          if (!raw || this.ignored(raw.replace(/\/$/,''))) continue;
          const abs = path.join(this.root,raw);
          try { const st = lstatSync(abs); if (st.isDirectory() || st.size <= MAX_FILE) return undefined; } catch { return undefined; }
        }
      }
      return ref;
    } catch { return undefined; }
  }
  waitWarm(timeout = 30000): string | undefined {
    const start = Date.now(), lock = path.join(this.dir,'lock');
    while (existsSync(lock) && Date.now() - start < timeout) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
    return this.warmRef();
  }
  latestRef(): string | undefined { return this.entries().filter(e => e.ref && e.status === 'ok').at(-1)?.ref; }
  snapshot(kind: string, base: Pick<Entry, 'agent' | 'session' | 'turn'>, paths?: string[], pathOnlyBaseline = false): Entry {
    try { return this.lock(() => this.snapshotLocked(kind, base, paths, pathOnlyBaseline), 30000); }
    catch (e) { return this.log({ ...base, kind, status: String(e).includes('lock timeout') ? 'skipped' : 'failed', note: String(e) }); }
  }
  snapshotLocked(kind: string, base: Pick<Entry, 'agent' | 'session' | 'turn'>, changedPaths?: string[], pathOnlyBaseline = false): Entry {
    this.init(); const previous = this.latestRef(); let skipped: string[] = [];
    const indexRefFile = path.join(this.dir,'index-ref');
    if (!previous || pathOnlyBaseline) {
      const scan = pathOnlyBaseline ? { paths: (changedPaths || []).map(p => this.safeRelative(p)).filter((p): p is string => !!p && !this.ignored(p) && existsSync(path.join(this.root,p)) && lstatSync(path.join(this.root,p)).size <= MAX_FILE), skipped: [] as string[] } : this.files(); skipped = scan.skipped;
      this.git(['read-tree', '--empty']);
      if (scan.paths.length) {
        const specs = path.join(this.dir, `paths-${randomUUID()}`);
        try { writeFileSync(specs, Buffer.from(scan.paths.join('\0') + '\0')); this.git(['add', '-f', '--pathspec-from-file=' + specs, '--pathspec-file-nul']); }
        finally { try { unlinkSync(specs); } catch { /* cleanup */ } }
      }
    } else {
      let indexRef = ''; try { indexRef = readFileSync(indexRefFile,'utf8').trim(); } catch { /* first incremental */ }
      if (indexRef !== previous) this.git(['read-tree', previous]);
      const ordinary = changedPaths?.length ? [] : [...this.git(['diff-files','--name-only','-z']).split('\0'), ...this.git(['ls-files','-o','--exclude-standard','-z']).split('\0')];
      const ignored = changedPaths?.length ? [] : this.git(['ls-files','-o','-i','--exclude-standard','-z']).split('\0').filter(p => p && !this.ignored(p));
      const candidates = new Set([...ordinary,...ignored,...(changedPaths || [])]);
      const add: string[] = [], remove: string[] = [];
      for (const raw of candidates) {
        if (!raw) continue; const p = this.safeRelative(raw); if (!p) continue;
        const abs = path.join(this.root,p);
        if (this.ignored(p)) { remove.push(p); continue; }
        try { const st = lstatSync(abs); if (st.isFile() || st.isSymbolicLink()) { if (st.size > MAX_FILE) { skipped.push(p); remove.push(p); } else add.push(p); } }
        catch { remove.push(p); }
      }
      const apply = (args: string[], list: string[]) => { if (!list.length) return; const specs = path.join(this.dir,`paths-${randomUUID()}`); try { writeFileSync(specs,Buffer.from(list.join('\0')+'\0')); this.git([...args,'--pathspec-from-file='+specs,'--pathspec-file-nul']); } finally { try { unlinkSync(specs); } catch { /* cleanup */ } } };
      apply(['rm','-f','--cached','--ignore-unmatch'],remove);
      apply(['add','-f'],add);
      if (!add.length && !remove.length) return this.log({ ...base, kind, ref: previous, status: 'ok', paths: changedPaths || (base as Partial<Entry>).paths, command: (base as Partial<Entry>).command });
    }
    const tree = this.git(['write-tree']).trim();
    const args = ['commit-tree', tree, '-m', kind];
    const commit = this.git(args).trim(); const ref = `refs/turnback/s/${randomUUID().replaceAll('-', '')}`;
    this.git(['update-ref', ref, commit]); writeFileSync(indexRefFile,ref);
    const detail = base as Partial<Entry>;
    return this.log({ ...base, kind, ref, status: 'ok', paths: changedPaths || detail.paths, command: detail.command, note: pathOnlyBaseline ? 'edits-only' : skipped.length ? `Skipped ${skipped.length}: ${skipped.slice(0, 20).join(', ')}` : undefined });
  }
  safeRelative(p: string): string | undefined {
    const abs = path.resolve(this.root, p); const rel = path.relative(this.root, abs).split(path.sep).join('/');
    return rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) ? rel : undefined;
  }
  tree(ref: string): Map<string, { oid: string; mode: string }> {
    const out = this.git(['ls-tree', '-r', '-z', ref]); const map = new Map<string, { oid: string; mode: string }>();
    for (const line of out.split('\0')) { if (!line) continue; const i = line.indexOf('\t'), [mode,,oid] = line.slice(0,i).split(' '); map.set(line.slice(i+1), { mode, oid }); }
    return map;
  }
  blob(oid: string): Buffer { const r = spawnSync('git', [`--git-dir=${this.gitDir}`, 'cat-file', 'blob', oid], { encoding: 'buffer', timeout: 30000, maxBuffer: MAX_FILE + 1024 }); if (r.status !== 0) throw new Error(String(r.stderr)); return r.stdout as Buffer; }
  diff(a: string, b: string): string { return this.git(['diff', '--stat', a, b]) + this.git(['diff', '--no-ext-diff', a, b]); }
  turns() {
    const map = new Map<string, Entry[]>();
    for (const e of this.entries()) if (e.agent !== 'turnback' && e.kind !== 'session-start') { const key = `${e.agent}:${e.session}:${e.turn}`; map.set(key, [...(map.get(key) || []), e]); }
    let expired: string[] = []; try { expired = JSON.parse(readFileSync(path.join(this.dir,'expired.json'),'utf8')); } catch { /* no gc yet */ }
    const gone = new Set(expired);
    return [...map].filter(([id]) => !gone.has(id)).map(([id, items]) => ({ id, agent: items[0].agent, time: items[0].time, baseline: items.find(e => e.kind === 'baseline' && e.ref)?.ref, end: [...items].reverse().find(e => e.ref)?.ref, status: items.some(e => e.status !== 'ok') ? 'partial' : 'ok', entries: items })).filter(t => t.baseline).reverse();
  }
  changedFiles(start: string, end: string): number { return this.git(['diff','--name-only','-z',start,end]).split('\0').filter(Boolean).length; }
  statDiff(start: string, end: string): string { return this.git(['diff','--stat',start,end]); }
  status() {
    const scan = this.files(), entries = this.entries(); let storageBytes = 0;
    const walk = (dir: string) => { for (const item of readdirSync(dir,{withFileTypes:true})) { const f = path.join(dir,item.name); try { if (item.isDirectory()) walk(f); else storageBytes += lstatSync(f).size; } catch { /* concurrent gc */ } } };
    try { walk(this.dir); } catch { /* no snapshots */ }
    return { workspace:this.root, storage:this.dir, storageBytes, turns:this.turns().length, mode: scan.paths.length > 100000 || scan.bytes > 2 * 1024 ** 3 ? 'oversized' : 'full', skippedFiles:scan.skipped, failures:entries.filter(e => e.status !== 'ok').slice(-20) };
  }
  gc() {
    return this.lock(() => {
      const turns = this.turns(); const cutoff = Date.now() - 7 * 86400000;
      const expired = turns.filter((t,i) => i >= 50 && Date.parse(t.time) < cutoff);
      const keep = new Set(this.entries().filter(e => e.agent === 'turnback').map(e => e.ref).filter(Boolean));
      for (const t of turns.filter(t => !expired.includes(t))) for (const e of t.entries) if (e.ref) keep.add(e.ref);
      for (const t of expired) for (const e of t.entries) if (e.ref && !keep.has(e.ref)) this.git(['update-ref','-d',e.ref]);
      let previous: string[] = []; try { previous = JSON.parse(readFileSync(path.join(this.dir,'expired.json'),'utf8')); } catch { /* no gc yet */ }
      writeFileSync(path.join(this.dir,'expired.json'),JSON.stringify([...new Set([...previous,...expired.map(t => t.id)])]));
      if (expired.length) this.git(['gc','--prune=now']);
      this.log({agent:'turnback',session:'gc',turn:'gc',kind:'gc',status:'ok',note:`Expired ${expired.length} turns`});
      return { expired: expired.length };
    },30000);
  }
  undoTarget(): string | undefined {
    let depth = 0;
    for (const e of this.entries()) { if (e.status !== 'ok') continue; if (e.kind === 'restore') depth = 0; else if (e.kind === 'undo') depth++; else if (e.kind === 'redo') depth = Math.max(0,depth-1); }
    return this.turns()[depth]?.id;
  }
  redoTarget(): string | undefined {
    const stack: string[] = [];
    for (const e of this.entries()) { if (e.status !== 'ok') continue; if ((e.kind === 'restore' || e.kind === 'undo') && e.ref) stack.push(e.ref); else if (e.kind === 'redo') stack.pop(); }
    return stack.at(-1);
  }
  target(id: string): string {
    const turn = this.turns().find(t => t.id === id || t.id.endsWith(':' + id));
    if (turn?.baseline) return turn.baseline;
    if (this.entries().some(e => e.ref === id)) return id;
    throw new Error(`Unknown turn or snapshot: ${id}`);
  }
  workspaceState(): string {
    const h = createHash('sha256'); const { paths } = this.files();
    for (const p of paths.sort()) { const f = path.join(this.root,p); h.update(p); const st = lstatSync(f); h.update(String(st.mode)); h.update(st.isSymbolicLink() ? readlinkSync(f) : readFileSync(f)); }
    return h.digest('hex');
  }
  plan(target: string, selected?: string[]) {
    const ref = this.target(target), desired = this.tree(ref), current = new Map<string, { digest: string; mode: string }>();
    const scan = this.files(), oversized = new Set(scan.skipped);
    for (const p of scan.paths) { const f = path.join(this.root,p); const st = lstatSync(f); current.set(p, { digest: hash(st.isSymbolicLink() ? readlinkSync(f) : readFileSync(f)), mode: st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644' }); }
    const allowed = selected?.map(p => { const rel = this.safeRelative(p); if (!rel) throw new Error(`Path outside workspace: ${p}`); return rel; });
    const actions: { path: string; action: 'create' | 'modify' | 'delete'; uncertain: boolean }[] = [];
    const lastEnd = [...this.entries()].reverse().find(e => (e.kind === 'turn-end' || e.kind === 'post-restore') && e.ref)?.ref;
    const lastTree = lastEnd ? this.tree(lastEnd) : new Map();
    for (const p of new Set([...desired.keys(), ...current.keys()])) {
      if (this.ignored(p) || oversized.has(p)) continue;
      if (allowed?.length && !allowed.some(a => p === a || p.startsWith(a + '/'))) continue;
      const want = desired.get(p), have = current.get(p); if (!want && !have) continue;
      if (want && have && hash(this.blob(want.oid)) === have.digest && want.mode === have.mode) continue;
      const prior = lastTree.get(p); const uncertain = !!prior && !!have && (have.digest !== hash(this.blob(prior.oid)) || have.mode !== prior.mode);
      actions.push({ path: p, action: want ? have ? 'modify' : 'create' : 'delete', uncertain });
    }
    const state = this.workspaceState(); const token = hash(JSON.stringify({ root: norm(this.root), ref, allowed, actions, state }));
    return { target, ref, paths: allowed, actions, state, token, skippedLarge: [...oversized] };
  }
  restore(target: string, selected?: string[], token?: string, skipUncertain = false, operation: 'restore' | 'undo' | 'redo' = 'restore') {
    return this.lock(() => {
      const plan = this.plan(target, selected); if (token && token !== plan.token) throw new Error('Stale or invalid confirmation token');
      const safety = this.snapshotLocked('pre-restore', { agent: 'turnback', session: 'restore', turn: randomUUID() });
      if (!safety.ref) throw new Error('Safety snapshot failed');
      const tree = this.tree(plan.ref), applied: string[] = [], skipped: string[] = [], failed: string[] = [];
      for (const a of plan.actions) {
        if (skipUncertain && a.uncertain) { skipped.push(a.path); continue; }
        const abs = path.join(this.root, a.path);
        try {
          let parent = path.dirname(abs);
          while (parent !== this.root && parent.startsWith(this.root + path.sep)) { if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('symlink parent'); parent = path.dirname(parent); }
          if (existsSync(abs)) { if (lstatSync(abs).isDirectory()) throw new Error('directory blocks file'); rmSync(abs, { force: true }); }
          const object = tree.get(a.path);
          if (object) { mkdirSync(path.dirname(abs), { recursive: true }); if (object.mode === '120000') symlinkSync(this.blob(object.oid).toString(), abs); else { writeFileSync(abs, this.blob(object.oid)); if (process.platform !== 'win32') chmodSync(abs, object.mode === '100755' ? 0o755 : 0o644); } }
          else { let dir = path.dirname(abs); while (dir !== this.root && dir.startsWith(this.root + path.sep)) { try { if (readdirSync(dir).length) break; rmdirSync(dir); } catch { break; } dir = path.dirname(dir); } }
          applied.push(a.path);
        } catch { failed.push(a.path); }
      }
      this.log({ agent: 'turnback', session: 'restore', turn: target, kind: operation, ref: safety.ref, status: failed.length ? 'failed' : 'ok', paths: applied, note: JSON.stringify({ target, skipped, failed }) });
      if (applied.length) this.snapshotLocked('post-restore', { agent: 'turnback', session: 'restore', turn: target });
      return { applied, skipped, failed, safety: safety.ref, plan };
    }, 30000);
  }
}

export function record(event: HookEvent): Entry | undefined {
  const s = new Store(event.cwd), key = `${event.agent}:${event.session}:${event.turn}`;
  const entries = s.entries().filter(e => `${e.agent}:${e.session}:${e.turn}` === key);
  if (event.kind === 'session-start' || event.kind === 'turn-start') return s.log({ ...event, status: 'ok' });
  if (event.kind === 'turn-end') {
    if (!entries.some(e => e.kind === 'baseline')) return s.log({ ...event, status: 'ok' });
    const editOnly = !entries.some(e => e.kind === 'shell' || e.kind === 'baseline' && e.command !== undefined);
    const edited = [...new Set(entries.filter(e => e.kind === 'baseline' || e.kind === 'edit-intent').flatMap(e => e.paths || []))];
    return s.snapshot('turn-end', event, editOnly && edited.length ? edited : undefined);
  }
  if (!entries.some(e => e.kind === 'baseline' && e.status === 'ok')) {
    const start = Date.now();
    const warm = s.waitWarm();
    if (!warm && Date.now() - start >= 30000) return s.log({ ...event, status: 'unprotected', note: 'Warm baseline exceeded 30 seconds' });
    const baseline = warm ? s.log({ ...event, kind: 'baseline', ref: warm, status: 'ok' }) : s.snapshot('baseline', event);
    if (baseline.status !== 'ok') return s.log({ ...event, kind: event.kind, status: 'unprotected', note: 'Baseline unavailable' });
  }
  if (!entries.some(e => e.kind === 'baseline')) return s.entries().filter(e => `${e.agent}:${e.session}:${e.turn}` === key).at(-1);
  if (event.kind === 'edit' && event.paths?.length && !entries.some(e => e.kind === 'shell' || e.kind === 'baseline' && e.command !== undefined)) {
    const prior = [...entries].reverse().find(e => e.kind === 'edit-intent' || e.kind === 'baseline');
    const result = s.snapshot('edit', event, prior?.paths?.length ? prior.paths : undefined);
    s.log({ ...event, kind: 'edit-intent', status: result.status, note: result.status === 'ok' ? undefined : result.note });
    return result;
  }
  return s.snapshot(event.kind, event);
}
