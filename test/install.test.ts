import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { install, uninstall } from '../src/agents/install.js';

const AGENTS = ['claude', 'codex', 'gemini', 'cursor'];
const CLI_PATH = '/opt/turnback/dist/cli.js';
const STOP_EVENT: Record<string, string> = { claude: 'Stop', codex: 'Stop', gemini: 'AfterAgent', cursor: 'stop' };

let root: string;
const hooksFile = (agent: string) => path.join(root, `.${agent}`, agent === 'codex' || agent === 'cursor' ? 'hooks.json' : 'settings.json');
const readConfig = (agent: string) => JSON.parse(readFileSync(hooksFile(agent), 'utf8'));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'turnback-install-'));
  for (const agent of AGENTS) {
    mkdirSync(path.join(root, `.${agent}`));
    writeFileSync(hooksFile(agent), JSON.stringify({ custom: { keep: true }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
  }
});

it('installs project hooks idempotently and keeps unrelated settings', () => {
  const first = install('all', true, root, CLI_PATH);
  expect(install('all', true, root, CLI_PATH)).toEqual(first);
  for (const agent of AGENTS) {
    const config = readConfig(agent);
    expect(config.custom.keep).toBe(true);
    expect(config.hooks[STOP_EVENT[agent]].filter((g: unknown) => JSON.stringify(g).includes('turnback:'))).toHaveLength(1);
  }
  expect(readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.turnback\]/g)).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.turnback.args).toEqual([CLI_PATH, 'mcp']);
});

it('forwards TURNBACK_HOME to the Codex MCP server, which does not inherit the environment', () => {
  install('codex', true, root, CLI_PATH);
  expect(readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8')).toContain('env_vars = ["TURNBACK_HOME"]');
});

it('uninstall removes only Turnback entries', () => {
  install('all', true, root, CLI_PATH);
  uninstall('all', true, root);
  for (const agent of AGENTS) {
    const config = readConfig(agent);
    expect(config.custom.keep).toBe(true);
    expect(JSON.stringify(config)).not.toContain('turnback');
  }
  expect(readConfig('claude').hooks.Stop[0].hooks[0].command).toBe('other');
  expect(readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8')).not.toContain('turnback');
});

it('refuses to overwrite a config file it cannot parse', () => {
  writeFileSync(hooksFile('gemini'), '{ "hooks": { // comment\n } }');
  expect(() => install('gemini', true, root, CLI_PATH)).toThrow(/Cannot parse/);
  expect(readFileSync(hooksFile('gemini'), 'utf8')).toContain('// comment');
});

it('installs Antigravity hooks under a turnback key, with the event as an argument', () => {
  const file = path.join(root, '.agents', 'hooks.json');
  mkdirSync(path.dirname(file));
  writeFileSync(file, JSON.stringify({ other: { PreToolUse: [] } }));
  const touched = install('antigravity', true, root, CLI_PATH);
  expect(install('antigravity', true, root, CLI_PATH)).toEqual(touched);
  // Antigravity has no project-level MCP config, so only the hook file is written.
  expect(touched).toEqual([file]);

  const config = JSON.parse(readFileSync(file, 'utf8'));
  expect(config.other).toEqual({ PreToolUse: [] });
  expect(config.turnback.PreInvocation[0].command).toBe(`node ${CLI_PATH} hook antigravity PreInvocation`);
  expect(config.turnback.PreToolUse[0].matcher).toContain('write_to_file');
  expect(config.turnback.PreToolUse[0].hooks[0].command).toMatch(/hook antigravity PreToolUse$/);

  uninstall('antigravity', true, root);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ other: { PreToolUse: [] } });
});

it('installs the OpenCode plugin and MCP entry, and uninstall removes both', () => {
  writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { other: { type: 'local' } } }));
  const plugin = path.join(root, '.opencode', 'plugins', 'turnback.js');
  expect(install('opencode', true, root, CLI_PATH)).toEqual([plugin, path.join(root, 'opencode.json')]);
  expect(readFileSync(plugin, 'utf8')).toContain(JSON.stringify(CLI_PATH));
  const config = JSON.parse(readFileSync(path.join(root, 'opencode.json'), 'utf8'));
  expect(config.mcp.turnback).toEqual({ type: 'local', command: ['node', CLI_PATH, 'mcp'], enabled: true });

  uninstall('opencode', true, root);
  expect(existsSync(plugin)).toBe(false);
  expect(JSON.parse(readFileSync(path.join(root, 'opencode.json'), 'utf8')).mcp).toEqual({ other: { type: 'local' } });
});

it('prefers an existing opencode.jsonc', () => {
  writeFileSync(path.join(root, 'opencode.jsonc'), '{}');
  expect(install('opencode', true, root, CLI_PATH)).toContain(path.join(root, 'opencode.jsonc'));
  expect(existsSync(path.join(root, 'opencode.json'))).toBe(false);
});

it('skips Claude Code hooks when the Turnback plugin is enabled', () => {
  writeFileSync(hooksFile('claude'), JSON.stringify({ enabledPlugins: { 'turnback@turnback': true } }));
  const touched = install('claude', true, root, CLI_PATH);
  expect(touched).toEqual([expect.stringMatching(/^skipped claude: /)]);
  expect(readConfig('claude').hooks).toBeUndefined();
  expect(existsSync(path.join(root, '.mcp.json'))).toBe(false);
});

it('installs Claude Code hooks when the Turnback plugin is disabled', () => {
  writeFileSync(hooksFile('claude'), JSON.stringify({ enabledPlugins: { 'turnback@turnback': false } }));
  install('claude', true, root, CLI_PATH);
  expect(JSON.stringify(readConfig('claude').hooks)).toContain('turnback:');
});

it('skips Claude Code hooks when the plugin is enabled in local or project settings', () => {
  writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'turnback@turnback': true } }));
  expect(install('claude', true, root, CLI_PATH)).toEqual([expect.stringMatching(/^skipped claude: /)]);
  // A user-level install from this project also sees the project's plugin.
  expect(install('claude', false, root, CLI_PATH)).toEqual([expect.stringMatching(/^skipped claude: /)]);
});
