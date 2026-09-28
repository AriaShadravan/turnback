import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, record } from '../src/core.js';
import { parseHook, hookResponse } from '../src/adapters.js';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(),'turnback-test-')); process.env.TURNBACK_HOME = mkdtempSync(path.join(tmpdir(),'turnback-data-')); spawnSync('git',['init',root]); });
function event(kind: 'edit'|'shell'|'turn-end', turn = 't1') { return { agent: 'codex' as const, session: 's', turn, cwd: root, kind, paths: ['a.txt'] }; }

describe('shadow snapshots', () => {
  it('restores tracked, ignored, deleted and byte-exact files without changing user .git', () => {
    writeFileSync(path.join(root,'.gitignore'),'.env\n'); writeFileSync(path.join(root,'.env'), Buffer.from([0xef,0xbb,0xbf,13,10,0,255]));
    writeFileSync(path.join(root,'a.txt'),'before\r\n');
    const gitBefore = readFileSync(path.join(root,'.git','HEAD'));
    expect(record(event('shell'))?.status).toBe('ok');
    rmSync(path.join(root,'.env')); writeFileSync(path.join(root,'a.txt'),'after'); writeFileSync(path.join(root,'new.txt'),'new');
    expect(record(event('turn-end'))?.status).toBe('ok');
    const s = new Store(root), plan = s.plan('t1');
    expect(plan.actions.map(a => a.path).sort()).toEqual(['.env','a.txt','new.txt']);
    const result = s.restore('t1',undefined,plan.token);
    expect(result.failed).toEqual([]); expect(readFileSync(path.join(root,'a.txt'),'utf8')).toBe('before\r\n');
    expect(readFileSync(path.join(root,'.env'))).toEqual(Buffer.from([0xef,0xbb,0xbf,13,10,0,255]));
    expect(existsSync(path.join(root,'new.txt'))).toBe(false); expect(readFileSync(path.join(root,'.git','HEAD'))).toEqual(gitBefore);
  });
  it('rejects stale token and preserves manual edits in cautious mode', () => {
    writeFileSync(path.join(root,'a.txt'),'before'); record(event('edit')); writeFileSync(path.join(root,'a.txt'),'agent'); record(event('turn-end'));
    const s = new Store(root), old = s.plan('t1'); writeFileSync(path.join(root,'a.txt'),'manual');
    expect(() => s.restore('t1',undefined,old.token)).toThrow(/Stale/);
    const current = s.plan('t1'); expect(current.actions[0].uncertain).toBe(true);
    const result = s.restore('t1',undefined,current.token,true); expect(result.skipped).toEqual(['a.txt']);
    expect(readFileSync(path.join(root,'a.txt'),'utf8')).toBe('manual');
  });
  it('redo reverses a completed restore and undo advances through turns', () => {
    writeFileSync(path.join(root,'a.txt'),'zero'); record(event('edit','t1'));
    writeFileSync(path.join(root,'a.txt'),'one'); record(event('turn-end','t1'));
    record(event('edit','t2')); writeFileSync(path.join(root,'a.txt'),'two'); record(event('turn-end','t2'));
    const s = new Store(root);
    expect(s.undoTarget()).toContain('t2');
    const p = s.plan(s.undoTarget()!); s.restore(p.target,undefined,p.token,false,'undo');
    expect(readFileSync(path.join(root,'a.txt'),'utf8')).toBe('one');
    expect(s.undoTarget()).toContain('t1');
    const redo = s.redoTarget()!; const rp = s.plan(redo); s.restore(redo,undefined,rp.token,false,'redo');
    expect(readFileSync(path.join(root,'a.txt'),'utf8')).toBe('two');
    expect(s.undoTarget()).toContain('t2');
  });
  it('records snapshot failure and keeps hook response permissive', () => {
    writeFileSync(path.join(root,'a.txt'),'x');
    const s = new Store(root); mkdirSync(s.dir,{recursive:true}); writeFileSync(s.gitDir,'broken shadow git');
    const e = s.snapshot('baseline', event('edit'), ['a.txt']); expect(e.status).toBe('failed');
    expect(hookResponse('cursor')).toBe('{"permission":"allow"}');
  });
});

describe('hook adapters', () => {
  it('recognizes all four agents and apply_patch paths', () => {
    const cases = [
      ['claude',{hook_event_name:'PreToolUse',session_id:'s',tool_name:'Bash',tool_input:{command:'rm a'},cwd:root},'shell'],
      ['codex',{hook_event_name:'PreToolUse',session_id:'s',turn_id:'t',tool_name:'apply_patch',tool_input:{command:'*** Update File: a.txt\n*** Move to: b.txt'},cwd:root},'edit'],
      ['gemini',{hook_event_name:'BeforeTool',session_id:'s',tool_name:'write_file',tool_input:{file_path:'a.txt'},cwd:root},'edit'],
      ['cursor',{hook_event_name:'beforeShellExecution',conversation_id:'s',generation_id:'t',command:'rm a',cwd:root},'shell']
    ] as const;
    for (const [agent,payload,kind] of cases) expect(parseHook(agent,payload)?.kind).toBe(kind);
    expect(parseHook('codex',cases[1][1])?.paths).toEqual(['a.txt','b.txt']);
  });
});
