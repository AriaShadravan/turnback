// Spike: is the first snapshot faster when written as one pack through `git fast-import`
// instead of `git add` (one loose object per file)? Usage: node scripts/spike-fast-import.mjs [files] [runs]
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../dist/store.js';

const FILES = Number(process.argv[2] ?? 10_000);
const RUNS = Number(process.argv[3] ?? 3);
const PER_DIR = 100;

const ms = start => Math.round(performance.now() - start);

function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'turnback-spike-'));
  spawnSync('git', ['init', '-q', root]);
  for (let i = 0; i < FILES / PER_DIR; i++) {
    const dir = path.join(root, `d${i}`);
    mkdirSync(dir);
    for (let j = 0; j < PER_DIR; j++) writeFileSync(path.join(dir, `f${j}.txt`), `file ${i}-${j}\n`.repeat(20));
  }
  return root;
}

/** A: the current path, `Store.warm()` (scan + `git add -f` + write-tree + commit-tree). */
function viaAdd(root, home) {
  process.env.TURNBACK_HOME = home;
  const store = new Store(root);
  let t = performance.now();
  const entry = store.warm();
  const baseline = ms(t);
  if (entry.status !== 'ok') throw new Error(entry.note);
  return { baseline, tree: treeOf(store, entry.ref), ...nextSnapshot(root, store, entry.ref) };
}

/** B: scan + one commit streamed to `git fast-import`, then load it into the index. */
async function viaFastImport(root, home) {
  process.env.TURNBACK_HOME = home;
  const store = new Store(root);
  const phases = {};
  let t = performance.now();
  store.repo.init();
  const git = (args, opts = {}) => {
    const r = spawnSync('git', [`--git-dir=${store.repo.gitDir}`, `--work-tree=${root}`, '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', ...opts });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
    return r.stdout;
  };

  const scan = store.workspace.scan();
  phases.scan = ms(t);

  t = performance.now();
  const ref = 'refs/turnback/spike';
  const fi = spawn('git', [`--git-dir=${store.repo.gitDir}`, 'fast-import', '--quiet', '--done'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  fi.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => fi.on('close', resolve));
  const write = chunk => fi.stdin.write(chunk) || new Promise(r => fi.stdin.once('drain', r));
  const when = `${Math.floor(Date.now() / 1000)} +0000`;
  await write(`commit ${ref}\ncommitter Turnback <turnback@localhost> ${when}\ndata 4\nwarm\n`);
  for (const rel of scan.paths) {
    const abs = path.join(root, rel);
    const st = lstatSync(abs);
    const content = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs);
    const mode = st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644';
    await write(`M ${mode} inline "${rel.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\ndata ${content.length}\n`);
    await write(content);
    await write('\n');
  }
  await write('\ndone\n');
  fi.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error(`fast-import: ${stderr}`);
  phases.fastImport = ms(t);

  t = performance.now();
  git(['read-tree', ref]);
  phases.readTree = ms(t);
  t = performance.now();
  // Fill in stat data so later `diff-files` compares stats instead of rehashing every file.
  spawnSync('git', [`--git-dir=${store.repo.gitDir}`, `--work-tree=${root}`, 'update-index', '-q', '--refresh'], { cwd: root });
  phases.refresh = ms(t);
  writeFileSync(path.join(store.dir, 'index-ref'), ref);
  // Record it like `warm` does, so the next snapshot diffs against it instead of starting over.
  store.log({ agent: 'turnback', session: 'warm', turn: 'warm', kind: 'warm', ref, status: 'ok' });

  const baseline = Object.values(phases).reduce((a, b) => a + b, 0);
  const packs = readdirSync(path.join(store.repo.gitDir, 'objects', 'pack')).filter(f => f.endsWith('.pack')).length;
  return { baseline, phases, packs, tree: treeOf(store, ref), ...nextSnapshot(root, store, ref) };
}

const treeOf = (store, ref) => spawnSync('git', [`--git-dir=${store.repo.gitDir}`, 'rev-parse', `${ref}^{tree}`], { encoding: 'utf8' }).stdout.trim();

/** Cost that hooks feel afterwards: a full-tree snapshot after one file changed. */
function nextSnapshot(root, store, ref) {
  writeFileSync(path.join(root, 'd0', 'f0.txt'), `changed ${Date.now()}\n`);
  const t = performance.now();
  const entry = store.locked(() => store.snapshotLocked('shell', { agent: 'codex', session: 'spike', turn: '1' }));
  const next = ms(t);
  if (entry.status !== 'ok') throw new Error(entry.note);
  const changed = store.repo.diffNames(ref, entry.ref);
  return { next, changed: changed.length };
}

const results = { A: [], B: [] };
for (let run = 0; run < RUNS; run++) {
  for (const variant of ['A', 'B']) {
    const root = makeProject();
    const home = mkdtempSync(path.join(tmpdir(), 'turnback-spike-data-'));
    try {
      results[variant].push(variant === 'A' ? viaAdd(root, home) : await viaFastImport(root, home));
    } finally {
      for (const dir of [root, home]) {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* report anyway */ }
      }
    }
  }
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(JSON.stringify({
  files: FILES, runs: RUNS, platform: process.platform, node: process.version,
  add: { baselineMs: median(results.A.map(r => r.baseline)), nextMs: median(results.A.map(r => r.next)) },
  fastImport: {
    baselineMs: median(results.B.map(r => r.baseline)), nextMs: median(results.B.map(r => r.next)),
    phases: results.B.at(-1).phases, packs: results.B.at(-1).packs,
  },
  sameTree: new Set([...results.A, ...results.B].map(r => r.tree)).size === 1,
  changedInNext: { add: results.A.map(r => r.changed), fastImport: results.B.map(r => r.changed) },
}, null, 2));
