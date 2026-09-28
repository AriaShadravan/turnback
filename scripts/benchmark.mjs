// Ukur latensi hook pada repo sintetis 10 ribu file. Dilaporkan di CI, bukan gerbang keras.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { record } from '../dist/recorder.js';
import { Store } from '../dist/store.js';

const DIRS = 100;
const FILES_PER_DIR = 100;
const TARGET_MS = 500;

const root = mkdtempSync(path.join(tmpdir(), 'turnback-bench-'));
const home = mkdtempSync(path.join(tmpdir(), 'turnback-bench-data-'));
process.env.TURNBACK_HOME = home;

function time(fn) {
  const start = performance.now();
  const value = fn();
  return [Math.round(performance.now() - start), value];
}

const hook = (kind, extra = {}) => record({ agent: 'codex', session: 'bench', turn: '1', cwd: root, kind, ...extra });

try {
  spawnSync('git', ['init', '-q', root]);
  for (let i = 0; i < DIRS; i++) {
    const dir = path.join(root, `d${i}`);
    mkdirSync(dir);
    for (let j = 0; j < FILES_PER_DIR; j++) writeFileSync(path.join(dir, `f${j}.txt`), `file ${i}-${j}\n`);
  }

  const store = new Store(root);
  const [warmMs, warm] = time(() => store.warm());
  const [scanMs] = time(() => store.workspace.scan());
  const [firstEditMs, first] = time(() => hook('edit', { paths: [path.join(root, 'd0', 'f0.txt')] }));
  writeFileSync(path.join(root, 'd0', 'f0.txt'), 'changed\n');
  const [secondEditMs, second] = time(() => hook('edit', { paths: [path.join(root, 'd0', 'f1.txt')] }));
  writeFileSync(path.join(root, 'd0', 'f1.txt'), 'changed too\n');
  const [turnEndMs, end] = time(() => hook('turn-end'));
  const [shellMs, shell] = time(() => hook('shell', { command: 'echo test' }));

  console.log(JSON.stringify({
    files: DIRS * FILES_PER_DIR,
    targetMs: TARGET_MS,
    warmMs, scanMs, firstEditMs, secondEditMs, turnEndMs, shellMs,
    status: { warm: warm.status, firstEdit: first?.status, secondEdit: second?.status, turnEnd: end?.status, shell: shell?.status },
  }, null, 2));
} finally {
  for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
