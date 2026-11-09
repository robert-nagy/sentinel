import { z } from 'zod';

export const DOMAIN_FILE = '.sentinel/domain.json';

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export type Branch = 'core' | 'nfr' | 'security' | 'journeys' | 'integrations' | 'compliance';
export type QuestionKind = 'text' | 'yesno';
export type Answers = Readonly<Record<string, string>>;

export interface Question {
  readonly id: string;
  readonly branch: Branch;
  readonly kind: QuestionKind;
  readonly prompt: string;
  readonly hint?: string;
  /** Follow-ups are asked only when this holds for the answers so far. */
  readonly when?: (answers: Answers) => boolean;
}

/** What a skill or terminal shows: a question without its trigger function. */
export type PublicQuestion = Omit<Question, 'when'>;

const PII_WORDS =
  /\b(pii|personal|personally|email|e-mail|name|address|phone|birth|ssn|passport|health|medical|patient|payment|card|iban|biometric|gdpr|hipaa|location|customer data)\b/i;
const NONE_WORDS = new Set(['none', 'no', 'n/a', 'na', 'nothing', '-']);

/** True when the answers say the system touches personal data. */
export function isPiiLikely(answers: Answers): boolean {
  if (answers.pii === 'yes') return true;
  if (answers.pii === 'no') return false;
  return PII_WORDS.test(answers.data ?? '');
}

/** True when the answer names something (not "none" / "n/a"). */
export function isSubstantive(value: string | undefined): boolean {
  if (value === undefined) return false;
  const text = value.trim().toLowerCase();
  const bare = text.endsWith('.') ? text.slice(0, -1).trimEnd() : text;
  return bare !== '' && !NONE_WORDS.has(bare);
}

/** The question bank, in the order questions are asked. */
export const QUESTIONS: readonly Question[] = [
  // The four core questions.
  {
    id: 'problem',
    branch: 'core',
    kind: 'text',
    prompt: 'What problem does this product solve, and why now?',
  },
  {
    id: 'users',
    branch: 'core',
    kind: 'text',
    prompt: 'Who are the primary users, and what role does each play?',
    hint: 'for example: customers, support agents, administrators',
  },
  {
    id: 'data',
    branch: 'core',
    kind: 'text',
    prompt: 'What data does it store or process?',
  },
  {
    id: 'scale',
    branch: 'core',
    kind: 'text',
    prompt: 'What scale do you expect (users, requests per second, data volume)?',
  },
  // SLAs and non-functional requirements.
  {
    id: 'availability',
    branch: 'nfr',
    kind: 'text',
    prompt: 'What availability and latency targets must it meet?',
    hint: 'with numbers, for example 99.9% uptime and p95 under 300 ms',
  },
  {
    id: 'recovery',
    branch: 'nfr',
    kind: 'text',
    prompt: 'How much data loss and downtime is acceptable after a failure (RPO and RTO)?',
  },
  // Security boundaries.
  {
    id: 'authentication',
    branch: 'security',
    kind: 'text',
    prompt: 'How do users and services authenticate?',
    hint: 'for example OIDC single sign-on, API keys, mTLS',
  },
  {
    id: 'authorization',
    branch: 'security',
    kind: 'text',
    prompt: 'Which roles exist, and what may each role do?',
  },
  {
    id: 'boundaries',
    branch: 'security',
    kind: 'text',
    prompt: 'Which parts are public, internal or admin-only, and where does untrusted input enter?',
  },
  // Core user journeys.
  {
    id: 'journeys',
    branch: 'journeys',
    kind: 'text',
    prompt: 'Describe the three to five most important user journeys, one per line.',
  },
  // Integrations.
  {
    id: 'integrations',
    branch: 'integrations',
    kind: 'text',
    prompt: 'Which external systems does it integrate with? Answer "none" if there are none.',
  },
  {
    id: 'integrationAuth',
    branch: 'integrations',
    kind: 'text',
    prompt: 'How does each integration authenticate, and what happens when it is down?',
    when: (answers) => isSubstantive(answers.integrations),
  },
  // Compliance, triggered by personal data.
  {
    id: 'pii',
    branch: 'compliance',
    kind: 'yesno',
    prompt: 'Does the system store or process personal data (PII)?',
    when: (answers) => !PII_WORDS.test(answers.data ?? '') || answers.pii !== undefined,
  },
  {
    id: 'regulations',
    branch: 'compliance',
    kind: 'text',
    prompt: 'Which regulations or standards apply (GDPR, HIPAA, PCI DSS, SOC 2, none)?',
    when: isPiiLikely,
  },
  {
    id: 'retention',
    branch: 'compliance',
    kind: 'text',
    prompt: 'How long is personal data kept, where is it stored, and how is it deleted on request?',
    when: isPiiLikely,
  },
];

export const QUESTION_IDS: readonly string[] = QUESTIONS.map((question) => question.id);

export function toPublic(question: Question): PublicQuestion {
  const { when: _when, ...rest } = question;
  return rest;
}

function unanswered(answers: Answers, question: Question): boolean {
  return (answers[question.id] ?? '').trim() === '' && (question.when?.(answers) ?? true);
}

/**
 * The questions to ask next. The core questions come first and alone; once they are answered
 * the follow-up branches that apply to the answers so far are returned together.
 */
export function nextQuestions(answers: Answers): Question[] {
  const core = QUESTIONS.filter((q) => q.branch === 'core' && unanswered(answers, q));
  if (core.length > 0) return core;
  return QUESTIONS.filter((q) => q.branch !== 'core' && unanswered(answers, q));
}

export function isComplete(answers: Answers): boolean {
  return nextQuestions(answers).length === 0;
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/** Normalises a yes/no answer to `yes`, `no` or `unsure`. */
export function normaliseYesNo(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (YES.has(lowered)) return 'yes';
  if (NO.has(lowered)) return 'no';
  return 'unsure';
}

const answersSchema = z.record(z.string(), z.string());

export type ValidatedAnswers =
  | { readonly ok: true; readonly answers: Answers }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Checks an answers file: an object of known question ids to non-empty strings. */
export function validateAnswers(input: unknown): ValidatedAnswers {
  const parsed = answersSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: ['answers must be a JSON object of question id to text'] };
  }
  const errors: string[] = [];
  const answers: Record<string, string> = {};
  for (const [id, raw] of Object.entries(parsed.data)) {
    const question = QUESTIONS.find((q) => q.id === id);
    if (question === undefined) {
      errors.push(`unknown question "${id}"; known: ${QUESTION_IDS.join(', ')}`);
      continue;
    }
    const text = raw.trim();
    if (text === '') {
      errors.push(`the answer to "${id}" is empty`);
      continue;
    }
    answers[id] = question.kind === 'yesno' ? normaliseYesNo(text) : text;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, answers };
}

export interface DomainFile {
  readonly version: 1;
  readonly updated: string;
  readonly complete: boolean;
  /** True when personal data triggers the compliance branch. */
  readonly compliance: boolean;
  readonly answers: Answers;
}

export function buildDomain(answers: Answers, now: Date): DomainFile {
  return {
    version: 1,
    updated: now.toISOString(),
    complete: isComplete(answers),
    compliance: isPiiLikely(answers),
    answers,
  };
}

const domainSchema = z.object({
  version: z.literal(1),
  updated: z.string(),
  complete: z.boolean(),
  compliance: z.boolean(),
  answers: answersSchema,
});

/** Parses the text of a `.sentinel/domain.json`. */
export function parseDomain(text: string, source: string): DomainFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SetupError(`${source} is not valid JSON`);
  }
  const parsed = domainSchema.safeParse(json);
  if (!parsed.success) throw new SetupError(`${source} is not a sentinel domain file`);
  return parsed.data;
}
