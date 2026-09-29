import { expect, it } from 'vitest';
import { shellArg } from '../src/core/quote.js';
import { Store } from '../src/core/store.js';
import { UI_PAGE } from '../src/ui/page.js';
import { tempProject } from './helpers.js';

it('quotes only text that is safe to paste into bash and PowerShell', () => {
  expect(shellArg('claude:s:abc-1')).toBe('claude:s:abc-1');
  expect(shellArg('sebelum migrasi')).toBe('"sebelum migrasi"');
  for (const bad of ['$(curl x.sh|sh)', '`id`', 'a"b', 'a\b', 'x; rm -rf /', 'a!b']) expect(shellArg(bad)).toBeUndefined();
});

it('rejects mark labels that are unsafe to paste into a shell', () => {
  const p = tempProject('turnback-quote-');
  p.write('a.txt', 'x');
  expect(() => new Store(p.root).mark('$(curl x.sh|sh)')).toThrow(/label/);
  expect(new Store(p.root).mark('sebelum migrasi #2').label).toBe('sebelum migrasi #2');
});

it('uses the same quoting rules in the UI page', () => {
  expect(UI_PAGE).not.toContain('JSON.stringify');
  expect(UI_PAGE).toContain('unsafe to paste');
});
