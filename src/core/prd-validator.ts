import { z } from 'zod';
import type { SentinelConfig } from './config-schema.js';

export const DIMENSIONS = [
  'clarity',
  'testability',
  'completeness',
  'security',
  'feasibility',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type Scores = Record<Dimension, number>;

/** Agent self-scores, one number from 0 to 100 per dimension. */
export const scoresSchema = z.strictObject({
  clarity: z.number().min(0).max(100),
  testability: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  security: z.number().min(0).max(100),
  feasibility: z.number().min(0).max(100),
});

export const ESCALATION_MESSAGE =
  'Confidence threshold not met. Recommended action: Escalate to a higher-reasoning model.';

export type IssueCode =
  | 'missing-context'
  | 'no-functional-requirements'
  | 'duplicate-requirement-id'
  | 'fr-no-scenario'
  | 'fr-incomplete-scenario'
  | 'no-nfr'
  | 'nfr-unmeasurable'
  | 'no-security-section'
  | 'security-authentication'
  | 'security-authorization'
  | 'security-input-validation'
  | 'missing-data-model'
  | 'missing-api-contract'
  | 'missing-test-matrix'
  | 'test-matrix-tier'
  | 'ambiguous-term';

export interface PrdIssue {
  readonly code: IssueCode;
  readonly message: string;
  /** Dimensions whose score this issue caps, with the cap. */
  readonly caps: Readonly<Partial<Record<Dimension, number>>>;
  /** 1-based line the issue refers to, when it has one. */
  readonly line?: number | undefined;
}

export interface PrdStats {
  readonly functionalRequirements: number;
  readonly nonFunctionalRequirements: number;
  readonly ambiguousTerms: number;
}

// ---------------------------------------------------------------------------
// Markdown structure

interface Section {
  readonly title: string;
  readonly level: number;
  /** 1-based line of the heading. */
  readonly line: number;
  /** Body lines (without the heading), paired with their 1-based line numbers. */
  readonly body: readonly { readonly text: string; readonly line: number }[];
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;

/** Heading text without surrounding spaces or closing `#` marks. */
function headingTitle(raw: string): string {
  return raw.trim().replace(/[ \t]*#+$/, '').trim();
}
const FENCE = /^\s*(```|~~~)/;

/** Splits a document into sections by heading, ignoring headings inside code fences. */
function parseSections(markdown: string): { sections: Section[]; codeFreeLines: string[] } {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  const codeFreeLines: string[] = [];
  let inFence = false;
  let current: { title: string; level: number; line: number; body: Section['body'] } | undefined;
  const body: { text: string; line: number }[] = [];

  const flush = (): void => {
    if (current !== undefined) sections.push({ ...current, body: [...body] });
    body.length = 0;
  };

  lines.forEach((text, index) => {
    const line = index + 1;
    if (FENCE.test(text)) {
      inFence = !inFence;
      codeFreeLines.push('');
      body.push({ text, line });
      return;
    }
    codeFreeLines.push(inFence ? '' : text);
    const heading = inFence ? null : HEADING.exec(text);
    if (heading !== null) {
      flush();
      current = { title: headingTitle(heading[2] ?? ''), level: (heading[1] ?? '#').length, line, body: [] };
      return;
    }
    body.push({ text, line });
  });
  flush();
  return { sections, codeFreeLines };
}

/**
 * Body of a section including its sub-sections (everything up to the next heading of the
 * same or a higher level).
 */
function sectionWithChildren(
  sections: readonly Section[],
  index: number,
): { text: string; line: number }[] {
  const start = sections[index];
  if (start === undefined) return [];
  const lines = [...start.body];
  for (let i = index + 1; i < sections.length; i += 1) {
    const next = sections[i];
    if (next === undefined || next.level <= start.level) break;
    lines.push({ text: `${'#'.repeat(next.level)} ${next.title}`, line: next.line }, ...next.body);
  }
  return lines;
}

function findSection(
  sections: readonly Section[],
  pattern: RegExp,
): { text: string; line: number }[] | undefined {
  const index = sections.findIndex((s) => pattern.test(s.title));
  return index === -1 ? undefined : sectionWithChildren(sections, index);
}

const plain = (lines: readonly { text: string }[]): string => lines.map((l) => l.text).join('\n');
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------------------
// Checks

const FR_START = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?[*_]*FR-(\d+)\b/i;
const NFR_ITEM = /^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+[*_]*NFR-\d+|[*_]*NFR-\d+)/i;
const GWT_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?[*_]*(given|when|then|and|but)\b/i;
const GWT_INLINE = /\bgiven\b.+\bwhen\b.+\bthen\b/is;

interface FrBlock {
  readonly id: string;
  readonly line: number;
  readonly lines: string[];
}

function extractFrBlocks(body: readonly { text: string; line: number }[]): FrBlock[] {
  const blocks: FrBlock[] = [];
  let current: FrBlock | undefined;
  for (const { text, line } of body) {
    const start = FR_START.exec(text);
    if (start !== null) {
      current = { id: `FR-${start[1] ?? ''}`, line, lines: [text] };
      blocks.push(current);
    } else if (current !== undefined) {
      current.lines.push(text);
    }
  }
  return blocks;
}

type ScenarioState = 'complete' | 'incomplete' | 'none';

/** Does a requirement block contain a Given/When/Then scenario? */
function scenarioState(lines: readonly string[]): ScenarioState {
  const joined = lines.join('\n');
  if (GWT_INLINE.test(joined.replace(/\n/g, ' '))) return 'complete';
  const keywords: string[] = [];
  for (const text of lines) {
    const match = GWT_LINE.exec(text);
    if (match !== null) keywords.push((match[1] ?? '').toLowerCase());
  }
  if (keywords.length === 0) return 'none';
  const first = (word: string): number => keywords.indexOf(word);
  const given = first('given');
  const when = first('when');
  const then = first('then');
  return given !== -1 && when > given && then > when ? 'complete' : 'incomplete';
}

const MEASURE =
  /\d[\d,.]*[ \t]?(?:ms|milliseconds?|s|sec|secs|seconds?|min|mins|minutes?|h|hrs?|hours?|days?|weeks?|%|percent|rps|req\/s|qps|tps|requests?|users?|kb|mb|gb|tb|kib|mib|gib|nines|\/s|\/sec|\/min)(?![a-z0-9])/i;

function isMeasurable(text: string): boolean {
  return MEASURE.test(text) || /\bp(?:50|90|95|99|99\.9)\b.*\d/i.test(text);
}

const AMBIGUOUS: readonly RegExp[] = [
  /\b(?:fast|faster|quick|quickly|slow)\b/i,
  /\buser[- ]friendly\b/i,
  /\b(?:easy|easily|simple|intuitive|seamless|seamlessly|robust|flexible|modern)\b/i,
  /\b(?:efficient|efficiently|reasonable|reasonably|adequate|adequately|sufficient|sufficiently)\b/i,
  /\b(?:appropriate|appropriately)\b/i,
  /\betc\b\.?/i,
  /\band so on\b/i,
  /\b(?:as needed|if necessary|where possible|to be determined)\b/i,
  /\b(?:tbd|tbc|todo)\b/i,
];

const TIERS: readonly (readonly [string, RegExp])[] = [
  ['unit', /\bunit\b/i],
  ['integration', /\bintegration\b/i],
  ['E2E', /\b(?:e2e|end[- ]to[- ]end)\b/i],
  ['load', /\b(?:load|performance|stress)\b/i],
];

export interface PrdAnalysis {
  readonly issues: readonly PrdIssue[];
  readonly stats: PrdStats;
}

/** Structural analysis of a PRD: every deterministic check, no scoring. */
export function analyzePrd(markdown: string): PrdAnalysis {
  const { sections, codeFreeLines } = parseSections(markdown);
  const issues: PrdIssue[] = [];
  const add = (issue: PrdIssue): void => {
    issues.push(issue);
  };

  // Context & problem statement
  const context = findSection(sections, /\b(context|problem|background|overview)\b/i);
  if (context === undefined || wordCount(plain(context)) < 15) {
    add({
      code: 'missing-context',
      message: 'Add a "Context & Problem Statement" section (at least a short paragraph).',
      caps: { completeness: 55, clarity: 65 },
    });
  }

  // Functional requirements
  const functionalIndex = sections.findIndex(
    (s) => /\bfunctional requirements\b/i.test(s.title) && !/\bnon[- ]?functional\b/i.test(s.title),
  );
  const functionalBody =
    functionalIndex === -1
      ? sections.flatMap((s) => s.body)
      : sectionWithChildren(sections, functionalIndex);
  const frBlocks = extractFrBlocks(functionalBody);
  if (frBlocks.length === 0) {
    add({
      code: 'no-functional-requirements',
      message:
        'No functional requirements found. Number them FR-1, FR-2, … under "Functional Requirements".',
      caps: { completeness: 40, testability: 50 },
    });
  }
  const seen = new Set<string>();
  for (const block of frBlocks) {
    const key = block.id.toUpperCase();
    if (seen.has(key)) {
      add({
        code: 'duplicate-requirement-id',
        message: `${block.id} is defined more than once.`,
        caps: { clarity: 70 },
        line: block.line,
      });
    }
    seen.add(key);
    const state = scenarioState(block.lines);
    if (state === 'none') {
      add({
        code: 'fr-no-scenario',
        message: `${block.id} has no Given/When/Then scenario.`,
        caps: { testability: 60 },
        line: block.line,
      });
    } else if (state === 'incomplete') {
      add({
        code: 'fr-incomplete-scenario',
        message: `${block.id} has a scenario that is missing Given, When or Then (in that order).`,
        caps: { testability: 70 },
        line: block.line,
      });
    }
  }

  // Non-functional requirements
  const nfrBody = findSection(sections, /\bnon[- ]?functional\b|\bnfrs?\b|\bquality attributes\b/i);
  let nfrCount = 0;
  if (nfrBody === undefined) {
    add({
      code: 'no-nfr',
      message: 'Add a "Non-Functional Requirements" section with measurable targets.',
      caps: { completeness: 60, testability: 70 },
    });
  } else {
    const rows: { text: string; line: number }[] = [];
    let inTable = false;
    for (const entry of nfrBody) {
      const trimmed = entry.text.trim();
      if (trimmed === '') {
        inTable = false;
      } else if (trimmed.startsWith('|')) {
        // Skip the header row and the separator row of each table.
        if (/^\|[\s:|-]+\|?$/.test(trimmed)) continue;
        if (inTable) rows.push(entry);
        inTable = true;
      } else {
        inTable = false;
        if (NFR_ITEM.test(trimmed)) rows.push(entry);
      }
    }
    nfrCount = rows.length;
    if (rows.length === 0) {
      add({
        code: 'no-nfr',
        message: 'The Non-Functional Requirements section lists no requirements.',
        caps: { completeness: 60, testability: 70 },
      });
    }
    for (const row of rows) {
      if (!isMeasurable(row.text)) {
        add({
          code: 'nfr-unmeasurable',
          message: `Non-functional requirement is not measurable (give a number and a unit): "${row.text.trim().slice(0, 80)}"`,
          caps: { testability: 65, feasibility: 70 },
          line: row.line,
        });
      }
    }
  }

  // Security
  const security = findSection(sections, /\bsecurity\b/i);
  if (security === undefined) {
    add({
      code: 'no-security-section',
      message:
        'Add a "Security" section covering authentication, authorisation (RBAC) and input validation.',
      caps: { security: 40 },
    });
  } else {
    const text = plain(security);
    if (
      !/\b(?:authenticat\w*|authn|login|sign[- ]?in|oauth\w*|oidc|sso|jwt|saml|mfa|api key\w*)\b/i.test(
        text,
      )
    ) {
      add({
        code: 'security-authentication',
        message: 'Security section does not cover authentication.',
        caps: { security: 60 },
      });
    }
    if (
      !/\b(?:authori[sz]\w*|authz|rbac|abac|permissions?|roles?|access control|acl)\b/i.test(text)
    ) {
      add({
        code: 'security-authorization',
        message: 'Security section does not cover authorisation / RBAC.',
        caps: { security: 60 },
      });
    }
    if (
      !/\b(?:input validation|validat\w*|sanitis\w*|sanitiz\w*|injection|escap\w*)\b/i.test(text)
    ) {
      add({
        code: 'security-input-validation',
        message: 'Security section does not cover input validation.',
        caps: { security: 65 },
      });
    }
  }

  // Data models and API contracts
  const data = findSection(sections, /\bdata (?:models?|model|schema|entities)\b|\bschema\b/i);
  if (data === undefined || wordCount(plain(data)) < 8) {
    add({
      code: 'missing-data-model',
      message: 'Add a "Data Models" section (entities, fields and relations).',
      caps: { completeness: 65, feasibility: 80 },
    });
  }
  const api = findSection(sections, /\bapi\b|\bcontracts?\b|\binterfaces?\b/i);
  const apiText = api === undefined ? '' : plain(api);
  if (
    api === undefined ||
    !(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S*/.test(apiText) || /```|^\s*\|/m.test(apiText))
  ) {
    add({
      code: 'missing-api-contract',
      message: 'Add an "API Contracts" section with endpoints (e.g. `POST /orders`) or schemas.',
      caps: { completeness: 65, feasibility: 80 },
    });
  }

  // Test strategy matrix
  const matrix = findSection(
    sections,
    /\btest(?:ing)? (?:strategy|matrix|plan)\b|\btest strategy\b/i,
  );
  if (matrix === undefined) {
    add({
      code: 'missing-test-matrix',
      message: 'Add a "Test Strategy Matrix" covering unit, integration, E2E and load tests.',
      caps: { testability: 55, completeness: 75 },
    });
  } else {
    const text = plain(matrix);
    for (const [name, pattern] of TIERS) {
      if (!pattern.test(text)) {
        add({
          code: 'test-matrix-tier',
          message: `The test matrix does not cover ${name} tests.`,
          caps: { testability: 65 },
        });
      }
    }
  }

  // Ambiguity lint (outside code fences)
  let ambiguous = 0;
  codeFreeLines.forEach((text, index) => {
    for (const pattern of AMBIGUOUS) {
      const match = pattern.exec(text);
      if (match !== null) {
        ambiguous += 1;
        add({
          code: 'ambiguous-term',
          message: `Ambiguous wording "${match[0]}": replace it with something verifiable.`,
          caps: {},
          line: index + 1,
        });
      }
    }
  });

  return {
    issues,
    stats: {
      functionalRequirements: frBlocks.length,
      nonFunctionalRequirements: nfrCount,
      ambiguousTerms: ambiguous,
    },
  };
}

/** Per-dimension upper bounds implied by the structural issues (100 = uncapped). */
export function capsFor(analysis: PrdAnalysis): Scores {
  const caps: Scores = {
    clarity: 100,
    testability: 100,
    completeness: 100,
    security: 100,
    feasibility: 100,
  };
  for (const issue of analysis.issues) {
    for (const dimension of DIMENSIONS) {
      const cap = issue.caps[dimension];
      if (cap !== undefined) caps[dimension] = Math.min(caps[dimension], cap);
    }
  }
  // Ambiguity is graded by how much of it there is.
  const n = analysis.stats.ambiguousTerms;
  if (n > 0) caps.clarity = Math.min(caps.clarity, n > 5 ? 65 : n > 2 ? 75 : 85);
  return caps;
}

// ---------------------------------------------------------------------------
// Decision

export type NextAction = 'accept' | 'refine' | 'escalate' | 'score';

export interface PrdThresholds {
  readonly threshold: number;
  readonly dimensionFloor: number;
  readonly maxRefinements: number;
}

export interface PrdDecision {
  readonly nextAction: NextAction;
  readonly pass: boolean;
  readonly effectiveScores?: Scores | undefined;
  readonly mean?: number | undefined;
  readonly min?: number | undefined;
  /** Why the decision is what it is, in one sentence. */
  readonly reason: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Applies the pass rule to the (capped) scores.
 * `evaluationsBefore` is how many scored evaluations of this PRD already happened; the first
 * evaluation does not count as a refinement, so the PRD escalates once it has failed
 * `maxRefinements` refinement passes.
 */
export function decide(
  caps: Scores,
  scores: Scores | undefined,
  thresholds: PrdThresholds,
  evaluationsBefore: number,
): PrdDecision {
  if (scores === undefined) {
    const best = DIMENSIONS.map((d) => caps[d]);
    const bestMean = best.reduce((a, b) => a + b, 0) / best.length;
    const blocked =
      bestMean < thresholds.threshold || Math.min(...best) < thresholds.dimensionFloor;
    return blocked
      ? {
          nextAction: 'refine',
          pass: false,
          reason:
            'The structural issues cap the achievable score below the pass rule; fix them first.',
        }
      : {
          nextAction: 'score',
          pass: false,
          reason:
            'Structure is acceptable: self-score the five dimensions with the rubric and re-run with --scores.',
        };
  }

  const effective = {} as Scores;
  for (const d of DIMENSIONS) effective[d] = Math.min(scores[d], caps[d]);
  const values = DIMENSIONS.map((d) => effective[d]);
  const mean = round1(values.reduce((a, b) => a + b, 0) / values.length);
  const min = Math.min(...values);
  const pass = mean >= thresholds.threshold && min >= thresholds.dimensionFloor;
  if (pass) {
    return {
      nextAction: 'accept',
      pass,
      effectiveScores: effective,
      mean,
      min,
      reason: 'The PRD meets the threshold.',
    };
  }
  const refinementsDone = evaluationsBefore;
  if (refinementsDone >= thresholds.maxRefinements) {
    return {
      nextAction: 'escalate',
      pass,
      effectiveScores: effective,
      mean,
      min,
      reason: `Still below the threshold after ${String(thresholds.maxRefinements)} refinement passes.`,
    };
  }
  const why =
    mean < thresholds.threshold
      ? `mean ${String(mean)} is below ${String(thresholds.threshold)}`
      : `lowest dimension ${String(min)} is below the floor ${String(thresholds.dimensionFloor)}`;
  return {
    nextAction: 'refine',
    pass,
    effectiveScores: effective,
    mean,
    min,
    reason: `Refine the PRD: ${why}.`,
  };
}

export interface PrdReport extends PrdDecision {
  readonly issues: readonly PrdIssue[];
  readonly stats: PrdStats;
  readonly caps: Scores;
  /** Scored evaluations of this PRD including this one (0 when no scores were given). */
  readonly evaluation: number;
  readonly message: string;
}

export interface ValidateOptions {
  readonly scores?: Scores | undefined;
  readonly config: Pick<SentinelConfig, 'prd'>;
  /** Scored evaluations that already happened for this PRD. */
  readonly evaluationsBefore?: number | undefined;
}

/** Full validation: structure, caps, and the accept / refine / escalate decision. */
export function validatePrd(markdown: string, options: ValidateOptions): PrdReport {
  const analysis = analyzePrd(markdown);
  const caps = capsFor(analysis);
  const before = options.evaluationsBefore ?? 0;
  const decision = decide(caps, options.scores, options.config.prd, before);
  return {
    ...decision,
    issues: analysis.issues,
    stats: analysis.stats,
    caps,
    evaluation: options.scores === undefined ? before : before + 1,
    message: decision.nextAction === 'escalate' ? ESCALATION_MESSAGE : decision.reason,
  };
}
