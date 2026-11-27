/**
 * A small glob dialect for lesson scopes (ADR-0008): `**` (any number of directories), `*` and
 * `?` (within one path segment) and `{a,b}` (alternatives, not nested). Paths and globs are
 * compared with `/` separators, so Windows paths work unchanged. Written here to avoid a
 * dependency for a few lines of code.
 */

export const MAX_GLOB_LENGTH = 200;
/** Wildcard groups per glob; more could make matching backtrack badly. */
export const MAX_WILDCARDS = 8;

/** Collapses runs that mean the same thing (`**\/**\/` → `**\/`, `***` → `**`). */
function collapse(glob: string): string {
  let g = glob;
  for (;;) {
    const next = g
      .replace(/\*{3,}/g, '**')
      .replace(/(?:\*\*\/){2,}/g, '**/')
      .replace(/\*\*\/\*\*(?=$|\/)/g, '**');
    if (next === g) return g;
    g = next;
  }
}

/** `\` → `/`, no leading `./`. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** Why a glob is not allowed, or `undefined` when it is fine. */
export function validateGlob(glob: string): string | undefined {
  const g = normalizePath(glob.trim());
  if (g === '') return 'a scope glob must not be empty';
  if (g.length > MAX_GLOB_LENGTH)
    return `a scope glob is too long (at most ${String(MAX_GLOB_LENGTH)} characters)`;
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g))
    return `"${glob}" must be relative to the repository root`;
  if (g.split('/').includes('..')) return `"${glob}" must not contain ".." segments`;
  if (/[[\]]/.test(g)) return `"${glob}": character classes ([…]) are not supported`;
  if (g.startsWith('!')) return `"${glob}": negation (!) is not supported`;
  let depth = 0;
  for (const ch of g) {
    if (ch === '{') {
      depth += 1;
      if (depth > 1) return `"${glob}": nested braces are not supported`;
    } else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return `"${glob}" has unbalanced braces`;
    }
  }
  if (depth !== 0) return `"${glob}" has unbalanced braces`;
  const wildcards = (collapse(g).match(/\*+|\?/g) ?? []).length;
  if (wildcards > MAX_WILDCARDS)
    return `"${glob}" has more than ${String(MAX_WILDCARDS)} wildcards`;
  return undefined;
}

const SPECIAL = /[.+^$()|\\]/;

/** Compiles a valid glob to an anchored regular expression over `/`-separated paths. */
export function compileGlob(glob: string): RegExp {
  const g = collapse(normalizePath(glob.trim()));
  let out = '';
  let i = 0;
  while (i < g.length) {
    const ch = g[i] ?? '';
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/';
        const slashAfter = g[i + 2] === '/';
        if (atStart && slashAfter) {
          out += '(?:[^/]*/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const end = g.indexOf('}', i);
      const options = g.slice(i + 1, end).split(',');
      out += `(?:${options.map((o) => o.replace(/[.+^$()|\\*?]/g, (c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : `\\${c}`))).join('|')})`;
      i = end + 1;
    } else {
      out += SPECIAL.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Literal (non-wildcard) characters in a glob: a rough measure of how narrow it is. */
export function globSpecificity(glob: string): number {
  return normalizePath(glob).replace(/\*|\?|\{[^}]*\}/g, '').length;
}

/** The glob is the whole repository. */
export function isGlobalGlob(glob: string): boolean {
  return normalizePath(glob.trim()) === '**';
}
