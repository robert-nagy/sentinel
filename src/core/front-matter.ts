/**
 * The small front-matter dialect sentinel writes: `key: value` lines between `---` markers,
 * with strings and arrays as JSON. Hand-edited files may use plain scalars, single quotes or
 * flow sequences such as `[a, b]`; those are read too. Used by the local tracker and the
 * lesson store (ADR-0005, ADR-0008).
 */

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      // Hand-edited flow sequence such as [a, b]: split it ourselves.
      if (value.startsWith('[') && value.endsWith(']')) {
        return value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter((s) => s !== '');
      }
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export interface FrontMatter {
  readonly fields: Map<string, unknown>;
  /** The Markdown after the closing `---`, with `\n` line endings. */
  readonly rest: string;
}

/** Splits a document into front-matter fields and the rest, or `undefined` if it has none. */
export function parseFrontMatter(text: string): FrontMatter | undefined {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return undefined;
  const fields = new Map<string, unknown>();
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (kv) fields.set(kv[1] ?? '', parseScalar(kv[2] ?? ''));
  }
  return { fields, rest: normalized.slice(match[0].length) };
}

/** Renders fields as front matter; strings and arrays as JSON, numbers as is, undefined skipped. */
export function renderFrontMatter(
  fields: readonly (readonly [string, string | number | readonly string[] | undefined])[],
): string {
  const lines = ['---'];
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    lines.push(`${key}: ${typeof value === 'number' ? String(value) : JSON.stringify(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}
