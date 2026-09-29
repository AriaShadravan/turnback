import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { tempProject } from './helpers.js';

/** A copy of dist/ alone, as the Claude Code plugin receives it from npm without installing dependencies. */
function isolatedCli(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'turnback-bundle-'));
  cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return path.join(dir, 'dist', 'cli.js');
}

it('runs hooks and the MCP server from dist without node_modules', async () => {
  const cli = isolatedCli();
  const p = tempProject('turnback-bundle-proj-');
  p.write('a.txt', 'x');
  const env = { ...process.env, TURNBACK_HOME: p.home };
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: p.root });

  const hook = spawnSync(process.execPath, [cli, 'hook', 'claude'], { cwd: p.root, input: payload, encoding: 'utf8', env, windowsHide: true });
  expect(hook.stderr).toBe('');
  expect(hook.stdout.trim()).toBe('{}');

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toContain('list_turns');
  } finally {
    await client.close();
  }
}, 60_000);
