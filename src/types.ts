export type Agent = 'claude' | 'codex' | 'gemini' | 'cursor';
export type Kind = 'session-start' | 'turn-start' | 'edit' | 'shell' | 'turn-end';
export interface HookEvent { agent: Agent; session: string; turn: string; cwd: string; kind: Kind; paths?: string[]; command?: string; }
export interface Entry { id: string; time: string; agent: Agent | 'turnback'; session: string; turn: string; kind: string; ref?: string; paths?: string[]; command?: string; status: 'ok' | 'skipped' | 'failed' | 'unprotected'; note?: string; }
