import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Entry, NewEntry } from './types.js';

export const turnKey = (e: Pick<Entry, 'agent' | 'session' | 'turn'>) => `${e.agent}:${e.session}:${e.turn}`;

/** Journal JSONL append-only. Baris yang terpotong diabaikan saat dibaca. */
export class Journal {
  constructor(private readonly file: string) {}

  read(): Entry[] {
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch { return []; }
    return text.split('\n').flatMap(line => {
      if (!line) return [];
      try { return [JSON.parse(line) as Entry]; } catch { return []; }
    });
  }

  append(entry: NewEntry): Entry {
    const item: Entry = { ...entry, id: randomUUID(), time: new Date().toISOString() };
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(item) + '\n');
    return item;
  }
}
