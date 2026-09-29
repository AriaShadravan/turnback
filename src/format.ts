import type { TurnSummary } from './store.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as `YYYY-MM-DD HH:MM`. */
function localTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Newest-first turn list for people: one header line per turn, then its ID. */
export function formatTurns(turns: TurnSummary[]): string {
  if (!turns.length) return 'No turns recorded yet.';
  return turns.map((t, i) => {
    const files = `${t.changedFiles} ${t.changedFiles === 1 ? 'file ' : 'files'}`;
    const partial = t.status === 'ok' ? '' : '[partial] ';
    const label = t.prompt ? JSON.stringify(t.prompt) : '(no prompt)';
    return `#${i + 1} ${localTime(t.time)}  ${t.agent.padEnd(11)} ${files.padStart(9)}  ${partial}${label}\n   ${t.id}`;
  }).join('\n');
}
