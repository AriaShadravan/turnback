import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

/**
 * Hooks, the MCP server, and background warm often run without a console on Windows.
 * Any child started without `windowsHide` then opens its own console window, which flashes on screen.
 */
it('hides the window of every child process started from src', () => {
  const missing: string[] = [];
  for (const name of readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts'))) {
    const source = readFileSync(path.join('src', name), 'utf8');
    for (const m of source.matchAll(/\bspawn(?:Sync)?\(/g)) {
      const call = source.slice(m.index, source.indexOf(');', m.index));
      if (!call.includes('windowsHide: true')) missing.push(`${name}: ${call.split('\n')[0]}`);
    }
  }
  expect(missing).toEqual([]);
});
