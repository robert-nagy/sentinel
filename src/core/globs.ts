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
  if (expandBraces(g).length > MAX_EXPANSIONS)
    return `"${glob}" expands to more than ${String(MAX_EXPANSIONS)} alternatives`;
  const wildcards = (collapse(g).match(/\*+|\?/g) ?? []).length;
  if (wildcards > MAX_WILDCARDS)
    return `"${glob}" has more than ${String(MAX_WILDCARDS)} wildcards`;
  return undefined;
}

/** Brace alternatives a glob may expand to; more is refused by {@link validateGlob}. */
export const MAX_EXPANSIONS = 32;
/** Paths longer than this never match: recall input is bounded too. */
const MAX_PATH_LENGTH = 1024;

/** Expands one level of `{a,b}` groups into plain globs, without duplicates. */
function expandBraces(glob: string): string[] {
  let results = [''];
  let i = 0;
  while (i < glob.length) {
    const open = glob.indexOf('{', i);
    if (open === -1) {
      results = results.map((r) => r + glob.slice(i));
      break;
    }
    const close = glob.indexOf('}', open);
    const prefix = glob.slice(i, open);
    const options = [...new Set(glob.slice(open + 1, close).split(','))];
    results = results.flatMap((r) => options.map((o) => r + prefix + o));
    if (results.length > MAX_EXPANSIONS) return results.slice(0, MAX_EXPANSIONS + 1);
    i = close + 1;
  }
  return [...new Set(results)];
}

/**
 * `*` and `?` within one path segment, matched with the classic two-pointer algorithm: at
 * most O(pattern × text) steps, never exponential, unlike a backtracking regular expression.
 */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** Segment lists with `**` (any number of segments), memoised: O(globs × path) segment steps. */
function matchSegments(glob: readonly string[], path: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const k = i * (path.length + 1) + j;
    const known = memo.get(k);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === glob.length) result = j === path.length;
    else if (glob[i] === '**') result = go(i + 1, j) || (j < path.length && go(i, j + 1));
    else
      result =
        j < path.length &&
        matchSegment((glob[i] ?? '').replace(/\*+/g, '*'), path[j] ?? '') &&
        go(i + 1, j + 1);
    memo.set(k, result);
    return result;
  };
  return go(0, 0);
}

export interface GlobMatcher {
  /** Whether a `/`-separated, repository-relative path matches. */
  test(path: string): boolean;
}

/** Compiles a valid glob to a matcher that runs in polynomial time, whatever the glob. */
export function compileGlob(glob: string): GlobMatcher {
  const alternatives = expandBraces(collapse(normalizePath(glob.trim()))).map((g) =>
    g.split('/').filter((part) => part !== ''),
  );
  return {
    test(path: string): boolean {
      const normalized = normalizePath(path);
      if (normalized.length > MAX_PATH_LENGTH) return false;
      const parts = normalized.split('/').filter((part) => part !== '');
      return alternatives.some((segments) => matchSegments(segments, parts));
    },
  };
}

/** Literal (non-wildcard) characters in a glob: a rough measure of how narrow it is. */
export function globSpecificity(glob: string): number {
  return normalizePath(glob).replace(/\*|\?|\{[^}]*\}/g, '').length;
}

/** The glob is the whole repository. */
export function isGlobalGlob(glob: string): boolean {
  return normalizePath(glob.trim()) === '**';
}
