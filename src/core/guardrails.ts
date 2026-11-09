/** The rules every sentinel run must follow. Single source for AGENTS.md and the Cursor rule. */
export const GUARDRAIL_RULES: readonly string[] = [
  'Never commit or push to the default branch; work on a branch named by `sentinel branch name`.',
  'Never force-push.',
  'Never merge a pull request; a human merges.',
  'During an SDLC run, never edit files outside the issue worktree.',
  'Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.',
  'Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).',
];

export const BLOCK_START_PREFIX = '<!-- sentinel:managed';
export const BLOCK_END = '<!-- /sentinel:managed -->';
export const CLAUDE_POINTER = '@AGENTS.md';

export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailError';
  }
}

/** The managed block, with `\n` line endings. */
export function renderGuardrailBlock(version: string): string {
  return [
    `${BLOCK_START_PREFIX} v${version} -->`,
    '## Sentinel guardrails',
    '',
    'Managed by `sentinel guardrails write`; edits inside this block are overwritten.',
    '',
    ...GUARDRAIL_RULES.map((rule) => `- ${rule}`),
    BLOCK_END,
  ].join('\n');
}

function withEol(text: string, eol: string): string {
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/**
 * Inserts or replaces the managed block in an AGENTS.md. Text outside the block is left
 * alone. Throws when the markers are unbalanced, rather than guessing what to overwrite.
 */
export function applyGuardrailBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim() === '') return `${block}\n`;

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const start = existing.indexOf(BLOCK_START_PREFIX);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 && end === -1) {
    return `${existing.trimEnd()}${eol}${eol}${withEol(block, eol)}${eol}`;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new GuardrailError(
      'AGENTS.md has an unbalanced sentinel:managed block; fix or remove the markers and run again',
    );
  }
  return existing.slice(0, start) + withEol(block, eol) + existing.slice(end + BLOCK_END.length);
}

/** Adds the `@AGENTS.md` import to a CLAUDE.md unless it is already there. */
export function applyClaudePointer(existing: string): string {
  if (existing.split(/\r?\n/).some((line) => line.trim() === CLAUDE_POINTER)) return existing;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const body = existing.trimEnd();
  return body === '' ? `${CLAUDE_POINTER}${eol}` : `${body}${eol}${eol}${CLAUDE_POINTER}${eol}`;
}
