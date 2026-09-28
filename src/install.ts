import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Agent } from './types.js';

const AGENTS: Agent[] = ['claude', 'codex', 'gemini', 'cursor'];
/** Marks entries owned by Turnback, so reinstall and uninstall never touch other entries. */
const MARKER = 'turnback:';
const TOML_BLOCK = /\n?# turnback begin[\s\S]*?# turnback end\n?/g;

interface AgentSpec {
  /** Config folder, in home (user level) or the project root. */
  dir: string;
  hooksFile: string;
  /** Hook event → tool matcher (empty = all). */
  events: Record<string, string>;
  /** Timeout units differ: Gemini uses milliseconds, the others seconds. */
  timeout: number;
  /** Cursor stores hooks as a flat `{ command }` list, not `{ hooks: [...] }` groups. */
  flat: boolean;
  /** Where the MCP server is registered; `inline` = in the same hook file. */
  mcp: 'inline' | { file: (base: string, project: boolean) => string; format: 'json' | 'toml' };
}

const SPECS: Record<Agent, AgentSpec> = {
  claude: {
    dir: '.claude',
    hooksFile: 'settings.json',
    events: { SessionStart: '', UserPromptSubmit: '', PreToolUse: 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', Stop: '' },
    timeout: 30,
    flat: false,
    mcp: { file: (base, project) => path.join(base, project ? '.mcp.json' : '.claude.json'), format: 'json' },
  },
  codex: {
    dir: '.codex',
    hooksFile: 'hooks.json',
    events: { SessionStart: '', UserPromptSubmit: '', PreToolUse: 'Bash|apply_patch|Edit|Write', Stop: '' },
    timeout: 30,
    flat: false,
    mcp: { file: base => path.join(base, '.codex', 'config.toml'), format: 'toml' },
  },
  gemini: {
    dir: '.gemini',
    hooksFile: 'settings.json',
    events: { SessionStart: '', BeforeAgent: '', BeforeTool: 'write_file|replace|run_shell_command', AfterAgent: '' },
    timeout: 30_000,
    flat: false,
    mcp: 'inline',
  },
  cursor: {
    dir: '.cursor',
    hooksFile: 'hooks.json',
    events: { sessionStart: '', beforeSubmitPrompt: '', preToolUse: 'Write|StrReplace|Delete', beforeShellExecution: '', stop: '' },
    timeout: 30,
    flat: true,
    mcp: { file: base => path.join(base, '.cursor', 'mcp.json'), format: 'json' },
  },
};

/** Install hooks and the MCP server. Other config is kept; calling again does not duplicate entries. */
export function install(which: string, project: boolean, root: string, cli: string, withMcp = true): string[] {
  requireGit();
  const touched: string[] = [];
  for (const agent of selectAgents(which)) {
    const spec = SPECS[agent];
    const base = project ? root : homedir();
    const file = path.join(base, spec.dir, spec.hooksFile);
    const config = readJson(file);
    const hooks = config.hooks ??= {};
    for (const [event, matcher] of Object.entries(spec.events)) {
      hooks[event] = [...withoutTurnback(spec, hooks[event]), hookEntry(agent, spec, event, matcher, cli)];
    }
    if (spec.flat) config.version = 1;
    if (withMcp && spec.mcp === 'inline') (config.mcpServers ??= {}).turnback = mcpServer(cli);
    writeJson(file, config);
    touched.push(file);

    if (withMcp && spec.mcp !== 'inline') {
      const mcpFile = spec.mcp.file(base, project);
      if (spec.mcp.format === 'toml') writeToml(mcpFile, cli);
      else updateJson(mcpFile, m => { (m.mcpServers ??= {}).turnback = mcpServer(cli); });
      touched.push(mcpFile);
    }
  }
  return touched;
}

/** Remove only entries owned by Turnback. */
export function uninstall(which: string, project: boolean, root: string): string[] {
  const touched: string[] = [];
  for (const agent of selectAgents(which)) {
    const spec = SPECS[agent];
    const base = project ? root : homedir();
    const file = path.join(base, spec.dir, spec.hooksFile);
    if (existsSync(file)) {
      updateJson(file, config => {
        for (const event of Object.keys(config.hooks ?? {})) config.hooks[event] = withoutTurnback(spec, config.hooks[event]);
        if (spec.mcp === 'inline') delete config.mcpServers?.turnback;
      });
      touched.push(file);
    }
    if (spec.mcp === 'inline') continue;
    const mcpFile = spec.mcp.file(base, project);
    if (!existsSync(mcpFile)) continue;
    if (spec.mcp.format === 'toml') writeFileSync(mcpFile, readFileSync(mcpFile, 'utf8').replace(TOML_BLOCK, '\n'));
    else updateJson(mcpFile, m => { delete m.mcpServers?.turnback; });
    touched.push(mcpFile);
  }
  return touched;
}

function requireGit(): void {
  const match = spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout?.match(/(\d+)\.(\d+)/);
  const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (major < 2 || (major === 2 && minor < 25)) throw new Error('Git >= 2.25 is required');
}

function selectAgents(which: string): Agent[] {
  const selected = which === 'all' ? AGENTS : AGENTS.filter(a => a === which);
  if (!selected.length) throw new Error(`Unknown agent: ${which}`);
  return selected;
}

function hookEntry(agent: Agent, spec: AgentSpec, event: string, matcher: string, cli: string) {
  const command = `node "${cli.replaceAll('"', '\\"')}" hook ${agent} # ${MARKER}${event}`;
  const match = matcher ? { matcher } : {};
  if (spec.flat) return { command, timeout: spec.timeout, ...match };
  return { ...match, hooks: [{ type: 'command', command, name: `${MARKER}${event}`, timeout: spec.timeout }] };
}

const isTurnback = (hook: any) => String(hook?.name || hook?.command).includes(MARKER);

/** Drop Turnback entries from one event's hook list; groups left empty are dropped too. */
function withoutTurnback(spec: AgentSpec, groups: unknown): any[] {
  if (!Array.isArray(groups)) return [];
  if (spec.flat) return groups.filter(g => !isTurnback(g));
  return groups
    .map(g => ({ ...g, hooks: Array.isArray(g?.hooks) ? g.hooks.filter((h: any) => !isTurnback(h)) : [] }))
    .filter(g => g.hooks.length);
}

const mcpServer = (cli: string) => ({ command: 'node', args: [cli, 'mcp'] });

function writeToml(file: string, cli: string): void {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // Codex starts MCP servers with a minimal environment; TURNBACK_HOME must be forwarded explicitly.
  const block = `# turnback begin\n[mcp_servers.turnback]\ncommand = "node"\nargs = [${JSON.stringify(cli)}, "mcp"]\nenv_vars = ["TURNBACK_HOME"]\n# turnback end\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${old.replace(TOML_BLOCK, '\n').trimEnd()}\n\n${block}`);
}

/** An existing file that cannot be parsed as JSON is never overwritten, so user config is not lost. */
function readJson(file: string): any {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cannot parse ${file} as JSON; fix it or add the Turnback entries manually`);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function updateJson(file: string, change: (value: any) => void): void {
  const value = readJson(file);
  change(value);
  writeJson(file, value);
}
