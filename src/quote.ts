/** Text that bash and PowerShell both read as one plain word, without quotes. */
export const BARE_SAFE = /^[A-Za-z0-9_.:\/@+,=-]+$/;

/**
 * Text that stays literal inside double quotes in bash and PowerShell: no `$`, backtick, quote,
 * backslash, or `!`. Mark labels must match it, since the UI and CLI print them in commands to paste.
 */
export const QUOTE_SAFE = /^[\p{L}\p{N} _.:\/@#+,=-]+$/u;

/** A shell argument that is safe to paste, or undefined when the text needs escaping we do not attempt. */
export function shellArg(text: string): string | undefined {
  if (BARE_SAFE.test(text)) return text;
  if (QUOTE_SAFE.test(text)) return `"${text}"`;
  return undefined;
}
