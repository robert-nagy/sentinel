import { AMBIGUOUS_TERMS } from './prd-validator.js';

/**
 * The issue contract (ADR-0007, docs/issue-format.md): one definition of the sections per
 * kind, used by `sentinel issue template`, `sentinel issue lint`, the attachments planner and
 * the GitHub issue forms that `sentinel setup --issue-forms` writes. Changing a heading here is
 * a breaking change for `sentinel-prd` and the forms.
 */

export class IssueFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueFormatError';
  }
}

export const ISSUE_KINDS = ['feature', 'bug'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export function parseIssueKind(raw: string): IssueKind {
  const kind = raw.trim().toLowerCase();
  if (!(ISSUE_KINDS as readonly string[]).includes(kind)) {
    throw new IssueFormatError(`unknown issue kind "${raw}": use feature or bug`);
  }
  return kind as IssueKind;
}

export interface IssueSection {
  /** Stable id: the GitHub issue form field id and the lint's name for the section. */
  readonly id: string;
  /** The `##` heading text. */
  readonly heading: string;
  readonly required: boolean;
  /** What goes in the section; shown in the template and the issue form. */
  readonly hint: string;
  /** An example, used as the issue form placeholder. */
  readonly example: string;
}

const ATTACHMENTS: IssueSection = {
  id: 'attachments',
  heading: 'Attachments',
  required: false,
  hint: 'One bullet per file: the file name, what it shows, and how it was attached (uploaded, inline, pending upload).',
  example: '- `checkout-error.png`: the total after applying `SPRING10` (uploaded)',
};

/** Sections per kind, in order. */
export const ISSUE_SECTIONS: Readonly<Record<IssueKind, readonly IssueSection[]>> = {
  feature: [
    {
      id: 'problem',
      heading: 'Problem',
      required: true,
      hint: 'Who is affected, what they cannot do today, and what it costs them.',
      example:
        'Accountants export invoices by copying rows into a spreadsheet, about 40 minutes at each month-end close, and rows get missed.',
    },
    {
      id: 'user-story',
      heading: 'User story',
      required: true,
      hint: 'One or more "As a <role>, I want <capability>, so that <benefit>."',
      example:
        'As an accountant, I want to export a month of invoices as CSV, so that I can import them into the ledger without retyping.',
    },
    {
      id: 'acceptance-criteria',
      heading: 'Acceptance criteria',
      required: true,
      hint: 'A checklist of "AC-n: Given <state>, when <action>, then <observable result>.", at least one.',
      example:
        '- [ ] AC-1: Given 120 invoices dated in March, when I export March, then the CSV has 120 rows.',
    },
    {
      id: 'out-of-scope',
      heading: 'Out of scope',
      required: false,
      hint: 'Bullets of what this issue will not do.',
      example: '- PDF export.',
    },
    {
      id: 'constraints',
      heading: 'Constraints',
      required: false,
      hint: 'Performance, security, compatibility, data or deadline limits, with numbers and units.',
      example: '- An export of 10 000 invoices finishes in under 5 s.',
    },
    {
      id: 'context',
      heading: 'Context',
      required: false,
      hint: 'Links, related issues, code pointers (path:line), prior art.',
      example: '- `src/invoices/table.ts:42` renders the table that is copied today.',
    },
    ATTACHMENTS,
  ],
  bug: [
    {
      id: 'summary',
      heading: 'Summary',
      required: true,
      hint: 'One or two sentences: what breaks, and for whom.',
      example: 'Applying a discount code at checkout does not change the order total.',
    },
    {
      id: 'steps-to-reproduce',
      heading: 'Steps to reproduce',
      required: true,
      hint: 'Numbered steps a stranger can repeat from a clean start.',
      example: '1. Add any item to the cart.\n2. Open checkout and apply `SPRING10`.',
    },
    {
      id: 'expected',
      heading: 'Expected',
      required: true,
      hint: 'What should happen, specifically.',
      example: 'The total drops by 10 % and the discount is listed.',
    },
    {
      id: 'actual',
      heading: 'Actual',
      required: true,
      hint: 'What happens; error text verbatim, in a code block.',
      example: 'The total is unchanged; the console shows `TypeError: rate is undefined`.',
    },
    {
      id: 'environment',
      heading: 'Environment',
      required: true,
      hint: 'Version or commit, OS, runtime, browser, relevant configuration.',
      example: 'v2.3.1 (commit abc1234), macOS 15, Safari 19.',
    },
    {
      id: 'frequency',
      heading: 'Frequency',
      required: false,
      hint: '`always`, `intermittent (n of m tries)` or `once`.',
      example: 'always',
    },
    {
      id: 'impact',
      heading: 'Impact',
      required: false,
      hint: 'Who and how many are affected; the workaround, if any.',
      example: 'Every customer with a code; no workaround.',
    },
    {
      id: 'suspected-cause',
      heading: 'Suspected cause',
      required: false,
      hint: 'Code pointers found while investigating, marked as a guess.',
      example: 'Guess: `src/checkout/total.ts:88` reads the rate before the code is applied.',
    },
    {
      id: 'acceptance-criteria',
      heading: 'Acceptance criteria',
      required: true,
      hint: 'At least AC-1, built from the steps and Expected, so the fix gets a regression test.',
      example:
        '- [ ] AC-1: Given a cart with one item, when I apply `SPRING10`, then the total drops by 10 %.',
    },
    ATTACHMENTS,
  ],
};

export const TITLE_MAX = 72;

export const TITLE_RULES: Readonly<Record<IssueKind, string>> = {
  feature: `an imperative verb and an object, at most ${String(TITLE_MAX)} characters, e.g. "Export invoices as CSV"`,
  bug: `"<component>: <symptom>", at most ${String(TITLE_MAX)} characters, e.g. "checkout: total ignores discount code"`,
};

/** The neutral `kind/…` label for each kind (mapped through `labelMap` by the agent). */
export const KIND_LABELS: Readonly<Record<IssueKind, string>> = {
  feature: 'kind/feature',
  bug: 'kind/bug',
};

/** `sentinel issue template <kind>`: the empty body, with a hint comment under each heading. */
export function renderTemplate(kind: IssueKind): string {
  const lines: string[] = [];
  for (const section of ISSUE_SECTIONS[kind]) {
    lines.push(
      `## ${section.heading}`,
      '',
      `<!-- ${section.required ? 'Required' : 'Optional: delete the section if there is nothing to say'}. ${section.hint} -->`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------------
// Secrets

export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Credentials that must never reach an issue. Matches are reported by name and line only;
 * the matched text is never echoed.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  },
  { name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/ },
  { name: 'API secret key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  { name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { name: 'credentials in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/i },
  {
    name: 'password or secret assignment',
    pattern:
      /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?(?![*x•.]{3,}|<|\$\{|\{\{|%|redacted|changeme|example)[^\s"'<>]{8,}/i,
  },
];

export interface SecretFinding {
  readonly line: number;
  readonly pattern: string;
}

/** Every line that matches a secret pattern, with the pattern's name. */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) findings.push({ line: index + 1, pattern: name });
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Lint

export type LintCode =
  | 'missing-title'
  | 'title-too-long'
  | 'title-format'
  | 'missing-section'
  | 'empty-section'
  | 'unknown-section'
  | 'duplicate-section'
  | 'section-order'
  | 'content-before-sections'
  | 'user-story'
  | 'no-acceptance-criteria'
  | 'acceptance-criterion'
  | 'steps-not-numbered'
  | 'frequency'
  | 'template-comment'
  | 'placeholder'
  | 'ambiguous-term'
  | 'secret'
  | 'inline-too-long';

export interface LintProblem {
  readonly code: LintCode;
  readonly message: string;
  /** Section id, when the problem belongs to one. */
  readonly section?: string;
  /** 1-based line in the body. */
  readonly line?: number;
}

export interface LintResult {
  readonly ok: boolean;
  readonly kind: IssueKind;
  readonly title: string;
  readonly body: string;
  /** Ids of the sections found, in order. */
  readonly sections: readonly string[];
  readonly problems: readonly LintProblem[];
}

interface ParsedSection {
  readonly heading: string;
  readonly line: number;
  readonly lines: readonly { readonly text: string; readonly line: number }[];
}

interface ParsedBody {
  readonly preamble: readonly { readonly text: string; readonly line: number }[];
  readonly sections: readonly ParsedSection[];
  /** Line texts outside fenced code and with inline code removed, keyed by line number. */
  readonly prose: readonly { readonly text: string; readonly line: number }[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Splits a body into `##` sections, ignoring headings inside fenced code. */
function parseBody(body: string): ParsedBody {
  const preamble: { text: string; line: number }[] = [];
  const sections: { heading: string; line: number; lines: { text: string; line: number }[] }[] = [];
  const prose: { text: string; line: number }[] = [];
  const lines = body.split('\n');
  const fenced = fencedLines(lines);
  lines.forEach((text, index) => {
    const line = index + 1;
    if (fenced[index] === 'prose') {
      const heading = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(text);
      if (heading?.[1] !== undefined) {
        sections.push({ heading: heading[1].trim(), line, lines: [] });
        return;
      }
      prose.push({ text: text.replace(/`+[^`]*`+/g, ''), line });
    }
    const target = sections.at(-1)?.lines ?? preamble;
    target.push({ text, line });
  });
  return { preamble, sections, prose };
}

/**
 * The text with HTML comments left out; an unclosed comment runs to the end. A scanner rather
 * than a regex replace, so no comment opener can survive or be formed by a removal.
 */
export function stripComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start === -1) return out + text.slice(from);
    out += text.slice(from, start);
    const end = text.indexOf('-->', start + 4);
    if (end === -1) return out;
    from = end + 3;
  }
}

function contentOf(section: ParsedSection): string {
  return stripComments(section.lines.map((l) => l.text).join('\n')).trim();
}

/** Items of a Markdown list: a `-`, `*` or `1.` line plus its indented continuation lines. */
function listItems(section: ParsedSection): { text: string; line: number }[] {
  const items: { text: string; line: number }[] = [];
  for (const { text, line } of section.lines) {
    if (/^\s{0,3}(?:[-*+]|\d+[.)])\s+/.test(text)) {
      items.push({ text: text.trim(), line });
    } else if (/^\s+\S/.test(text) && items.length > 0) {
      const last = items[items.length - 1];
      if (last !== undefined) last.text = `${last.text} ${text.trim()}`;
    }
  }
  return items;
}

const NON_IMPERATIVE_EXCEPTIONS = new Set([
  'bring',
  'embed',
  'exceed',
  'feed',
  'need',
  'ping',
  'proceed',
  'seed',
  'shed',
  'speed',
  'string',
  'succeed',
]);

function titleProblems(kind: IssueKind, title: string): LintProblem[] {
  if (title === '') {
    return [
      {
        code: 'missing-title',
        message: `Give the issue a title: ${TITLE_RULES[kind]}. Pass --title, or start the file with "# <title>".`,
      },
    ];
  }
  const problems: LintProblem[] = [];
  if (title.length > TITLE_MAX) {
    problems.push({
      code: 'title-too-long',
      message: `The title has ${String(title.length)} characters; shorten it to at most ${String(TITLE_MAX)}.`,
    });
  }
  if (kind === 'bug') {
    if (!/^[A-Za-z0-9][\w./@ -]{0,40}: \S.*$/.test(title)) {
      problems.push({ code: 'title-format', message: `Write a bug title as ${TITLE_RULES.bug}.` });
    }
  } else {
    const words = title.split(/\s+/);
    const first = (words[0] ?? '').toLowerCase();
    const notImperative = /^[a-z]+(?:ing|ed)$/.test(first) && !NON_IMPERATIVE_EXCEPTIONS.has(first);
    if (
      words.length < 2 ||
      !/^[A-Z]/.test(title) ||
      /[.!?]$/.test(title) ||
      /^[^\s:]+: /.test(title) ||
      notImperative
    ) {
      problems.push({
        code: 'title-format',
        message: `Write a feature title as ${TITLE_RULES.feature}: capitalised, no trailing full stop.`,
      });
    }
  }
  return problems;
}

/** HTML tags GitHub renders; anything else in angle brackets is a placeholder. */
const HTML_TAGS = new Set([
  'a',
  'b',
  'br',
  'code',
  'details',
  'em',
  'i',
  'img',
  'kbd',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'sub',
  'summary',
  'sup',
  'ul',
]);

function lintAcceptanceCriteria(section: ParsedSection, problems: LintProblem[]): void {
  const items = listItems(section);
  if (items.length === 0) {
    problems.push({
      code: 'no-acceptance-criteria',
      section: 'acceptance-criteria',
      line: section.line,
      message:
        'Add at least one acceptance criterion: "- [ ] AC-1: Given <state>, when <action>, then <observable result>."',
    });
    return;
  }
  items.forEach((item, index) => {
    const expected = index + 1;
    const id = /\bAC-(\d+):/.exec(item.text);
    if (id?.[1] === undefined) {
      problems.push({
        code: 'acceptance-criterion',
        section: 'acceptance-criteria',
        line: item.line,
        message: `Start the criterion with "AC-${String(expected)}:".`,
      });
    } else if (Number(id[1]) !== expected) {
      problems.push({
        code: 'acceptance-criterion',
        section: 'acceptance-criteria',
        line: item.line,
        message: `Number the criteria in order: this one should be AC-${String(expected)}, not AC-${id[1]}.`,
      });
    }
    const lower = item.text.toLowerCase();
    const given = lower.search(/\bgiven\b/);
    const when = lower.search(/\bwhen\b/);
    const then = lower.search(/\bthen\b/);
    if (!(given !== -1 && when > given && then > when)) {
      problems.push({
        code: 'acceptance-criterion',
        section: 'acceptance-criteria',
        line: item.line,
        message: `AC-${id?.[1] ?? String(expected)} needs Given, when and then, in that order.`,
      });
    }
  });
}

/** Inlined attachments (`<details>` blocks) may hold at most {@link INLINE_WHOLE_LINES} lines. */
function lintDetailsBlocks(body: string, problems: LintProblem[]): void {
  let open: { line: number; count: number } | undefined;
  const lines = body.split('\n');
  const fenced = fencedLines(lines);
  lines.forEach((text, index) => {
    const state = fenced[index];
    if (open === undefined) {
      if (state === 'prose' && /<details\b/i.test(text)) open = { line: index + 1, count: 0 };
      return;
    }
    if (state === 'fence') return;
    if (state === 'prose' && /<\/details>/i.test(text)) {
      if (open.count > INLINE_WHOLE_LINES) {
        problems.push({
          code: 'inline-too-long',
          section: 'attachments',
          line: open.line,
          message: `An inlined attachment has ${String(open.count)} lines; keep at most ${String(INLINE_WHOLE_LINES)} (let \`sentinel issue attachments\` trim it).`,
        });
      }
      open = undefined;
      return;
    }
    if (state === 'code' || (text.trim() !== '' && !/<\/?summary\b/i.test(text))) open.count += 1;
  });
}

/**
 * Per line: `fence` for an opening or closing code fence, `code` inside fenced code, `prose`
 * otherwise. A fence closes only on the same character, at least as long, alone on its line.
 */
export function fencedLines(lines: readonly string[]): ('prose' | 'fence' | 'code')[] {
  let fence: string | undefined;
  return lines.map((text) => {
    const match = FENCE.exec(text)?.[1];
    if (fence === undefined) {
      if (match === undefined) return 'prose';
      fence = match;
      return 'fence';
    }
    if (match?.startsWith(fence) === true && text.trim() === match) {
      fence = undefined;
      return 'fence';
    }
    return 'code';
  });
}

/** Splits a leading `# Title` line off a draft. */
export function splitTitle(text: string): { title: string | undefined; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^\s*#[ \t]+(.+?)[ \t]*\n/.exec(`${normalized}\n`);
  if (match?.[1] === undefined) return { title: undefined, body: normalized.trim() };
  return { title: match[1].trim(), body: normalized.slice(match[0].length).trim() };
}

/** `sentinel issue lint`: may this issue be filed as it is? */
export function lintIssue(input: { kind: IssueKind; title: string; body: string }): LintResult {
  const { kind } = input;
  const title = input.title.trim();
  const body = input.body.replace(/\r\n/g, '\n').trim();
  const problems: LintProblem[] = titleProblems(kind, title);
  const definition = ISSUE_SECTIONS[kind];
  const parsed = parseBody(body);

  if (parsed.preamble.some((l) => stripComments(l.text).trim() !== '')) {
    problems.push({
      code: 'content-before-sections',
      line: parsed.preamble.find((l) => l.text.trim() !== '')?.line ?? 1,
      message: `Move the text before the first heading into a section (start with "## ${definition[0]?.heading ?? ''}").`,
    });
  }

  const found: { section: IssueSection; parsed: ParsedSection }[] = [];
  const seen = new Set<string>();
  for (const section of parsed.sections) {
    const match = definition.find((d) => d.heading.toLowerCase() === section.heading.toLowerCase());
    if (match === undefined) {
      problems.push({
        code: 'unknown-section',
        line: section.line,
        message: `"## ${section.heading}" is not a ${kind} section; use ${definition.map((d) => `"${d.heading}"`).join(', ')}.`,
      });
      continue;
    }
    if (seen.has(match.id)) {
      problems.push({
        code: 'duplicate-section',
        section: match.id,
        line: section.line,
        message: `"## ${match.heading}" appears more than once; merge the two.`,
      });
      continue;
    }
    seen.add(match.id);
    found.push({ section: match, parsed: section });
  }

  let lastIndex = -1;
  for (const { section, parsed: p } of found) {
    const index = definition.indexOf(section);
    if (index < lastIndex) {
      problems.push({
        code: 'section-order',
        section: section.id,
        line: p.line,
        message: `Move "## ${section.heading}" up: the order is ${definition.map((d) => d.heading).join(', ')}.`,
      });
    }
    lastIndex = Math.max(lastIndex, index);
  }

  for (const section of definition) {
    const entry = found.find((f) => f.section === section);
    if (entry === undefined) {
      if (section.required) {
        problems.push({
          code: 'missing-section',
          section: section.id,
          message: `Add "## ${section.heading}": ${section.hint}`,
        });
      }
      continue;
    }
    if (contentOf(entry.parsed) === '') {
      problems.push({
        code: 'empty-section',
        section: section.id,
        line: entry.parsed.line,
        message: section.required
          ? `Fill in "## ${section.heading}": ${section.hint}`
          : `Delete the empty optional section "## ${section.heading}".`,
      });
      continue;
    }
    const content = contentOf(entry.parsed);
    if (section.id === 'acceptance-criteria') lintAcceptanceCriteria(entry.parsed, problems);
    if (section.id === 'user-story') {
      const stories = content
        .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter((s) => s !== '');
      for (const story of stories) {
        if (!/\bAs an?\b.+?,\s*I want\b.+?,\s*so that\b.+/i.test(story)) {
          problems.push({
            code: 'user-story',
            section: 'user-story',
            line: entry.parsed.line,
            message: `Write each user story as "As a <role>, I want <capability>, so that <benefit>.": "${story.slice(0, 60)}${story.length > 60 ? '…' : ''}"`,
          });
        }
      }
    }
    if (
      section.id === 'steps-to-reproduce' &&
      !entry.parsed.lines.some((l) => /^\s{0,3}\d+[.)]\s+\S/.test(l.text))
    ) {
      problems.push({
        code: 'steps-not-numbered',
        section: section.id,
        line: entry.parsed.line,
        message: 'Write the steps as a numbered list (1., 2., …) a stranger can repeat.',
      });
    }
    if (
      section.id === 'frequency' &&
      !/^(?:always|once|intermittent \(\d+ of \d+ tries\))\.?$/i.test(content.replace(/`/g, ''))
    ) {
      problems.push({
        code: 'frequency',
        section: section.id,
        line: entry.parsed.line,
        message: 'Write the frequency as `always`, `intermittent (n of m tries)` or `once`.',
      });
    }
  }

  // Line-level checks, outside fenced code and inline code. The `<details>`/`<summary>` header
  // of an inlined attachment holds the file name, which the author cannot reword.
  for (const { text, line } of parsed.prose) {
    if (/<(?:details|summary)\b/i.test(text)) continue;
    if (text.includes('<!--')) {
      problems.push({
        code: 'template-comment',
        line,
        message: 'Remove the template hint comment.',
      });
    }
    const withoutComments = stripComments(text);
    for (const match of withoutComments.matchAll(/<\/?([a-z][a-z0-9 _-]*)>|\bN\/A\b/gi)) {
      const tag = match[1]?.toLowerCase();
      if (tag !== undefined && HTML_TAGS.has(tag)) continue;
      problems.push({
        code: 'placeholder',
        line,
        message: `Replace the placeholder "${match[0]}" with the real content, or delete the line.`,
      });
    }
    for (const pattern of AMBIGUOUS_TERMS) {
      const match = pattern.exec(withoutComments);
      if (match !== null) {
        problems.push({
          code: 'ambiguous-term',
          line,
          message: `Ambiguous wording "${match[0]}": replace it with something verifiable.`,
        });
      }
    }
  }

  for (const finding of findSecrets(body)) {
    problems.push({
      code: 'secret',
      line: finding.line,
      message: `Line ${String(finding.line)} looks like a ${finding.pattern}: remove or redact it before filing.`,
    });
  }
  for (const finding of findSecrets(title)) {
    problems.push({
      code: 'secret',
      message: `The title looks like it contains a ${finding.pattern}: remove it.`,
    });
  }

  lintDetailsBlocks(body, problems);

  return {
    ok: problems.length === 0,
    kind,
    title,
    body,
    sections: found.map((f) => f.section.id),
    problems,
  };
}

// ---------------------------------------------------------------------------------------------
// Attachments

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OTHER_MAX_BYTES = 25 * 1024 * 1024;
/** Text up to this many lines is inlined whole; longer text keeps a head and a tail. */
export const INLINE_WHOLE_LINES = 200;
export const INLINE_KEEP_LINES = 80;

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'tif',
  'tiff',
  'heic',
  'avif',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);

export type AttachmentKind = 'text' | 'image' | 'video' | 'binary';
export type AttachmentAction = 'inline' | 'attach' | 'pending-upload' | 'blocked' | 'rejected';

export interface AttachmentPlan {
  readonly path: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly bytes: number;
  readonly action: AttachmentAction;
  readonly reason: string;
  /** Text only: total lines, and whether the inlined copy was cut. */
  readonly lines?: number | undefined;
  readonly trimmed?: boolean | undefined;
  /** Text only, when blocked: where the secrets are (never the secret itself). */
  readonly secrets?: readonly SecretFinding[] | undefined;
  /** The `<details>` block to paste under `## Attachments`, for inlined text. */
  readonly inline?: string | undefined;
}

export interface AttachmentInput {
  readonly path: string;
  readonly bytes: number;
  /** Reads the file; called only when the file is under its size cap. */
  readonly read: () => Promise<Uint8Array>;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** `image` or `video` by extension; anything else is sniffed later. */
function kindByName(name: string): AttachmentKind {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return VIDEO_EXTENSIONS.has(extension) ? 'video' : 'binary';
}

/** The size cap for a file: 10 MB for images, 25 MB for anything else. */
export function sizeCapFor(name: string): number {
  return kindByName(name) === 'image' ? IMAGE_MAX_BYTES : OTHER_MAX_BYTES;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Text when the first 8 KiB have no NUL byte and decode as UTF-8. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  // A multi-byte character may be cut at the end of the sample: drop up to 3 trailing bytes.
  for (let cut = 0; cut <= 3 && cut <= sample.length; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - cut));
      return true;
    } catch {
      // try a shorter sample
    }
  }
  return false;
}

function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
}

/** The `<details>` block for a text file, cut to head and tail when it is long. */
export function renderInline(
  name: string,
  text: string,
): { block: string; lines: number; trimmed: boolean } {
  const all = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const total = all.length;
  const trimmed = total > INLINE_WHOLE_LINES;
  let kept: string[];
  let summary: string;
  if (trimmed) {
    const tailStart = total - INLINE_KEEP_LINES + 1;
    kept = [
      ...all.slice(0, INLINE_KEEP_LINES),
      `… ${String(total - 2 * INLINE_KEEP_LINES)} lines cut (${String(INLINE_KEEP_LINES + 1)}–${String(tailStart - 1)}) …`,
      ...all.slice(-INLINE_KEEP_LINES),
    ];
    summary = `${name} (lines 1–${String(INLINE_KEEP_LINES)} and ${String(tailStart)}–${String(total)} of ${String(total)})`;
  } else {
    kept = all;
    summary = `${name} (${String(total)} line${total === 1 ? '' : 's'})`;
  }
  const content = kept.join('\n');
  const fence = fenceFor(content);
  const block = [
    `<details><summary>${summary.replace(/[<>&]/g, '')}</summary>`,
    '',
    fence,
    content,
    fence,
    '',
    '</details>',
  ].join('\n');
  return { block, lines: total, trimmed };
}

/** Decides, per file, how it is attached (docs/issue-format.md#attachments). */
export async function planAttachment(
  input: AttachmentInput,
  options: { trackerUploads: boolean },
): Promise<AttachmentPlan> {
  const name = baseName(input.path);
  const guess = kindByName(name);
  const cap = sizeCapFor(name);
  const base = { path: input.path, name, bytes: input.bytes };
  if (input.bytes > cap) {
    return {
      ...base,
      kind: guess,
      action: 'rejected',
      reason: `${formatBytes(input.bytes)} is over the ${guess === 'image' ? '10 MB image' : '25 MB'} limit; shrink, crop or split it`,
    };
  }
  const bytes = await input.read();
  const kind: AttachmentKind = guess === 'binary' && looksLikeText(bytes) ? 'text' : guess;
  if (kind === 'text') {
    const text = new TextDecoder('utf-8').decode(bytes);
    const secrets = findSecrets(text);
    if (secrets.length > 0) {
      return {
        ...base,
        kind,
        action: 'blocked',
        reason: `contains what looks like a secret (${[...new Set(secrets.map((s) => s.pattern))].join(', ')}) on line ${secrets.map((s) => String(s.line)).join(', ')}; redact it, then plan again`,
        secrets,
      };
    }
    const { block, lines, trimmed } = renderInline(name, text);
    return {
      ...base,
      kind,
      action: 'inline',
      reason: trimmed
        ? `text, ${String(lines)} lines: inlined with the first and last ${String(INLINE_KEEP_LINES)}`
        : `text, ${String(lines)} lines: inlined whole`,
      lines,
      trimmed,
      inline: block,
    };
  }
  return options.trackerUploads
    ? { ...base, kind, action: 'attach', reason: `${kind}: upload it with the tracker's own tool` }
    : {
        ...base,
        kind,
        action: 'pending-upload',
        reason: `${kind}: the tracker cannot take uploads from the agent; the user drags it into the issue after filing`,
      };
}

const HOW: Readonly<Record<AttachmentAction, string>> = {
  inline: 'inline, below',
  attach: 'uploaded',
  'pending-upload': 'pending upload',
  blocked: 'blocked',
  rejected: 'rejected',
};

/**
 * The `## Attachments` section for the files that can go on the issue. `<what it shows>` is a
 * placeholder the agent must replace (lint rejects it until then).
 */
export function renderAttachmentsSection(plans: readonly AttachmentPlan[]): string {
  const usable = plans.filter((p) => p.action !== 'blocked' && p.action !== 'rejected');
  if (usable.length === 0) return '';
  const lines = ['## Attachments', ''];
  for (const plan of usable) {
    lines.push(`- \`${plan.name}\`: <what it shows> (${HOW[plan.action]})`);
  }
  for (const plan of usable) {
    if (plan.inline !== undefined) lines.push('', plan.inline);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// GitHub issue forms

export const ISSUE_FORM_DIR = '.github/ISSUE_TEMPLATE';

const FORM_INTRO: Readonly<Record<IssueKind, { name: string; description: string }>> = {
  feature: {
    name: 'Feature request',
    description: 'A problem, a user story and testable acceptance criteria.',
  },
  bug: {
    name: 'Bug report',
    description: 'Steps to reproduce, expected and actual result, and the environment.',
  },
};

/** A YAML double-quoted scalar; JSON string syntax is valid YAML. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * `.github/ISSUE_TEMPLATE/<kind>.yml`: one textarea per section, with the section id as the
 * field id, and the kind label mapped through `labelMap`.
 */
export function renderIssueForm(
  kind: IssueKind,
  labelMap: Readonly<Record<string, string>> = {},
): { path: string; content: string } {
  const intro = FORM_INTRO[kind];
  const label = labelMap[KIND_LABELS[kind]] ?? KIND_LABELS[kind];
  const lines = [
    '# Generated by `sentinel setup --issue-forms` from the sentinel issue format',
    '# (docs/issue-format.md in the sentinel repository). Re-run it instead of editing by hand.',
    `name: ${yamlString(intro.name)}`,
    `description: ${yamlString(intro.description)}`,
    `labels: [${yamlString(label)}]`,
    'body:',
    '  - type: markdown',
    '    attributes:',
    `      value: ${yamlString(`Title: ${TITLE_RULES[kind]}. Leave optional fields empty when there is nothing to say.`)}`,
  ];
  for (const section of ISSUE_SECTIONS[kind]) {
    lines.push(
      '  - type: textarea',
      `    id: ${section.id}`,
      '    attributes:',
      `      label: ${yamlString(section.heading)}`,
      `      description: ${yamlString(section.hint)}`,
      `      placeholder: ${yamlString(section.example)}`,
      '    validations:',
      `      required: ${String(section.required)}`,
    );
  }
  return { path: `${ISSUE_FORM_DIR}/${kind}.yml`, content: `${lines.join('\n')}\n` };
}
