import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOCK_STALE_MS, sleep } from './config.js';

export class LockTimeoutError extends Error {
  constructor() { super('workspace lock timeout'); }
}

const lockFile = (dir: string) => path.join(dir, 'lock');

/** Jalankan `fn` sambil memegang lock file per workspace. Lock yang lebih tua dari 60 detik dianggap basi. */
export function withLock<T>(dir: string, timeoutMs: number, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, `${process.pid}\n${Date.now()}`);
      closeSync(fd);
      break;
    } catch {
      if (removeIfStale(file)) continue;
      if (Date.now() - start >= timeoutMs) throw new LockTimeoutError();
      sleep(30);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(file); } catch { /* proses lain sudah membersihkan lock basi */ }
  }
}

/** Tunggu sampai tidak ada yang memegang lock, atau batas waktu habis. */
export function waitForUnlock(dir: string, timeoutMs: number): void {
  const file = lockFile(dir);
  const start = Date.now();
  while (existsSync(file) && Date.now() - start < timeoutMs) sleep(50);
}

function removeIfStale(file: string): boolean {
  try {
    if (Date.now() - statSync(file).mtimeMs <= LOCK_STALE_MS) return false;
    unlinkSync(file);
    return true;
  } catch {
    // Lock hilang di antara dua panggilan: coba ambil lagi.
    return !existsSync(file);
  }
}
