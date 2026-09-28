import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { dataHome, EXCLUDED_DIRS, MAX_FILE_BYTES } from './config.js';

export interface Scan {
  /** File dalam cakupan snapshot (path relatif, pemisah `/`). */
  paths: string[];
  /** File di atas batas ukuran atau tidak bisa dibaca. */
  skipped: string[];
  bytes: number;
}

export interface FileState {
  /** ID blob git dari isi file, supaya bisa dibandingkan langsung dengan tree shadow repo. */
  oid: string;
  mode: string;
}

/** Folder proyek pengguna: aturan pengecualian, pemindaian, dan pembacaan isi file. */
export class Workspace {
  private readonly matcher: Ignore = ignore();

  constructor(readonly root: string) {
    try { this.matcher.add(readFileSync(path.join(root, '.turnbackignore'), 'utf8')); } catch { /* opsional */ }
    try {
      const config = JSON.parse(readFileSync(path.join(dataHome(), 'config.json'), 'utf8'));
      this.matcher.add((config.exclude ?? []) as string[]);
    } catch { /* opsional */ }
  }

  abs(rel: string): string {
    return path.join(this.root, rel);
  }

  /** Path relatif terhadap root, atau `undefined` kalau berada di luar workspace. */
  relative(p: string): string | undefined {
    const rel = path.relative(this.root, path.resolve(this.root, p)).split(path.sep).join('/');
    return rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) ? rel : undefined;
  }

  excluded(rel: string): boolean {
    return rel.split('/').some(part => EXCLUDED_DIRS.has(part)) || this.matcher.ignores(rel);
  }

  /** File biasa atau symlink yang ada, masuk cakupan, dan tidak melewati batas ukuran. */
  snapshotable(rel: string): boolean {
    if (this.excluded(rel)) return false;
    const st = this.stat(rel);
    return !!st && (st.isFile() || st.isSymbolicLink()) && st.size <= MAX_FILE_BYTES;
  }

  stat(rel: string): Stats | undefined {
    try { return lstatSync(this.abs(rel)); } catch { return undefined; }
  }

  scan(): Scan {
    const result: Scan = { paths: [], skipped: [], bytes: 0 };
    const visit = (dir: string) => {
      const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        const abs = path.join(dir, item.name);
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        if (this.excluded(rel)) continue;
        try {
          const st = lstatSync(abs);
          if (st.isDirectory()) visit(abs);
          else if (!st.isFile() && !st.isSymbolicLink()) continue;
          else if (st.size > MAX_FILE_BYTES) result.skipped.push(rel);
          else {
            result.paths.push(rel);
            result.bytes += st.size;
          }
        } catch {
          result.skipped.push(rel);
        }
      }
    };
    visit(this.root);
    return result;
  }

  /** Isi dan mode file seperti yang akan disimpan git; `undefined` kalau file tidak ada. */
  fileState(rel: string, oidLength: number): FileState | undefined {
    const st = this.stat(rel);
    if (!st || !(st.isFile() || st.isSymbolicLink())) return undefined;
    const abs = this.abs(rel);
    const content = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs);
    const mode = st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644';
    return { oid: blobId(content, oidLength), mode };
  }
}

/** ID objek blob git (SHA-1 atau SHA-256, mengikuti format repo). */
export function blobId(content: Buffer, oidLength = 40): string {
  return createHash(oidLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}
