import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { Agent } from './types.js';

const agents: Agent[] = ['claude','codex','gemini','cursor'];
const marker = 'turnback:';
function json(file: string): any { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }
function save(file: string, value: any) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function hookCommand(agent: Agent, cli: string) { return `node "${cli.replaceAll('"','\\"')}" hook ${agent}`; }
function mcpConfig(cli: string) { return { command: 'node', args: [cli, 'mcp'] }; }
function configPath(agent: Agent, project: boolean, root: string): string {
  const home = homedir(); const base = project ? root : home;
  return path.join(base, `.${agent === 'claude' ? 'claude' : agent}`, agent === 'cursor' || agent === 'codex' ? 'hooks.json' : 'settings.json');
}
function mcpPath(agent: Agent, project: boolean, root: string): string {
  if (agent === 'codex') return path.join(project ? path.join(root,'.codex') : path.join(homedir(),'.codex'), 'config.toml');
  if (agent === 'claude') return project ? path.join(root,'.mcp.json') : path.join(homedir(),'.claude.json');
  if (agent === 'cursor') return path.join(project ? path.join(root,'.cursor') : path.join(homedir(),'.cursor'), 'mcp.json');
  return configPath(agent,project,root);
}
export function install(which: string, project: boolean, root: string, cli: string, withMcp = true): string[] {
  const version = spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout?.match(/(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 25) throw new Error('Git >= 2.25 is required');
  const selected = which === 'all' ? agents : agents.filter(a => a === which); if (!selected.length) throw new Error(`Unknown agent: ${which}`);
  const touched: string[] = [];
  for (const agent of selected) {
    const file = configPath(agent,project,root), cfg = json(file), hooks = cfg.hooks ||= {};
    const command = hookCommand(agent, cli);
    const events = agent === 'cursor' ? { sessionStart: '', beforeSubmitPrompt: '', preToolUse: 'Write|StrReplace|Delete', beforeShellExecution: '', stop: '' } :
      agent === 'gemini' ? { SessionStart: '', BeforeAgent: '', BeforeTool: 'write_file|replace|run_shell_command', AfterAgent: '' } :
      { SessionStart: '', UserPromptSubmit: '', PreToolUse: agent === 'codex' ? 'Bash|apply_patch|Edit|Write' : 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', Stop: '' };
    for (const [event, matcher] of Object.entries(events)) {
      const arr = Array.isArray(hooks[event]) ? hooks[event] : [];
      const clean = arr.map((group: any) => {
        if (agent === 'cursor') return group;
        const hs = Array.isArray(group.hooks) ? group.hooks.filter((h: any) => !String(h.name || h.command).includes(marker)) : [];
        return { ...group, hooks: hs };
      }).filter((group: any) => agent === 'cursor' ? !String(group.command).includes(marker) : group.hooks.length);
      const entry = agent === 'cursor' ? { command: command + ` # ${marker}${event}`, timeout: 30, ...(matcher ? { matcher } : {}) } :
        { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command + ` # ${marker}${event}`, name: `turnback:${event}`, timeout: agent === 'gemini' ? 30000 : 30 }] };
      hooks[event] = [...clean, entry];
    }
    if (agent === 'cursor') cfg.version = 1;
    if (agent === 'gemini' && withMcp) (cfg.mcpServers ||= {}).turnback = mcpConfig(cli);
    save(file,cfg); touched.push(file);
    if (withMcp && agent !== 'gemini') {
      const mfile = mcpPath(agent,project,root);
      if (agent === 'codex') {
        const old = existsSync(mfile) ? readFileSync(mfile,'utf8') : '';
        const start = '# turnback begin', end = '# turnback end';
        const clean = old.replace(/\n?# turnback begin[\s\S]*?# turnback end\n?/g,'\n');
        writeFileSync(mfile, clean.trimEnd() + `\n\n${start}\n[mcp_servers.turnback]\ncommand = "node"\nargs = [${JSON.stringify(cli)}, "mcp"]\n${end}\n`);
      } else { const m = json(mfile); (m.mcpServers ||= {}).turnback = mcpConfig(cli); save(mfile,m); }
      touched.push(mfile);
    }
  }
  return touched;
}
export function uninstall(which: string, project: boolean, root: string): string[] {
  const selected = which === 'all' ? agents : agents.filter(a => a === which); if (!selected.length) throw new Error(`Unknown agent: ${which}`);
  const touched: string[] = [];
  for (const agent of selected) {
    const file = configPath(agent,project,root);
    if (existsSync(file)) { const cfg = json(file); if (cfg.hooks) for (const [event, groups] of Object.entries(cfg.hooks)) if (Array.isArray(groups)) cfg.hooks[event] = groups.map((g: any) => agent === 'cursor' ? g : { ...g, hooks: Array.isArray(g.hooks) ? g.hooks.filter((h: any) => !String(h.name || h.command).includes(marker)) : [] }).filter((g: any) => agent === 'cursor' ? !String(g.command).includes(marker) : g.hooks.length); if (agent === 'gemini') delete cfg.mcpServers?.turnback; save(file,cfg); touched.push(file); }
    const mfile = mcpPath(agent,project,root);
    if (agent !== 'gemini' && existsSync(mfile)) { if (agent === 'codex') writeFileSync(mfile, readFileSync(mfile,'utf8').replace(/\n?# turnback begin[\s\S]*?# turnback end\n?/g,'\n')); else { const m = json(mfile); delete m.mcpServers?.turnback; save(mfile,m); } touched.push(mfile); }
  }
  return touched;
}
