import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXCLUDED_DIRS, MAX_FILE_BYTES } from './config.js';

export interface TreeItem {
  oid: string;
  mode: string;
}

const REF_PREFIX = 'refs/turnback/s/';

/**
 * Repo git bare terpisah (`GIT_DIR`) dengan work-tree = folder proyek.
 * Repo `.git` milik pengguna tidak pernah disentuh.
 */
export class ShadowRepo {
  readonly gitDir: string;
  private readonly indexRefFile: string;
  private oidLength?: number;

  constructor(private readonly dataDir: string, private readonly root: string) {
    this.gitDir = path.join(dataDir, 'repo.git');
    this.indexRefFile = path.join(dataDir, 'index-ref');
  }

  init(): void {
    if (existsSync(this.gitDir)) return;
    mkdirSync(this.dataDir, { recursive: true });
    const r = spawnSync('git', ['init', '--bare', this.gitDir], { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) throw new Error(r.stderr || 'git init failed');
    mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
    writeFileSync(path.join(this.gitDir, 'info', 'exclude'), [...EXCLUDED_DIRS].map(d => `${d}/\n`).join(''));
  }

  /** Ref yang isinya sedang dimuat di index, supaya `read-tree` bisa dilewati. */
  get indexRef(): string | undefined {
    try { return readFileSync(this.indexRefFile, 'utf8').trim() || undefined; } catch { return undefined; }
  }

  /** Muat tree `ref` ke index; tanpa `ref`, kosongkan index. */
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

  /** Path yang berbeda dari index: berubah, terhapus, untracked, atau gitignored. */
  changedPaths(): string[] {
    return [
      ...this.list(['diff-files', '--name-only', '-z']),
      ...this.list(['ls-files', '-o', '--exclude-standard', '-z']),
      ...this.list(['ls-files', '-o', '-i', '--exclude-standard', '-z']),
    ];
  }

  /** Index sama persis dengan work-tree, kecuali untracked yang dikecualikan atau terlalu besar. */
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

  /** Simpan index sebagai commit tanpa parent dan beri ref baru. */
  commit(message: string): string {
    const tree = this.run(['write-tree']).trim();
    const commit = this.run(['commit-tree', tree, '-m', message]).trim();
    const ref = REF_PREFIX + randomUUID().replaceAll('-', '');
    this.run(['update-ref', ref, commit]);
    writeFileSync(this.indexRefFile, ref);
    return ref;
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
    const r = spawnSync('git', [`--git-dir=${this.gitDir}`, 'cat-file', 'blob', oid], { timeout: 30_000, maxBuffer: MAX_FILE_BYTES + 1024 });
    if (r.status !== 0) throw new Error(`git cat-file: ${String(r.stderr).trim()}`);
    return r.stdout;
  }

  /** Panjang ID objek repo ini: 40 (SHA-1) atau 64 (SHA-256). */
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
    return this.list(['diff', '--name-only', '-z', a, b]);
  }

  private run(args: string[], input?: string): string {
    const start = performance.now();
    const r = spawnSync('git', this.baseArgs(args), {
      cwd: this.root,
      encoding: 'utf8',
      input,
      timeout: args[0] === 'add' ? 180_000 : 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (process.env.TURNBACK_TRACE_GIT) process.stderr.write(`git ${args[0]} ${Math.round(performance.now() - start)}ms\n`);
    if (r.error?.message.includes('ETIMEDOUT')) {
      try { unlinkSync(path.join(this.gitDir, 'index.lock')); } catch { /* tidak ada lock */ }
    }
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  }

  private check(args: string[]): boolean {
    return spawnSync('git', this.baseArgs(args), { cwd: this.root, timeout: 5_000 }).status === 0;
  }

  private list(args: string[]): string[] {
    return this.run(args).split('\0').filter(Boolean);
  }

  /**
   * Git melaporkan dan menafsirkan path relatif terhadap folder kerja proses, jadi setiap
   * perintah dijalankan dari root workspace, bukan dari folder kerja hook.
   */
  private baseArgs(args: string[]): string[] {
    return [`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', ...args];
  }

  /** Daftar path panjang dikirim lewat file supaya tidak melewati batas panjang baris perintah. */
  private withPathspec(args: string[], paths: string[]): void {
    if (!paths.length) return;
    const file = path.join(this.dataDir, `paths-${randomUUID()}`);
    try {
      writeFileSync(file, paths.join('\0') + '\0');
      this.run([...args, `--pathspec-from-file=${file}`, '--pathspec-file-nul']);
    } finally {
      try { unlinkSync(file); } catch { /* sudah terhapus */ }
    }
  }
}
