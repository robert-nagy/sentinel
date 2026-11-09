import { describe, expect, it } from 'vitest';
import {
  QUESTIONS,
  SetupError,
  buildDomain,
  isComplete,
  isPiiLikely,
  nextQuestions,
  parseDomain,
  toPublic,
  validateAnswers,
} from '../../src/core/socratic-engine.js';

const core = {
  problem: 'Teams lose track of work',
  users: 'Managers, engineers',
  data: 'Tasks and comments',
  scale: '500 users',
};

const ids = (answers: Record<string, string>) => nextQuestions(answers).map((q) => q.id);

describe('nextQuestions', () => {
  it('asks the four core questions first, and only those', () => {
    expect(ids({})).toEqual(['problem', 'users', 'data', 'scale']);
    expect(ids({ problem: 'x' })).toEqual(['users', 'data', 'scale']);
  });

  it('opens the follow-up branches once the core is answered', () => {
    const next = ids(core);
    expect(next).toEqual(
      expect.arrayContaining(['availability', 'authentication', 'journeys', 'integrations', 'pii']),
    );
    expect(next).not.toContain('problem');
  });

  it('asks about integration authentication only when there are integrations', () => {
    expect(ids({ ...core, integrations: 'none' })).not.toContain('integrationAuth');
    expect(ids({ ...core, integrations: 'Stripe, Slack' })).toContain('integrationAuth');
  });

  it('triggers the compliance branch from personal data in the data answer', () => {
    const personal = { ...core, data: 'Customer email addresses and payment cards' };
    expect(isPiiLikely(personal)).toBe(true);
    expect(ids(personal)).toEqual(expect.arrayContaining(['regulations', 'retention']));
    expect(ids(personal)).not.toContain('pii');
  });

  it('asks the PII question when the data answer does not say, and follows the answer', () => {
    expect(ids(core)).toContain('pii');
    expect(ids(core)).not.toContain('regulations');
    expect(ids({ ...core, pii: 'yes' })).toEqual(expect.arrayContaining(['regulations', 'retention']));
    expect(isPiiLikely({ ...core, data: 'customer data', pii: 'no' })).toBe(false);
  });

  it('is complete when every applicable question is answered', () => {
    expect(isComplete({})).toBe(false);
    const all: Record<string, string> = { ...core, integrations: 'none', pii: 'no' };
    for (const q of QUESTIONS) all[q.id] ??= 'answer';
    all.pii = 'no';
    expect(isComplete(all)).toBe(true);
  });
});

describe('validateAnswers', () => {
  it('accepts known ids and normalises yes/no', () => {
    expect(validateAnswers({ problem: ' A ', pii: 'Y' })).toEqual({
      ok: true,
      answers: { problem: 'A', pii: 'yes' },
    });
    expect(validateAnswers({ pii: 'maybe' })).toEqual({ ok: true, answers: { pii: 'unsure' } });
  });

  it('rejects unknown ids, empty answers and non-objects', () => {
    const unknown = validateAnswers({ colour: 'blue' });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.errors[0]).toContain('unknown question "colour"');
    expect(validateAnswers({ problem: '  ' }).ok).toBe(false);
    expect(validateAnswers(['x']).ok).toBe(false);
    expect(validateAnswers({ problem: 3 }).ok).toBe(false);
  });
});

describe('domain file', () => {
  it('round-trips', () => {
    const domain = buildDomain({ ...core, pii: 'yes' }, new Date('2026-01-02T03:04:05Z'));
    expect(domain).toMatchObject({ version: 1, complete: false, compliance: true });
    expect(parseDomain(JSON.stringify(domain), 'x')).toEqual(domain);
  });

  it('rejects text that is not a domain file', () => {
    expect(() => parseDomain('nope', 'domain.json')).toThrow(SetupError);
    expect(() => parseDomain('{"version":2}', 'domain.json')).toThrow('not a sentinel domain file');
  });

  it('hides the trigger function from public questions', () => {
    const question = QUESTIONS.find((q) => q.id === 'integrationAuth');
    expect(question && 'when' in toPublic(question)).toBe(false);
  });
});
