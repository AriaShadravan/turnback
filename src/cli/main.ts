#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookResponse, parseHook } from '../agents/adapters.js';
import { dataHome } from '../core/config.js';
import { parseArgs, type Args } from './args.js';
import { exportCommit, exportPatch } from '../core/export.js';
import { compareTurns } from '../core/compare.js';
import { sessionReport } from '../core/report.js';
import { formatMarks, formatSteps, formatTurns } from '../core/format.js';
import { install, uninstall } from '../agents/install.js';
import { shellArg } from '../core/quote.js';
import { pendingForeignRoots, record } from '../core/recorder.js';
import { turnWarning } from '../core/warnings.js';
import { applyRestore, planRestore, redoTarget, undoTarget, type Operation } from '../core/restore.js';
import { Store } from '../core/store.js';
import type { Agent, HookEvent } from '../core/types.js';

const USAGE = `Usage:
  turnback install|uninstall <claude|codex|gemini|cursor|opencode|antigravity|all> [--project] [--no-mcp]
  turnback list [--json] | status | gc
  turnback steps <turn> [--json]
  turnback log <file|folder> [--json]
  turnback diff <turn>
  turnback mark <label> | marks [--json]
  turnback restore <turn|mark|snapshot> [--before-step <n>] [--path <p>...] [--dry-run | --yes]
  turnback undo | redo [--dry-run | --yes]
  turnback export <turn...> [--out <file.patch>] | --commit [--message <text>]
  turnback report [--session <id>]
  turnback compare <turnA> <turnB> [--json]
  turnback ui [--port <n>] [--no-open]
  turnback mcp`;

const CLI = fileURLToPath(import.meta.url);

function output(value: unknown): void {
  process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
}

/** Hook entry point: always answers "allow", whatever happens while recording. */
async function runHook(agent: Agent, eventName?: string): Promise<void> {
  let response = hookResponse(agent, eventName);
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    response = hookResponse(agent, payload.hook_event_name ?? eventName);
    const event = parseHook(agent, payload, process.cwd(), eventName);
    if (event) {
      const foreign = event.kind === 'turn-end' ? pendingForeignRoots(event) : [];
      record(event);
      if (needsWarm(event)) warmInBackground(event.cwd);
      if (event.kind === 'turn-end') {
        const warning = turnWarning(event, foreign);
        if (warning) response = hookResponse(agent, payload.hook_event_name ?? eventName, warning);
      }
    }
  } catch (e) {
    logHookError(e);
  }
  if (response) process.stdout.write(response + '\n');
}

/** Warm at session start, or at a turn start while the workspace has no snapshot (Antigravity has no session hook). */
function needsWarm(event: HookEvent): boolean {
  if (event.kind === 'session-start') return true;
  return event.kind === 'turn-start' && !new Store(event.cwd).latestRef();
}

function runRestore(store: Store, operation: Operation, args: Args): void {
  const step = args.values.get('--before-step');
  const target = operation === 'undo' ? undoTarget(store)
    : operation === 'redo' ? redoTarget(store)
    : step !== undefined && args.positional[0] ? store.stepRef(args.positional[0], Number(step))
    : args.positional[0];
  if (!target) throw new Error(operation === 'restore' ? 'Missing target turn or snapshot' : `Nothing to ${operation}`);
  const paths = args.paths.length ? args.paths : undefined;
  const plan = planRestore(store, target, paths);
  output({ target, scope: plan.scope, actions: plan.actions, skippedLarge: plan.skippedLarge });
  if (args.flags.has('--dry-run')) return;
  if (!args.flags.has('--yes')) {
    output('Use --yes to apply this plan.');
    return;
  }
  const result = applyRestore(store, target, { paths, token: plan.token, operation });
  output({ applied: result.applied, failed: result.failed, safety: result.safety });
  output('Agent conversation context is not restored; tell the agent what changed.');
  if (result.failed.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === 'hook') return runHook(args.positional[0] as Agent, args.positional[1]);
  if (command === 'mcp') return (await import('../mcp/server.js')).serveMcp();

  const store = new Store(process.cwd());
  switch (command) {
    case 'warm':
      store.warm();
      store.gcIfDue();
      return;
    case 'install':
      output(install(args.positional[0] ?? 'all', args.flags.has('--project'), store.root, CLI, !args.flags.has('--no-mcp')));
      warmInBackground(store.root);
      return;
    case 'uninstall':
      output(uninstall(args.positional[0] ?? 'all', args.flags.has('--project'), store.root));
      return;
    case 'list': {
      const turns = store.turns().map(t => store.summarize(t));
      output(args.flags.has('--json') ? turns : formatTurns(turns));
      return;
    }
    case 'status':
      output(store.status());
      return;
    case 'gc':
      output(store.gc());
      return;
    case 'steps': {
      const id = args.positional[0];
      if (!id) throw new Error('Missing turn id');
      const steps = store.steps(id);
      output(args.flags.has('--json') ? steps : formatSteps(steps));
      return;
    }
    case 'log': {
      const target = args.positional[0];
      if (!target) throw new Error('Missing file or folder');
      const history = store.fileHistory(path.resolve(target));
      output(args.flags.has('--json') ? history : history.length ? formatTurns(history) : `No recorded turn changed ${target}.`);
      return;
    }
    case 'mark': {
      const mark = store.mark(args.positional.join(' '));
      output(`Marked ${JSON.stringify(mark.label)} (${mark.ref}). Restore it with: turnback restore ${shellArg(mark.label)} --dry-run`);
      return;
    }
    case 'marks': {
      const marks = store.marks();
      output(args.flags.has('--json') ? marks : formatMarks(marks));
      return;
    }
    case 'ui': {
      const { startUi } = await import('../ui/server.js');
      const ui = await startUi(store, Number(args.values.get('--port') ?? 0));
      output(`Turnback UI: ${ui.url}\nRead-only. Press Ctrl+C to stop.`);
      if (!args.flags.has('--no-open')) openBrowser(ui.url);
      return;
    }
    case 'export': {
      const ids = args.positional;
      if (args.flags.has('--commit')) {
        const result = exportCommit(store, ids, args.values.get('--message'));
        const skipped = result.ignored.length ? ` Skipped ignored: ${result.ignored.join(', ')}.` : '';
        output(`Committed ${result.paths.length} files as ${result.commit.slice(0, 12)}.${skipped}`);
        return;
      }
      const patch = exportPatch(store, ids);
      const out = args.values.get('--out');
      if (out) {
        writeFileSync(path.resolve(out), patch);
        output(`Wrote ${out}. Apply it with: git apply ${shellArg(out) ?? out}`);
      } else process.stdout.write(patch);
      return;
    }
    case 'compare': {
      const [a, b] = args.positional;
      if (!a || !b) throw new Error('Usage: turnback compare <turnA> <turnB>');
      const c = compareTurns(store, a, b);
      if (args.flags.has('--json')) return output(c);
      output([
        `A: ${c.a}`, `B: ${c.b}`,
        `Only A: ${c.onlyA.join(', ') || '-'}`, `Only B: ${c.onlyB.join(', ') || '-'}`,
        `Both, different: ${c.both.join(', ') || '-'}`, `Both, same: ${c.same.join(', ') || '-'}`,
        '', c.patch,
      ].join('\n'));
      return;
    }
    case 'report':
      output(sessionReport(store, args.values.get('--session')));
      return;
    case 'diff': {
      const id = args.positional[0];
      if (!id) throw new Error('Missing turn id');
      output(store.turnDiff(id, true).diff);
      return;
    }
    case 'restore':
    case 'undo':
    case 'redo':
      runRestore(store, command, args);
      return;
    default:
      output(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 2;
  }
}

function warmInBackground(cwd: string): void {
  spawn(process.execPath, [CLI, 'warm'], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Open a URL in the default browser; if that fails, the user opens the printed URL by hand. */
function openBrowser(url: string): void {
  const [command, argv, verbatim] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url], true]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], false];
  spawn(command, argv, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim }).on('error', () => {}).unref();
}

function logHookError(error: unknown): void {
  try {
    const dir = path.join(dataHome(), 'logs');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    appendFileSync(path.join(dir, `${now.slice(0, 10)}.log`), `${now} ${String(error)}\n`);
  } catch { /* hooks stay fail-open */ }
}

main().catch(e => {
  process.stderr.write(String(e instanceof Error ? e.message : e) + '\n');
  process.exitCode = 2;
});
