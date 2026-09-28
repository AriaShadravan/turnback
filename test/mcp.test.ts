import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { record } from '../src/core.js';

it('serves read tools and two-step restore over SDK stdio', async () => {
  const root = mkdtempSync(path.join(tmpdir(),'turnback-mcp-'));
  process.env.TURNBACK_HOME = mkdtempSync(path.join(tmpdir(),'turnback-mcp-data-'));
  spawnSync('git',['init',root]); writeFileSync(path.join(root,'a.txt'),'old');
  record({ agent:'codex',session:'s',turn:'t',cwd:root,kind:'edit',paths:['a.txt'] });
  writeFileSync(path.join(root,'a.txt'),'new');
  record({ agent:'codex',session:'s',turn:'t',cwd:root,kind:'turn-end' });
  const client = new Client({ name:'test', version:'1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'),'mcp'], env: { ...process.env, TURNBACK_HOME: process.env.TURNBACK_HOME } });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name).sort()).toEqual(['diff_turn','list_turns','redo','restore','status']);
    expect(listed.tools.find(t => t.name === 'restore')?.annotations?.destructiveHint).toBe(true);
    const preview = await client.callTool({ name:'restore', arguments:{target:'t',workspace:root} });
    const token = (preview.structuredContent as any).confirm_token;
    expect(token).toBeTypeOf('string');
    const result = await client.callTool({ name:'restore', arguments:{target:'t',workspace:root,token} });
    expect((result.structuredContent as any).applied).toContain('a.txt');
    expect(readFileSync(path.join(root,'a.txt'),'utf8')).toBe('old');
    const stalePreview = await client.callTool({ name:'redo', arguments:{workspace:root} });
    writeFileSync(path.join(root,'a.txt'),'manual');
    const stale = await client.callTool({ name:'redo', arguments:{workspace:root,token:(stalePreview.structuredContent as any).confirm_token} });
    expect(stale.isError).toBe(true);
    const redoPreview = await client.callTool({ name:'redo', arguments:{workspace:root} });
    const cautious = await client.callTool({ name:'redo', arguments:{workspace:root,token:(redoPreview.structuredContent as any).confirm_token} });
    expect((cautious.structuredContent as any).skipped).toContain('a.txt');
    expect(readFileSync(path.join(root,'a.txt'),'utf8')).toBe('manual');
  } finally { await client.close(); }
}, 15000);

it('uses inputRequired for a modern client that approves manual edits', async () => {
  const root = mkdtempSync(path.join(tmpdir(),'turnback-mcp-'));
  process.env.TURNBACK_HOME = mkdtempSync(path.join(tmpdir(),'turnback-mcp-data-'));
  spawnSync('git',['init',root]); writeFileSync(path.join(root,'a.txt'),'old');
  record({agent:'codex',session:'s',turn:'t',cwd:root,kind:'edit',paths:['a.txt']});
  writeFileSync(path.join(root,'a.txt'),'agent'); record({agent:'codex',session:'s',turn:'t',cwd:root,kind:'turn-end'});
  writeFileSync(path.join(root,'a.txt'),'manual');
  const client = new Client({name:'modern-test',version:'1.0.0'}, {capabilities:{elicitation:{form:{}}},versionNegotiation:{mode:{pin:'2026-07-28'}}});
  client.setRequestHandler('elicitation/create', async () => ({action:'accept',content:{approve:true}}));
  const transport = new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/cli.js'),'mcp'],env:{...process.env,TURNBACK_HOME:process.env.TURNBACK_HOME}});
  await client.connect(transport);
  try {
    const preview = await client.callTool({name:'restore',arguments:{target:'t',workspace:root}});
    const result = await client.callTool({name:'restore',arguments:{target:'t',workspace:root,token:(preview.structuredContent as any).confirm_token}});
    expect((result.structuredContent as any).applied).toContain('a.txt');
    expect(readFileSync(path.join(root,'a.txt'),'utf8')).toBe('old');
  } finally { await client.close(); }
}, 15000);
