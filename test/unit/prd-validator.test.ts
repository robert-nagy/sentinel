import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config-schema.js';
import {
  analyzePrd,
  capsFor,
  decide,
  scoresSchema,
  validatePrd,
  ESCALATION_MESSAGE,
  type Scores,
} from '../../src/core/prd-validator.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/prd/${name}.md`, import.meta.url)), 'utf8');
const good = fixture('good');
const borderline = fixture('borderline');
const bad = fixture('bad');

const uniform = (n: number): Scores => ({
  clarity: n,
  testability: n,
  completeness: n,
  security: n,
  feasibility: n,
});
const thresholds = DEFAULT_CONFIG.prd;
const codes = (markdown: string) => analyzePrd(markdown).issues.map((i) => i.code);

describe('golden PRDs', () => {
  it('a good PRD has no structural issues and is accepted with high scores', () => {
    const analysis = analyzePrd(good);
    expect(analysis.issues).toEqual([]);
    expect(analysis.stats).toEqual({
      functionalRequirements: 2,
      nonFunctionalRequirements: 3,
      ambiguousTerms: 0,
    });
    expect(capsFor(analysis)).toEqual(uniform(100));
    const report = validatePrd(good, { scores: uniform(92), config: DEFAULT_CONFIG });
    expect(report).toMatchObject({ nextAction: 'accept', pass: true, mean: 92, min: 92 });
  });

  it('a borderline PRD reports specific gaps and caps the matching dimensions', () => {
    const analysis = analyzePrd(borderline);
    expect(new Set(analysis.issues.map((i) => i.code))).toEqual(
      new Set([
        'ambiguous-term',
        'fr-no-scenario',
        'nfr-unmeasurable',
        'security-input-validation',
        'test-matrix-tier',
      ]),
    );
    const caps = capsFor(analysis);
    expect(caps).toEqual({
      clarity: 85,
      testability: 60,
      completeness: 100,
      security: 65,
      feasibility: 70,
    });
    const gap = analysis.issues.find((i) => i.code === 'fr-no-scenario');
    expect(gap?.message).toContain('FR-2');
    expect(gap?.line).toBeGreaterThan(0);

    // Self-scores of 95 cannot beat the caps: mean (85+60+95+65+70)/5 = 75.
    const report = validatePrd(borderline, { scores: uniform(95), config: DEFAULT_CONFIG });
    expect(report.effectiveScores).toEqual({
      clarity: 85,
      testability: 60,
      completeness: 95,
      security: 65,
      feasibility: 70,
    });
    expect(report.mean).toBe(75);
    expect(report).toMatchObject({ nextAction: 'refine', pass: false, min: 60 });
  });

  it('a bad PRD fails nearly every check and cannot pass whatever the agent scores', () => {
    expect(new Set(codes(bad))).toEqual(
      new Set([
        'missing-context',
        'no-functional-requirements',
        'no-nfr',
        'no-security-section',
        'missing-data-model',
        'missing-api-contract',
        'missing-test-matrix',
        'ambiguous-term',
      ]),
    );
    const unscored = validatePrd(bad, { config: DEFAULT_CONFIG });
    expect(unscored.nextAction).toBe('refine');
    const scored = validatePrd(bad, { scores: uniform(100), config: DEFAULT_CONFIG });
    expect(scored.pass).toBe(false);
    expect(scored.min).toBeLessThan(70);
  });
});

describe('structural checks', () => {
  const withSection = (section: string): string =>
    good.replace(/## 4\. Security[\s\S]*?(?=## 5)/, section);

  it('flags a requirement with an incomplete scenario', () => {
    const md = good.replace(
      '- Then the page shows the latest carrier status and its timestamp\n',
      '',
    );
    expect(codes(md)).toContain('fr-incomplete-scenario');
  });
  it('accepts a single-line Given/When/Then', () => {
    const md = good.replace(
      /- Given a signed-in[\s\S]*?timestamp\n/,
      'Given a customer, when they open the page, then it shows the status.\n',
    );
    expect(codes(md)).not.toContain('fr-no-scenario');
  });
  it('flags duplicate requirement ids', () => {
    expect(codes(good.replace('FR-2:', 'FR-1:'))).toContain('duplicate-requirement-id');
  });
  it('flags missing security topics individually', () => {
    expect(
      codes(withSection('## 4. Security\n\nWe care about safety in general terms here.\n\n')),
    ).toEqual(
      expect.arrayContaining([
        'security-authentication',
        'security-authorization',
        'security-input-validation',
      ]),
    );
  });
  it('flags a missing test tier', () => {
    expect(codes(good.replace(/\| Load[^\n]*\n/, ''))).toContain('test-matrix-tier');
  });
  it('flags unmeasurable NFRs but accepts percentile phrasing', () => {
    expect(codes(good.replace(/- NFR-1:.*\n/, '- NFR-1: The page must load quickly.\n'))).toContain(
      'nfr-unmeasurable',
    );
    expect(
      codes(good.replace('under 200 ms at the 95th percentile', 'p95 under 200 ms')),
    ).not.toContain('nfr-unmeasurable');
  });
  it('ignores ambiguous words inside code fences', () => {
    const md = `${good}\n\`\`\`\nTBD fast etc.\n\`\`\`\n`;
    expect(analyzePrd(md).stats.ambiguousTerms).toBe(0);
  });
  it('grades the clarity cap by the amount of ambiguity', () => {
    const base = analyzePrd(good);
    const words = (n: number) => `${good}\n${'This is fast.\n'.repeat(n)}\n`;
    expect(capsFor(analyzePrd(words(1))).clarity).toBe(85);
    expect(capsFor(analyzePrd(words(3))).clarity).toBe(75);
    expect(capsFor(analyzePrd(words(6))).clarity).toBe(65);
    expect(base.stats.ambiguousTerms).toBe(0);
  });
  it('handles CRLF line endings', () => {
    expect(analyzePrd(good.replace(/\n/g, '\r\n')).issues).toEqual([]);
  });
});

describe('decide', () => {
  const caps = uniform(100);
  it('enforces both the mean and the per-dimension floor', () => {
    expect(decide(caps, { ...uniform(90), security: 69 }, thresholds, 0)).toMatchObject({
      nextAction: 'refine',
      pass: false,
    });
    expect(decide(caps, { ...uniform(85), clarity: 85 }, thresholds, 0).pass).toBe(true);
    expect(decide(caps, uniform(84), thresholds, 0).pass).toBe(false);
  });
  it('allows maxRefinements refinement passes and then escalates', () => {
    const failing = uniform(60);
    expect(decide(caps, failing, thresholds, 0).nextAction).toBe('refine');
    expect(decide(caps, failing, thresholds, 2).nextAction).toBe('refine');
    expect(decide(caps, failing, thresholds, 3).nextAction).toBe('escalate');
  });
  it('asks for self-scores when the structure allows passing but none were given', () => {
    expect(decide(caps, undefined, thresholds, 0).nextAction).toBe('score');
  });
  it('uses the verbatim escalation message', () => {
    const report = validatePrd(bad, {
      scores: uniform(50),
      config: DEFAULT_CONFIG,
      evaluationsBefore: 3,
    });
    expect(report.nextAction).toBe('escalate');
    expect(report.message).toBe(ESCALATION_MESSAGE);
    expect(ESCALATION_MESSAGE).toBe(
      'Confidence threshold not met. Recommended action: Escalate to a higher-reasoning model.',
    );
  });
});

describe('scoresSchema', () => {
  it('requires all five dimensions in range and rejects extras', () => {
    expect(scoresSchema.safeParse(uniform(80)).success).toBe(true);
    expect(scoresSchema.safeParse({ ...uniform(80), clarity: 101 }).success).toBe(false);
    expect(scoresSchema.safeParse({ clarity: 80 }).success).toBe(false);
    expect(scoresSchema.safeParse({ ...uniform(80), extra: 1 }).success).toBe(false);
  });
});
