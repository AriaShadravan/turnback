#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataHome, record, Store } from './core.js';
import { hookResponse, parseHook } from './adapters.js';
import { install, uninstall } from './install.js';
import type { Agent } from './types.js';

const args = process.argv.slice(2), command = args.shift();
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
const has = (name: string) => args.includes(name);
const paths = () => args.flatMap((a,i) => a === '--path' && args[i+1] ? [args[i+1]] : []);
const target = () => args.find(a => !a.startsWith('-') && !args[args.indexOf(a)-1]?.startsWith('--'));
function output(x: unknown) { process.stdout.write(typeof x === 'string' ? x + '\n' : JSON.stringify(x,null,2) + '\n'); }
function logHookError(e: unknown) { try { mkdirSync(path.join(dataHome(),'logs'),{recursive:true}); appendFileSync(path.join(dataHome(),'logs',new Date().toISOString().slice(0,10)+'.log'),`${new Date().toISOString()} ${String(e)}\n`); } catch { /* fail open */ } }
async function main() {
  if (command === 'hook') {
    const agent = args[0] as Agent;
    let response = hookResponse(agent);
    try { let raw = ''; for await (const chunk of process.stdin) raw += chunk; const payload = JSON.parse(raw || '{}'); response = hookResponse(agent,payload.hook_event_name); const event = parseHook(agent,payload); if (event) { record(event); if (event.kind === 'session-start') backgroundWarm(event.cwd); } }
    catch(e) { logHookError(e); }
    process.stdout.write(response + '\n'); return;
  }
  if (command === 'mcp') { await import('./mcp.js').then(m => m.serveMcp()); return; }
  const s = new Store(process.cwd());
  if (command === 'warm') { s.warm(); return; }
  if (command === 'install' || command === 'uninstall') { const agent = args[0] || 'all', cli = fileURLToPath(import.meta.url); const files = command === 'install' ? install(agent,has('--project'),s.root,cli,!has('--no-mcp')) : uninstall(agent,has('--project'),s.root); if (command === 'install') backgroundWarm(s.root); output(files); return; }
  if (command === 'list') { output(s.turns().map(({ entries, ...t }) => ({...t, changedFiles:t.baseline && t.end ? s.changedFiles(t.baseline,t.end) : 0}))); return; }
  if (command === 'status') { output(s.status()); return; }
  if (command === 'gc') { output(s.gc()); return; }
  if (command === 'diff') { const t = s.turns().find(t => t.id === args[0] || t.id.endsWith(':' + args[0])); if (!t?.baseline || !t.end) throw new Error('Unknown or incomplete turn'); output(s.diff(t.baseline,t.end)); return; }
  if (['restore','undo','redo'].includes(command || '')) {
    let id: string | undefined = args[0];
    if (command === 'undo') id = s.undoTarget();
    if (command === 'redo') id = s.redoTarget();
    if (!id) throw new Error('No target available');
    const selected = paths(), plan = s.plan(id, selected.length ? selected : undefined);
    output({ target: id, actions: plan.actions });
    if (has('--dry-run')) return;
    if (!has('--yes')) { output('Use --yes to apply this plan.'); return; }
    const result = s.restore(id, selected.length ? selected : undefined, plan.token, false, command as 'restore' | 'undo' | 'redo'); output(result); if (result.failed.length) process.exitCode = 1; return;
  }
  output('Usage: turnback install|uninstall <claude|codex|gemini|cursor|all> [--project] [--no-mcp]; list; diff <turn>; status; gc; restore <turn> [--path p] [--dry-run|--yes]; undo|redo [--dry-run|--yes]; mcp');
}
function backgroundWarm(cwd: string) { const p = spawn(process.execPath,[fileURLToPath(import.meta.url),'warm'],{cwd, detached:true, stdio:'ignore', windowsHide:true, env:process.env}); p.unref(); }
main().catch(e => { process.stderr.write(String(e)+'\n'); process.exitCode = 2; });
