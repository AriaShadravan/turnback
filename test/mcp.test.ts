import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { beforeEach, expect, it } from 'vitest';
import { CLI, hook, tempProject } from './helpers.js';

let p: ReturnType<typeof tempProject>;

/** One Codex turn that changes a.txt from "old" to "agent". */
beforeEach(() => {
  p = tempProject('turnback-mcp-');
  p.write('a.txt', 'old');
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'agent');
  hook(p.root, 'turn-end', 't');
});

async function connect(client: Client) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, TURNBACK_HOME: p.home } });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: { workspace: p.root, ...args } });
  return { ...result, data: result.structuredContent as any };
}

it('serves read tools and a two-step restore', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['diff_turn', 'list_turns', 'redo', 'restore', 'status']);
    expect(tools.find(t => t.name === 'restore')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find(t => t.name === 'list_turns')?.annotations?.readOnlyHint).toBe(true);
    expect((await call(client, 'list_turns', {})).data.turns[0].changedFiles).toBe(1);

    const preview = await call(client, 'restore', { target: 't' });
    expect(preview.data.confirm_token).toBeTypeOf('string');
    expect(p.read('a.txt')).toBe('agent');

    const restored = await call(client, 'restore', { target: 't', token: preview.data.confirm_token });
    expect(restored.data.applied).toContain('a.txt');
    expect(p.read('a.txt')).toBe('old');
  } finally {
    await client.close();
  }
}, 15_000);

it('rejects a stale token and skips manual edits without elicitation', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const first = await call(client, 'restore', { target: 't' });
    await call(client, 'restore', { target: 't', token: first.data.confirm_token });

    const stalePreview = await call(client, 'redo', {});
    p.write('a.txt', 'manual');
    expect((await call(client, 'redo', { token: stalePreview.data.confirm_token })).isError).toBe(true);

    const preview = await call(client, 'redo', {});
    const cautious = await call(client, 'redo', { token: preview.data.confirm_token });
    expect(cautious.data.skipped).toContain('a.txt');
    expect(p.read('a.txt')).toBe('manual');
  } finally {
    await client.close();
  }
}, 15_000);

it('skips manual edits once when a modern client declines approval', async () => {
  p.write('a.txt', 'manual');
  const client = new Client({ name: 'modern-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  let asked = 0;
  client.setRequestHandler('elicitation/create', async () => { asked++; return { action: 'decline' }; });
  await connect(client);
  try {
    const preview = await call(client, 'restore', { target: 't' });
    const result = await call(client, 'restore', { target: 't', token: preview.data.confirm_token });
    expect(result.isError).toBeFalsy();
    expect(result.data.skipped).toContain('a.txt');
    expect(asked).toBe(1);
    expect(p.read('a.txt')).toBe('manual');
  } finally {
    await client.close();
  }
}, 15_000);

it('asks a modern client to approve overwriting manual edits', async () => {
  p.write('a.txt', 'manual');
  const client = new Client({ name: 'modern-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: {} }));
  await connect(client);
  try {
    const preview = await call(client, 'restore', { target: 't' });
    const result = await call(client, 'restore', { target: 't', token: preview.data.confirm_token });
    expect(result.data.applied).toContain('a.txt');
    expect(p.read('a.txt')).toBe('old');
  } finally {
    await client.close();
  }
}, 15_000);

it('uses TURNBACK_WORKSPACE when no workspace is given, ignoring unexpanded values', async () => {
  const run = async (value: string) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [CLI, 'mcp'], cwd: p.home,
      env: { ...process.env, TURNBACK_HOME: p.home, TURNBACK_WORKSPACE: value },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'list_turns', arguments: {} });
      return (result.structuredContent as any).turns.length;
    } finally {
      await client.close();
    }
  };
  expect(await run(p.root)).toBe(1);
  expect(await run('${CLAUDE_PROJECT_DIR}')).toBe(0);
}, 30_000);
