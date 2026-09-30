import { formatTime } from './format.js';
import type { Store } from './store.js';

const STATUS = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed' } as const;

/** Session part of a turn ID (`agent:session:turn`). */
export const sessionOf = (turnId: string) => turnId.split(':').slice(1, -1).join(':');

const code = (text: string) => '`' + text.replaceAll('`', "'") + '`';

/** Markdown report of one session's turns, oldest first: prompt, commands, and changed files. */
export function sessionReport(store: Store, session?: string): string {
  const all = store.turns();
  if (!all.length && !session) return 'No turns recorded yet.';
  const id = session ?? sessionOf(all[0].id);
  const turns = all.filter(t => sessionOf(t.id) === id).reverse();
  if (!turns.length) throw new Error(`No turns in session ${id}`);

  const lines = [
    `# Turnback report · ${store.root}`,
    '',
    `Session ${code(id)} · ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'} · ${formatTime(turns[0].time)} to ${formatTime(turns.at(-1)!.time)}`,
  ];
  turns.forEach((turn, i) => {
    const summary = store.summarize(turn);
    const changes = turn.end ? store.repo.diffNameStatus(turn.baseline, turn.end) : [];
    const commands = store.steps(turn.id).flatMap(s => s.command ? [s.command] : []);
    lines.push('', `## ${i + 1}. ${summary.prompt ?? '(no prompt)'}`, '');
    lines.push(`- ${summary.agent} · ${formatTime(turn.time)} · ${changes.length} ${changes.length === 1 ? 'file' : 'files'}${turn.status === 'ok' ? '' : ' · partial'}`);
    lines.push(`- Turn: ${code(turn.id)}`);
    if (commands.length) lines.push(`- Commands: ${commands.map(code).join(', ')}`);
    if (changes.length) lines.push(`- Files: ${changes.map(c => `${code(c.path)} (${STATUS[c.status]})`).join(', ')}`);
  });
  return lines.join('\n') + '\n';
}
