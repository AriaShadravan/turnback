import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { Store } from '../src/core.js';

it('all hook executables fail open when storage cannot be created', () => {
  const root = mkdtempSync(path.join(tmpdir(),'turnback-hooks-'));
  spawnSync('git',['init',root]); writeFileSync(path.join(root,'a.txt'),'x');
  const blockedHome = path.join(root,'blocking-file'); writeFileSync(blockedHome,'not a directory');
  for (const agent of ['claude','codex','gemini','cursor']) {
    const payload = readFileSync(path.resolve(`test/fixtures/${agent}.json`),'utf8');
    const r = spawnSync(process.execPath,[path.resolve('dist/cli.js'),'hook',agent],{cwd:root,input:payload,encoding:'utf8',env:{...process.env,TURNBACK_HOME:blockedHome}});
    expect(r.status).toBe(0); expect(JSON.parse(r.stdout)).toEqual(agent === 'cursor' ? {permission:'allow'} : {});
  }
});

it('serializes ten concurrent hooks without blocking agent tools', async () => {
  const root = mkdtempSync(path.join(tmpdir(),'turnback-parallel-'));
  const home = mkdtempSync(path.join(tmpdir(),'turnback-parallel-data-'));
  spawnSync('git',['init',root]); writeFileSync(path.join(root,'a.txt'),'x');
  const payload = JSON.stringify({hook_event_name:'PreToolUse',session_id:'s',turn_id:'t',tool_name:'Bash',tool_input:{command:'echo ok'},cwd:root});
  const run = () => new Promise<{code:number|null,output:string}>(resolve => {
    const child = spawn(process.execPath,[path.resolve('dist/cli.js'),'hook','codex'],{cwd:root,env:{...process.env,TURNBACK_HOME:home},windowsHide:true});
    let output = ''; child.stdout.on('data',x => output += x); child.on('close',code => resolve({code,output})); child.stdin.end(payload);
  });
  const results = await Promise.all(Array.from({length:10},run));
  expect(results.every(r => r.code === 0 && r.output.trim() === '{}')).toBe(true);
  const old = process.env.TURNBACK_HOME; process.env.TURNBACK_HOME = home;
  try { const entries = new Store(root).entries().filter(e => e.agent === 'codex'); expect(entries.length).toBeGreaterThanOrEqual(10); expect(entries.every(e => e.status === 'ok' || e.status === 'skipped')).toBe(true); }
  finally { if (old === undefined) delete process.env.TURNBACK_HOME; else process.env.TURNBACK_HOME = old; }
}, 30000);
