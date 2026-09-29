export type Agent = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'antigravity';

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
  /** User prompt, only on turn-start events. */
  prompt?: string;
}

export type EntryKind =
  | HookKind
  | 'baseline'
  | 'warm'
  | 'repair'
  | 'pre-restore'
  | 'post-restore'
  | 'restore'
  | 'undo'
  | 'redo'
  | 'gc'
  | 'mark';

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
  /** One-line prompt label, only on turn-start entries. */
  prompt?: string;
  status: EntryStatus;
  note?: string;
}

export type NewEntry = Omit<Entry, 'id' | 'time'>;

/** Owner identity of a journal entry, plus the recorded event details. */
export type EntryOrigin = Pick<Entry, 'agent' | 'session' | 'turn'> & Partial<Pick<Entry, 'paths' | 'command'>>;

/** A user checkpoint: a full snapshot under a label. */
export interface Mark {
  label: string;
  time: string;
  ref: string;
}

/** One mutating tool call inside a turn. */
export interface Step {
  /** 1-based position in the turn. */
  n: number;
  kind: 'edit' | 'shell';
  time: string;
  command?: string;
  /** Workspace-relative paths the edit tool touched. */
  paths?: string[];
  /** Snapshot taken just before this step; missing when it failed, was skipped, or is unprotected. */
  ref?: string;
  status: EntryStatus;
}

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
