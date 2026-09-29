import type { TurnSummary } from './store.js';
import type { Mark, Step } from './types.js';

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

/** Steps of one turn: number, local time, kind, then the command or edited paths. */
export function formatSteps(steps: Step[]): string {
  if (!steps.length) return 'No edit or shell steps in this turn.';
  return steps.map(s => {
    const detail = s.kind === 'shell' ? s.command ?? '' : (s.paths ?? []).join(', ');
    const missing = s.ref ? '' : `  (no snapshot: ${s.status})`;
    return `${s.n}. ${localTime(s.time).slice(11)}  ${s.kind.padEnd(5)}  ${detail}${missing}`;
  }).join('\n');
}

/** Marks, newest first: number, local time, label, then ref. */
export function formatMarks(marks: Mark[]): string {
  if (!marks.length) return 'No marks yet. Create one with `turnback mark <label>`.';
  return marks.map((m, i) => `#${i + 1} ${localTime(m.time)}  ${JSON.stringify(m.label)}\n   ${m.ref}`).join('\n');
}
