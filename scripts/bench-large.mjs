// Measure Turnback on a large synthetic workspace (default 150k files), where it switches to
// edits-only mode. Every hook and command runs as its own `node dist/cli.js` process, as agents
// run them, so process start-up is included. Not part of CI: creating the files takes minutes.
//
//   npm run build && node scripts/bench-large.mjs [files]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FILES = Number(process.argv[2] ?? 150_000);
const PER_DIR = 500;
const TARGET_MS = 500;
const CLI = path.resolve('dist/cli.js');

const root = mkdtempSync(path.join(tmpdir(), 'turnback-large-'));
const home = mkdtempSync(path.join(tmpdir(), 'turnback-large-data-'));
const env = { ...process.env, TURNBACK_HOME: home };
const file = (i) => path.join(root, `d${Math.floor(i / PER_DIR)}`, `f${i % PER_DIR}.txt`);
const results = [];

function cli(label, args, input) {
  const start = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const ms = Math.round(performance.now() - start);
  results.push({ step: label, ms, exit: r.status });
  if (r.status !== 0) results.at(-1).stderr = r.stderr.trim().slice(0, 300);
  return r;
}

const hook = (label, payload) => cli(label, ['hook', 'claude'], JSON.stringify({ session_id: 'bench', cwd: root, ...payload }));
const edit = (label, i, content) => {
  hook(label, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file(i) } });
  writeFileSync(file(i), content);
};

try {
  let start = performance.now();
  spawnSync('git', ['init', '-q', root], { windowsHide: true });
  for (let i = 0; i < FILES; i++) {
    if (i % PER_DIR === 0) mkdirSync(path.dirname(file(i)));
    writeFileSync(file(i), `file ${i}\n`);
  }
  results.push({ step: `create ${FILES} files (setup)`, ms: Math.round(performance.now() - start) });

  // Cold start: the session-start warm runs in the background while the agent's first turn begins.
  start = performance.now();
  const warm = spawn(process.execPath, [CLI, 'warm'], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  const warmDone = new Promise(resolve => warm.on('exit', code => resolve(code)));
  hook('turn 1 start (warm running)', { hook_event_name: 'UserPromptSubmit', prompt: 'bench turn 1' });
  edit('turn 1 first edit (warm running)', 0, 'turn 1\n');
  const warmCode = await warmDone;
  results.push({ step: 'warm: scan and choose mode (background)', ms: Math.round(performance.now() - start), exit: warmCode });
  hook('turn 1 end', { hook_event_name: 'Stop' });
  const turn1 = JSON.parse(cli('list --json (turn 1)', ['list', '--json']).stdout)[0]?.id;
  const turn1Steps = turn1 ? cli('steps (turn 1)', ['steps', turn1]).stdout.trim() : '(no turn)';
  const journal = readFileSync(path.join(home, readdirSync(home).find(d => d !== 'logs' && !d.endsWith('.json')), 'journal.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).map(e => `${e.kind}:${e.status}${e.ref ? ':ref' : ''}${e.note ? ` (${e.note})` : ''}`);

  const mode = JSON.parse(cli('status --json', ['status', '--json']).stdout).mode;

  // A warm turn in whatever mode was chosen.
  hook('turn 2 start', { hook_event_name: 'UserPromptSubmit', prompt: 'bench turn 2' });
  edit('turn 2 first edit', 1, 'turn 2\n');
  edit('turn 2 second edit', 2, 'turn 2 again\n');
  hook('turn 2 shell command', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm d0/f3.txt' } });
  rmSync(file(3));
  hook('turn 2 end', { hook_event_name: 'Stop' });

  cli('list', ['list']);
  cli('status', ['status']);
  cli('undo --dry-run', ['undo', '--dry-run']);
  cli('undo --yes', ['undo', '--yes']);
  const restored = readFileSync(file(1), 'utf8');
  cli('redo --yes', ['redo', '--yes']);
  cli('blame', ['blame', file(0)]);
  cli('recover', ['recover', file(1), '--dry-run']);
  cli('stats', ['stats']);
  const turn2 = JSON.parse(cli('list --json', ['list', '--json']).stdout)[0].id;
  const steps = cli('steps', ['steps', turn2]).stdout;
  cli('gc', ['gc']);

  const width = Math.max(...results.map(r => r.step.length));
  for (const r of results) {
    const flag = r.step.includes('(setup)') || r.step.startsWith('warm') ? '' : r.ms > TARGET_MS && /start|edit|shell|end/.test(r.step) ? '  > target' : '';
    console.log(`${r.step.padEnd(width)}  ${String(r.ms).padStart(7)} ms${r.exit ? `  exit ${r.exit}` : ''}${flag}`);
    if (r.stderr) console.log(`${''.padEnd(width)}  ${r.stderr}`);
  }
  console.log(JSON.stringify({
    files: FILES, mode, hookTargetMs: TARGET_MS, turn1Steps, journalStart: journal.slice(0, 8),
    checks: {
      undoRestoredTurn2Edit: restored === 'file 1\n',
      shellStepInTurn2: steps.split('\n').find(line => line.includes('shell')) ?? '(none)',
    },
  }, null, 2));
} finally {
  // BENCH_KEEP=1 keeps the workspace for a closer look; its paths are printed.
  if (process.env.BENCH_KEEP) console.log(JSON.stringify({ kept: { root, home } }));
  else for (const dir of [root, home]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) {
      console.warn(`cleanup skipped: ${error.message}`);
    }
  }
}
