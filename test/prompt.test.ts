import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PROMPT_CHARS } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

function turnWithPrompt(prompt: string) {
  const p = tempProject('turnback-prompt-');
  p.write('a.txt', 'old');
  hook(p.root, 'turn-start', 't', { prompt });
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'new');
  hook(p.root, 'turn-end', 't');
  return p;
}

const summary = (root: string) => {
  const store = new Store(root);
  return store.summarize(store.turns()[0]);
};

it('labels a turn with its prompt on one line', () => {
  const p = turnWithPrompt('refactor\n  the auth\tmiddleware  ');
  expect(summary(p.root).prompt).toBe('refactor the auth middleware');
});

it('clips long prompts', () => {
  const p = turnWithPrompt('x'.repeat(1000));
  const prompt = summary(p.root).prompt!;
  expect(prompt).toHaveLength(PROMPT_CHARS);
  expect(prompt.endsWith('…')).toBe(true);
});

it('does not store prompts when disabled in config.json', () => {
  const p = tempProject('turnback-prompt-off-');
  writeFileSync(path.join(p.home, 'config.json'), JSON.stringify({ prompts: false }));
  p.write('a.txt', 'old');
  hook(p.root, 'turn-start', 't', { prompt: 'SECRET=hunter2' });
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  hook(p.root, 'turn-end', 't');
  expect(summary(p.root).prompt).toBeUndefined();
  expect(JSON.stringify(new Store(p.root).entries())).not.toContain('hunter2');
});

it('keeps turns recorded before prompts existed readable', () => {
  const p = tempProject('turnback-prompt-old-');
  p.write('a.txt', 'old');
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  hook(p.root, 'turn-end', 't');
  expect(summary(p.root).prompt).toBeUndefined();
});

it('keeps recording when config.json is not an object', () => {
  for (const content of ['null', '42', '"text"', '{"exclude": 5}']) {
    const p = tempProject('turnback-bad-config-');
    writeFileSync(path.join(p.home, 'config.json'), content);
    p.write('a.txt', 'old');
    hook(p.root, 'turn-start', 't', { prompt: 'fix' });
    hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
    hook(p.root, 'turn-end', 't');
    expect(summary(p.root).prompt, content).toBe('fix');
  }
});
