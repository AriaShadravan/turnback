import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { VERSION } from './config.js';
import { applyRestore, planRestore, redoTarget } from './restore.js';
import { Store } from './store.js';

const MAX_DIFF_CHARS = 40_000;
const SUMMARY_CHARS = 4_000;

const result = (value: object, summary: string) => ({
  content: [{ type: 'text' as const, text: summary }],
  structuredContent: value as Record<string, unknown>,
});
const failure = (e: unknown) => ({
  content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});
const storeFor = (workspace?: string) => new Store(workspace || process.cwd());

const workspaceParam = z.string().optional().describe('Workspace folder; defaults to the server working directory');

export function createServer(): McpServer {
  const server = new McpServer({ name: 'turnback', version: VERSION });

  server.registerTool('list_turns', {
    description: 'List recorded agent turns, newest first',
    inputSchema: z.object({ workspace: workspaceParam, limit: z.number().int().min(1).max(100).default(20) }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, limit }) => {
    try {
      const store = storeFor(workspace);
      const turns = store.turns().slice(0, limit).map(t => store.summarize(t));
      return result({ turns }, `${turns.length} turns`);
    } catch (e) { return failure(e); }
  });

  server.registerTool('diff_turn', {
    description: 'Show changes made during a turn',
    inputSchema: z.object({ turn: z.string(), workspace: workspaceParam, patch: z.boolean().default(false) }),
    annotations: { readOnlyHint: true },
  }, async ({ turn, workspace, patch }) => {
    try {
      const { turn: id, diff } = storeFor(workspace).turnDiff(turn, patch);
      return result({ turn: id, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS }, diff.slice(0, SUMMARY_CHARS));
    } catch (e) { return failure(e); }
  });

  server.registerTool('status', {
    description: 'Show Turnback storage and protection status',
    inputSchema: z.object({ workspace: workspaceParam }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace }) => {
    try {
      const status = storeFor(workspace).status();
      return result(status, `${status.turns} turns; mode ${status.mode}; ${status.failures.length} recent skipped or failed snapshots`);
    } catch (e) { return failure(e); }
  });

  registerRestoreTool(server, 'restore', 'Preview or restore workspace files to a turn baseline. Call once for a plan, then again with confirm_token as token.');
  registerRestoreTool(server, 'redo', 'Preview or undo the last restore. Call once for a plan, then again with confirm_token as token.');
  return server;
}

/**
 * Restore lewat MCP selalu dua langkah: panggilan tanpa token hanya mengembalikan rencana.
 * File yang mungkin diedit manual hanya ditimpa kalau pengguna menyetujuinya lewat elicitation.
 */
function registerRestoreTool(server: McpServer, name: 'restore' | 'redo', description: string): void {
  server.registerTool(name, {
    description,
    inputSchema: z.object({
      target: z.string().optional().describe('Turn id or snapshot ref (restore only)'),
      paths: z.array(z.string()).optional(),
      token: z.string().optional(),
      workspace: workspaceParam,
    }),
    annotations: { destructiveHint: true },
  }, async ({ target, paths, token, workspace }, ctx) => {
    try {
      const store = storeFor(workspace);
      if (name === 'redo') target = redoTarget(store);
      if (!target) throw new Error(name === 'redo' ? 'No restore to redo' : 'target is required');

      const plan = planRestore(store, target, paths);
      if (!token) {
        return result({ ...plan, confirm_token: plan.token }, `${plan.actions.length} file changes. Call ${name} again with confirm_token as token.`);
      }
      if (token !== plan.token) throw new Error('Stale or invalid confirmation token');

      const uncertain = plan.actions.filter(a => a.uncertain);
      const approval = acceptedContent(ctx.mcpReq.inputResponses, 'approve', z.object({ approve: z.boolean() }));
      const capabilities = (ctx.mcpReq.envelope as Record<string, { elicitation?: unknown }> | undefined)?.[CLIENT_CAPABILITIES_META_KEY];
      if (uncertain.length && capabilities?.elicitation && approval === undefined) {
        return inputRequired({
          inputRequests: {
            approve: inputRequired.elicit({
              message: `Turnback will overwrite ${uncertain.length} file(s) that may contain manual edits: ${uncertain.map(a => a.path).join(', ')}. Approve?`,
              requestedSchema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'] },
            }),
          },
        });
      }

      const restored = applyRestore(store, target, { paths, token, skipUncertain: !approval?.approve, operation: name });
      const note = restored.skipped.length ? ' Suggest `turnback restore` from the CLI for skipped files.' : '';
      return result(restored, `${restored.applied.length} restored; ${restored.skipped.length} manual edits skipped; ${restored.failed.length} failed. Safety snapshot: ${restored.safety}.${note}`);
    } catch (e) { return failure(e); }
  });
}

export function serveMcp(): void {
  serveStdio(() => createServer(), { onerror: e => process.stderr.write(String(e) + '\n') });
}
