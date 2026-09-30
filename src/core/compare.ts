import type { Store } from './store.js';

export interface Comparison {
  a: string;
  b: string;
  /** Changed only by turn A or only by turn B. */
  onlyA: string[];
  onlyB: string[];
  /** Changed by both turns, with different results. */
  both: string[];
  /** Changed by both turns, with identical results. */
  same: string[];
  /** Diff from A's result to B's result on the changed paths. */
  patch: string;
}

/** Compare the results of two turns, for example two agents given the same task. */
export function compareTurns(store: Store, a: string, b: string): Comparison {
  const [ta, tb] = [a, b].map(id => {
    const turn = store.findTurn(id);
    if (!turn?.end) throw new Error(`Unknown or incomplete turn: ${id}`);
    return turn;
  });
  const namesA = new Set(store.repo.diffNames(ta.baseline, ta.end!));
  const namesB = new Set(store.repo.diffNames(tb.baseline, tb.end!));
  const differ = new Set(store.repo.diffNames(ta.end!, tb.end!));
  const inBoth = [...namesA].filter(p => namesB.has(p)).sort();
  const paths = [...new Set([...namesA, ...namesB])].sort();
  return {
    a: ta.id,
    b: tb.id,
    onlyA: [...namesA].filter(p => !namesB.has(p)).sort(),
    onlyB: [...namesB].filter(p => !namesA.has(p)).sort(),
    both: inBoth.filter(p => differ.has(p)),
    same: inBoth.filter(p => !differ.has(p)),
    patch: store.repo.diffPatch(ta.end!, tb.end!, paths),
  };
}
