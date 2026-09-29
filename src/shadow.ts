import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXCLUDED_DIRS, importBatchBytes, MAX_FILE_BYTES } from './config.js';
import { blobId } from './workspace.js';

export interface TreeItem {
  oid: string;
  mode: string;
}

const REF_PREFIX = 'refs/turnback/s/';
const RAW_ATTRIBUTES = '* -text -eol -filter -ident -working-tree-encoding\n';

/**
 * Separate bare git repo (`GIT_DIR`) whose work-tree is the project folder.
 * The user's own `.git` repo is never touched.
 */
export class ShadowRepo {
  readonly gitDir: string;
  private readonly indexRefFile: string;
  private oidLength?: number;
  /** Snapshot refs never change once written, so their diffs can be cached for the life of the process. */
  private readonly names = new Map<string, string[]>();

  constructor(private readonly dataDir: string, private readonly root: string) {
    this.gitDir = path.join(dataDir, 'repo.git');
    this.indexRefFile = path.join(dataDir, 'index-ref');
  }

  init(): void {
    const attributes = path.join(this.gitDir, 'info', 'attributes');
    if (existsSync(attributes)) return;
    if (!existsSync(this.gitDir)) {
      mkdirSync(this.dataDir, { recursive: true });
      const r = spawnSync('git', ['init', '--bare', this.gitDir], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      if (r.status !== 0) throw new Error(r.stderr || 'git init failed');
      mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
      writeFileSync(path.join(this.gitDir, 'info', 'exclude'), [...EXCLUDED_DIRS].map(d => `${d}/\n`).join(''));
    }
    // Store bytes as they are: this file overrides the project's .gitattributes (text, eol, filters).
    writeFileSync(attributes, RAW_ATTRIBUTES);
  }

  /** Ref whose tree is currently loaded in the index, so `read-tree` can be skipped. */
  get indexRef(): string | undefined {
    try { return readFileSync(this.indexRefFile, 'utf8').trim() || undefined; } catch { return undefined; }
  }

  /** Load the tree of `ref` into the index; without `ref`, empty the index. */
  load(ref?: string): void {
    if (ref && ref === this.indexRef) return;
    this.run(ref ? ['read-tree', ref] : ['read-tree', '--empty']);
  }

  stage(paths: string[]): void {
    this.withPathspec(['add', '-f'], paths);
  }

  unstage(paths: string[]): void {
    this.withPathspec(['rm', '-f', '--cached', '--ignore-unmatch'], paths);
  }

  /** Paths that differ from the index: modified, deleted, untracked, or gitignored. */
  changedPaths(): string[] {
    return [
      ...this.list(['diff-files', '--name-only', '-z']),
      ...this.list(['ls-files', '-o', '--exclude-standard', '-z']),
      ...this.list(['ls-files', '-o', '-i', '--exclude-standard', '-z']),
    ];
  }

  /** Index matches the work-tree exactly, except untracked files that are excluded or too large. */
  indexMatches(ref: string, excluded: (rel: string) => boolean): boolean {
    if (this.indexRef !== ref) return false;
    if (!this.check(['diff-files', '--quiet'])) return false;
    for (const args of [['ls-files', '-o', '--exclude-standard', '--directory', '-z'], ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z']]) {
      for (const raw of this.list(args)) {
        if (excluded(raw.replace(/\/$/, ''))) continue;
        try {
          const st = lstatSync(path.join(this.root, raw));
          if (st.isDirectory() || st.size <= MAX_FILE_BYTES) return false;
        } catch {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Write a full snapshot as a parentless commit through `git fast-import`: one pack per batch of
   * blobs instead of one loose object per file, which is what makes a first `git add` slow. The
   * commit lists every path by object ID. The index is then loaded from it, with stat data
   * refreshed so later `diff-files` calls compare stats instead of rehashing every file.
   */
  importSnapshot(paths: string[], read: (rel: string) => { content: Buffer; mode: string } | undefined, message: string): string {
    const oidLength = this.objectIdLength();
    const tree: string[] = [];
    let blobs: Buffer[] = [], size = 0;
    const flush = () => {
      if (!blobs.length) return;
      this.run(['fast-import', '--quiet', '--done'], Buffer.concat([...blobs, Buffer.from('done\n')]));
      blobs = [];
      size = 0;
    };
    for (const rel of paths) {
      const file = read(rel);
      if (!file) continue;
      blobs.push(Buffer.from(`blob\ndata ${file.content.length}\n`), file.content, Buffer.from('\n'));
      size += file.content.length;
      tree.push(`M ${file.mode} ${blobId(file.content, oidLength)} ${quotePath(rel)}\n`);
      if (size >= importBatchBytes()) flush();
    }
    flush();

    const ref = REF_PREFIX + randomUUID().replaceAll('-', '');
    const header = `commit ${ref}\ncommitter Turnback <turnback@localhost> ${Math.floor(Date.now() / 1000)} +0000\n`
      + `data ${Buffer.byteLength(message)}\n${message}\n`;
    this.run(['fast-import', '--quiet', '--done'], `${header}${tree.join('')}\ndone\n`);
    this.run(['read-tree', ref]);
    // Exits 1 when some entries still differ (a file changed meanwhile); diff-files reports those later.
    spawnSync('git', this.baseArgs(['update-index', '-q', '--refresh']), { cwd: this.root, timeout: 180_000, windowsHide: true });
    writeFileSync(this.indexRefFile, ref);
    return ref;
  }

  /** Save the index as a parentless commit and give it a new ref. */
  commit(message: string): string {
    const tree = this.run(['write-tree']).trim();
    const commit = this.run(['commit-tree', tree, '-m', message]).trim();
    const ref = REF_PREFIX + randomUUID().replaceAll('-', '');
    this.run(['update-ref', ref, commit]);
    writeFileSync(this.indexRefFile, ref);
    return ref;
  }

  /**
   * The repo cannot be used: the git dir is not a repository, objects reachable from refs are
   * missing, or the index is unreadable. A check that cannot run at all (git missing, timeout)
   * counts as healthy, so data is never moved aside for reasons outside the repo.
   */
  isCorrupt(): boolean {
    if (!existsSync(this.gitDir)) return false;
    for (const args of [['fsck', '--no-progress', '--connectivity-only', '--no-dangling'], ['ls-files', '--stage']]) {
      const r = spawnSync('git', this.baseArgs(args), { cwd: this.root, timeout: 120_000, stdio: 'ignore', windowsHide: true });
      if (r.error) return false;
      if (r.status !== 0) return true;
    }
    return false;
  }

  refExists(ref: string): boolean {
    return this.check(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  }

  deleteRef(ref: string): void {
    this.run(['update-ref', '-d', ref]);
  }

  prune(): void {
    this.run(['gc', '--prune=now', '--quiet']);
  }

  tree(ref: string): Map<string, TreeItem> {
    const map = new Map<string, TreeItem>();
    for (const line of this.list(['ls-tree', '-r', '-z', ref])) {
      const tab = line.indexOf('\t');
      const [mode, , oid] = line.slice(0, tab).split(' ');
      map.set(line.slice(tab + 1), { mode, oid });
    }
    return map;
  }

  blob(oid: string): Buffer {
    const r = spawnSync('git', [`--git-dir=${this.gitDir}`, 'cat-file', 'blob', oid], { timeout: 30_000, maxBuffer: MAX_FILE_BYTES + 1024, windowsHide: true });
    if (r.status !== 0) throw new Error(`git cat-file: ${String(r.stderr).trim()}`);
    return r.stdout;
  }

  /** Object ID length of this repo: 40 (SHA-1) or 64 (SHA-256). */
  objectIdLength(): number {
    this.oidLength ??= this.run(['hash-object', '--stdin'], '').trim().length;
    return this.oidLength;
  }

  diffStat(a: string, b: string): string {
    return this.run(['diff', '--stat', a, b]);
  }

  diffPatch(a: string, b: string): string {
    return this.diffStat(a, b) + this.run(['diff', '--no-ext-diff', a, b]);
  }

  diffNames(a: string, b: string): string[] {
    const key = `${a}..${b}`;
    let names = this.names.get(key);
    if (!names) this.names.set(key, names = this.list(['diff', '--name-only', '-z', a, b]));
    return names;
  }

  private run(args: string[], input?: string | Buffer): string {
    const start = performance.now();
    const r = spawnSync('git', this.baseArgs(args), {
      cwd: this.root,
      encoding: 'utf8',
      input,
      timeout: args[0] === 'add' || args[0] === 'fast-import' ? 180_000 : 30_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (process.env.TURNBACK_TRACE_GIT) process.stderr.write(`git ${args[0]} ${Math.round(performance.now() - start)}ms\n`);
    if (r.error?.message.includes('ETIMEDOUT')) {
      try { unlinkSync(path.join(this.gitDir, 'index.lock')); } catch { /* no lock */ }
    }
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  }

  private check(args: string[]): boolean {
    return spawnSync('git', this.baseArgs(args), { cwd: this.root, timeout: 5_000, windowsHide: true }).status === 0;
  }

  private list(args: string[]): string[] {
    return this.run(args).split('\0').filter(Boolean);
  }

  /**
   * Git reports and interprets paths relative to the process working folder, so every
   * command runs from the workspace root, not from the hook's working folder.
   * Snapshot commits use a fixed identity so they work without a configured git user.
   */
  private baseArgs(args: string[]): string[] {
    return [
      `--git-dir=${this.gitDir}`, `--work-tree=${this.root}`,
      '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true',
      '-c', 'user.name=Turnback', '-c', 'user.email=turnback@localhost', '-c', 'user.useConfigOnly=false',
      ...args,
    ];
  }

  /** Long path lists are passed through a file to stay under the command line length limit. */
  private withPathspec(args: string[], paths: string[]): void {
    if (!paths.length) return;
    const file = path.join(this.dataDir, `paths-${randomUUID()}`);
    try {
      writeFileSync(file, paths.join('\0') + '\0');
      this.run([...args, `--pathspec-from-file=${file}`, '--pathspec-file-nul']);
    } finally {
      try { unlinkSync(file); } catch { /* already deleted */ }
    }
  }
}

/** C-style quoting for a fast-import path; required for names starting with `"` or containing LF. */
function quotePath(rel: string): string {
  return `"${rel.replace(/[\\"]/g, c => `\\${c}`).replaceAll('\n', '\\n')}"`;
}
