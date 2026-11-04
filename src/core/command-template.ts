/** Placeholders a custom-provider command template may use. */
export const TEMPLATE_PLACEHOLDERS = [
  'id',
  'title',
  'body',
  'labels',
  'url',
  'query',
  'state',
  'limit',
] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * Splits a command template into arguments. Understands single and double quotes and
 * whitespace; there is deliberately no shell expansion, escaping, piping or globbing.
 * Returns an error string for an unterminated quote.
 */
export function tokenizeTemplate(template: string): string[] | string {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (const char of template) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
    } else if (/\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (quote !== undefined) return `unterminated ${quote} quote in command template`;
  if (inToken) tokens.push(current);
  return tokens;
}

/** Returns a problem description, or `undefined` if the template is usable. */
export function validateCommandTemplate(template: string): string | undefined {
  const tokens = tokenizeTemplate(template);
  if (typeof tokens === 'string') return tokens;
  if (tokens.length === 0) return 'the command template is empty';
  const first = tokens[0] ?? '';
  if (first.includes('{')) return 'the executable name must not contain placeholders';
  for (const token of tokens) {
    for (const match of token.matchAll(PLACEHOLDER)) {
      const name = match[1] ?? '';
      if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) {
        return `unknown placeholder {${name}}; allowed: ${TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`;
      }
    }
  }
  return undefined;
}

/**
 * Tokenizes first and substitutes afterwards, so a value can never add or split
 * arguments, whatever it contains.
 */
export function renderCommand(
  template: string,
  values: Partial<Record<TemplatePlaceholder, string>>,
): { command: string; args: string[] } {
  const problem = validateCommandTemplate(template);
  if (problem !== undefined) throw new Error(problem);
  const tokens = tokenizeTemplate(template) as string[];
  const [command = '', ...rest] = tokens;
  const args = rest.map((token) =>
    token.replace(PLACEHOLDER, (_m, name: string) => values[name as TemplatePlaceholder] ?? ''),
  );
  return { command, args };
}
