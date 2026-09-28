import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install, uninstall } from '../src/install.js';

it('installs all project hooks idempotently and keeps unrelated settings', () => {
  const root = mkdtempSync(path.join(tmpdir(),'turnback-install-'));
  for (const agent of ['claude','codex','gemini','cursor']) {
    mkdirSync(path.join(root,'.'+agent));
    const file = path.join(root,'.'+agent, agent === 'codex' || agent === 'cursor' ? 'hooks.json' : 'settings.json');
    writeFileSync(file, JSON.stringify({ custom: { keep: true }, hooks: { Stop: [{ hooks: [{ type:'command', command:'other' }] }] } }));
  }
  const first = install('all',true,root,'/tmp/turnback/cli.js');
  const second = install('all',true,root,'/tmp/turnback/cli.js');
  expect(second).toEqual(first);
  for (const agent of ['claude','codex','gemini','cursor']) {
    const file = path.join(root,'.'+agent, agent === 'codex' || agent === 'cursor' ? 'hooks.json' : 'settings.json');
    const cfg = JSON.parse(readFileSync(file,'utf8'));
    expect(cfg.custom.keep).toBe(true);
    const event = agent === 'gemini' ? 'AfterAgent' : agent === 'cursor' ? 'stop' : 'Stop';
    expect(cfg.hooks[event].filter((g: any) => JSON.stringify(g).includes('turnback:')).length).toBe(1);
  }
  uninstall('all',true,root);
  for (const agent of ['claude','codex','gemini','cursor']) {
    const file = path.join(root,'.'+agent, agent === 'codex' || agent === 'cursor' ? 'hooks.json' : 'settings.json');
    const cfg = JSON.parse(readFileSync(file,'utf8'));
    expect(cfg.custom.keep).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('turnback:');
  }
});
