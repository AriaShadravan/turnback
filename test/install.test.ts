import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { install, uninstall } from '../src/install.js';

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
