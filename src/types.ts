export type Agent = 'claude' | 'codex' | 'gemini' | 'cursor';

/** Neutral event translated from each agent's hook payload. */
export type HookKind = 'session-start' | 'turn-start' | 'edit' | 'shell' | 'turn-end';

export interface HookEvent {
  agent: Agent;
  session: string;
  turn: string;
  cwd: string;
  kind: HookKind;
  /** Absolute paths the edit tool is about to change. */
  paths?: string[];
  /** Shell command, only recorded in the journal. */
  command?: string;
}

export type EntryKind =
  | HookKind
  | 'baseline'
  | 'warm'
  | 'pre-restore'
  | 'post-restore'
  | 'restore'
  | 'undo'
  | 'redo'
  | 'gc';

export type EntryStatus = 'ok' | 'skipped' | 'failed' | 'unprotected';

export interface Entry {
  id: string;
  time: string;
  agent: Agent | 'turnback';
  session: string;
  turn: string;
  kind: EntryKind;
  ref?: string;
  paths?: string[];
  command?: string;
  status: EntryStatus;
  note?: string;
}

export type NewEntry = Omit<Entry, 'id' | 'time'>;

/** Owner identity of a journal entry, plus the recorded event details. */
export type EntryOrigin = Pick<Entry, 'agent' | 'session' | 'turn'> & Partial<Pick<Entry, 'paths' | 'command'>>;

export type Mode = 'full' | 'edits-only';

export interface Turn {
  id: string;
  agent: Entry['agent'];
  time: string;
  baseline: string;
  end?: string;
  status: 'ok' | 'partial';
  entries: Entry[];
}
