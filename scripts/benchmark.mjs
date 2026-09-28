import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, record } from '../dist/core.js';

const root = mkdtempSync(path.join(tmpdir(),'turnback-bench-'));
const home = mkdtempSync(path.join(tmpdir(),'turnback-bench-data-'));
process.env.TURNBACK_HOME = home;
try {
  spawnSync('git',['init',root]);
  for (let i=0; i<100; i++) { const dir = path.join(root,`d${i}`); mkdirSync(dir); for (let j=0; j<100; j++) writeFileSync(path.join(dir,`f${j}.txt`),`file ${i}-${j}\n`); }
  const s = new Store(root); let start = performance.now(); const warm = s.warm(); const warmMs = performance.now()-start;
  start = performance.now(); s.fingerprint(); const fingerprintMs = performance.now()-start;
  start = performance.now(); spawnSync('git',[`--git-dir=${s.gitDir}`,`--work-tree=${root}`,'diff-files','--quiet']); const gitDiffMs = performance.now()-start;
  start = performance.now(); spawnSync('git',[`--git-dir=${s.gitDir}`,`--work-tree=${root}`,'ls-files','-o','--exclude-standard','-z']); const gitUntrackedMs = performance.now()-start;
  start = performance.now(); const first = record({agent:'codex',session:'bench',turn:'1',cwd:root,kind:'edit',paths:['d0/f0.txt']}); const hookMs = performance.now()-start;
  writeFileSync(path.join(root,'d0','f0.txt'),'changed\n');
  start = performance.now(); const second = record({agent:'codex',session:'bench',turn:'1',cwd:root,kind:'edit',paths:['d0/f1.txt']}); const secondMs = performance.now()-start;
  writeFileSync(path.join(root,'d0','f1.txt'),'changed too\n');
  start = performance.now(); const end = record({agent:'codex',session:'bench',turn:'1',cwd:root,kind:'turn-end'}); const endMs = performance.now()-start;
  start = performance.now(); const shell = record({agent:'codex',session:'bench',turn:'1',cwd:root,kind:'shell',command:'echo test'}); const shellMs = performance.now()-start;
  console.log(JSON.stringify({ files:10000, warmMs:Math.round(warmMs), fingerprintMs:Math.round(fingerprintMs), gitDiffMs:Math.round(gitDiffMs), gitUntrackedMs:Math.round(gitUntrackedMs), firstEditHookMs:Math.round(hookMs), secondEditHookMs:Math.round(secondMs), turnEndMs:Math.round(endMs), shellHookMs:Math.round(shellMs), targetMs:500, warmStatus:warm.status, firstStatus:first?.status, secondStatus:second?.status, endStatus:end?.status, shellStatus:shell?.status }));
} finally { for (const target of [root,home]) { if (path.resolve(target).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(target).startsWith('turnback-bench-')) rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:200}); } }
