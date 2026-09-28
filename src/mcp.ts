import { McpServer, inputRequired, acceptedContent, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { Store } from './core.js';

const envelope = (value: unknown, summary: string) => ({ content: [{ type: 'text' as const, text: summary }], structuredContent: value as Record<string, unknown> });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: String(e) }], isError: true });
const ws = (workspace?: string) => new Store(workspace || process.cwd());
export function createServer() {
  const server = new McpServer({ name: 'turnback', version: '0.1.0' });
  server.registerTool('list_turns', { description: 'List recorded agent turns', inputSchema: z.object({ workspace: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }), annotations: { readOnlyHint: true } }, async ({ workspace, limit }) => { try { const s=ws(workspace), turns = s.turns().slice(0,limit).map(({ entries, ...t }) => ({...t,changedFiles:t.baseline && t.end ? s.changedFiles(t.baseline,t.end) : 0})); return envelope({ turns }, `${turns.length} turns`); } catch(e) { return fail(e); } });
  server.registerTool('diff_turn', { description: 'Show changes made during a turn', inputSchema: z.object({ turn: z.string(), workspace: z.string().optional(), patch: z.boolean().default(false) }), annotations: { readOnlyHint: true } }, async ({ turn, workspace, patch }) => { try { const s = ws(workspace), t = s.turns().find(x => x.id === turn || x.id.endsWith(':' + turn)); if (!t?.baseline || !t.end) throw new Error('Turn has no complete snapshots'); const diff = patch ? s.diff(t.baseline,t.end) : s.statDiff(t.baseline,t.end); return envelope({ turn: t.id, diff: diff.slice(0,40000), truncated: diff.length > 40000 }, diff.slice(0,4000)); } catch(e) { return fail(e); } });
  server.registerTool('status', { description: 'Show Turnback storage and protection status', inputSchema: z.object({ workspace: z.string().optional() }), annotations: { readOnlyHint: true } }, async ({ workspace }) => { try { const status = ws(workspace).status(); return envelope(status, `${status.turns} turns; ${status.failures.length} recent skipped or failed snapshots`); } catch(e) { return fail(e); } });
  const actionSchema = z.object({ target: z.string().optional(), paths: z.array(z.string()).optional(), token: z.string().optional(), workspace: z.string().optional() });
  const act = (name: 'restore' | 'redo') => server.registerTool(name, { description: name === 'restore' ? 'Preview or restore workspace files to a turn baseline' : 'Preview or redo the last restore', inputSchema: actionSchema, annotations: { destructiveHint: true } }, async ({ target, paths, token, workspace }, ctx) => {
    try {
      const s = ws(workspace);
      if (name === 'redo') { target = s.redoTarget(); if (!target) throw new Error('No restore to redo'); }
      if (!target) throw new Error('target is required');
      const plan = s.plan(target, paths);
      if (!token) return envelope({ ...plan, confirm_token: plan.token }, `${plan.actions.length} file changes. Call ${name} again with confirm_token as token.`);
      if (token !== plan.token) throw new Error('Stale or invalid confirmation token');
      const uncertain = plan.actions.filter(a => a.uncertain);
      const approved = acceptedContent(ctx.mcpReq.inputResponses, 'approve', z.object({ approve: z.boolean() }));
      const caps = (ctx.mcpReq.envelope as Record<string, { elicitation?: unknown }> | undefined)?.[CLIENT_CAPABILITIES_META_KEY];
      if (uncertain.length && caps?.elicitation && approved === undefined) return inputRequired({ inputRequests: { approve: inputRequired.elicit({ message: `Turnback will overwrite ${uncertain.length} file(s) that may contain manual edits: ${uncertain.map(x => x.path).join(', ')}. Approve?`, requestedSchema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'] } }) } });
      const result = s.restore(target, paths, token, !approved?.approve, name);
      return envelope(result, `${result.applied.length} restored; ${result.skipped.length} manual edits skipped; ${result.failed.length} failed. Safety snapshot: ${result.safety}`);
    } catch(e) { return fail(e); }
  });
  act('restore'); act('redo'); return server;
}
export function serveMcp() { serveStdio(() => createServer(), { onerror: e => process.stderr.write(String(e) + '\n') }); }
