import { describe, expect, it } from 'vitest';
import {
  BranchNameError,
  inferBranchType,
  isValidBranchName,
  resolveBranchName,
  slugify,
  validateBranchTemplate,
} from '../../src/core/branch-namer.js';
import { DEFAULT_CONFIG } from '../../src/core/config-schema.js';

const NOW = new Date('2026-03-05T23:59:00Z');

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Add Login Page!')).toBe('add-login-page');
  });
  it('folds accents and special letters', () => {
    expect(slugify('Café Straße Łódź')).toBe('cafe-strasse-lodz');
  });
  it('yields an empty slug for non-latin text', () => {
    expect(slugify('日本語')).toBe('');
  });
  it('cuts at a word boundary', () => {
    expect(slugify('implement the very long feature title here', 20)).toBe('implement-the-very');
  });
  it('hard-cuts when there is no usable boundary', () => {
    expect(slugify('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij');
  });
  it('never ends with a hyphen', () => {
    expect(slugify('abcde fghij klmno', 11).endsWith('-')).toBe(false);
  });
});

describe('isValidBranchName', () => {
  it.each(['feat/1-x', 'a', 'release/1.2.3', 'feat/PROJ-1_x'])('accepts %s', (name) => {
    expect(isValidBranchName(name)).toBe(true);
  });
  it.each([
    '',
    '@',
    '-x',
    'a..b',
    'a b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a//b',
    '/a',
    'a/',
    'a.',
    'a.lock',
    'x/.hidden',
    'a@{b',
    'a\u0007b',
    'a'.repeat(201),
  ])('rejects %j', (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});

describe('validateBranchTemplate', () => {
  it('accepts the defaults', () => {
    for (const template of Object.values(DEFAULT_CONFIG.branches)) {
      expect(validateBranchTemplate(template)).toBeUndefined();
    }
  });
  it('rejects unknown placeholders', () => {
    expect(validateBranchTemplate('x/{issue_id}-{nope}')).toContain('unknown placeholder {nope}');
  });
  it('requires {issue_id}', () => {
    expect(validateBranchTemplate('x/{slug}')).toContain('{issue_id}');
  });
  it('rejects unbalanced braces', () => {
    expect(validateBranchTemplate('x/{issue_id}}')).toContain('unbalanced');
    expect(validateBranchTemplate('x/{issue_id}{')).toContain('unbalanced');
  });
  it('rejects empty templates', () => {
    expect(validateBranchTemplate('  ')).toContain('empty');
  });
  it('rejects templates that cannot form a valid branch', () => {
    expect(validateBranchTemplate('x y/{issue_id}')).toContain('valid git branch');
  });
});

describe('inferBranchType', () => {
  it('defaults to feature', () => {
    expect(inferBranchType({})).toBe('feature');
  });
  it('reads labels and issue types', () => {
    expect(inferBranchType({ labels: ['kind/bug'] })).toBe('bugfix');
    expect(inferBranchType({ issueType: 'Bug' })).toBe('bugfix');
    expect(inferBranchType({ labels: ['Refactor'] })).toBe('refactor');
  });
  it('prefers hotfix over bugfix', () => {
    expect(inferBranchType({ labels: ['bug', 'hotfix'] })).toBe('hotfix');
  });
});

describe('resolveBranchName', () => {
  const resolve = (
    issue: Parameters<typeof resolveBranchName>[0]['issue'],
    config = DEFAULT_CONFIG,
    user?: string,
  ) => resolveBranchName({ issue }, config, { now: NOW, user });

  it('renders the default feature template', () => {
    expect(resolve({ id: 42, title: 'Add login' }).name).toBe('feat/42-add-login');
  });
  it('drops the slug segment cleanly when the title is empty', () => {
    expect(resolve({ id: 42 }).name).toBe('feat/42');
  });
  it('accepts jira keys and # prefixes', () => {
    expect(resolve({ id: 'PROJ-123', title: 'x' }).name).toBe('feat/PROJ-123-x');
    expect(resolve({ id: '#9', title: 'x' }).name).toBe('feat/9-x');
  });
  it('rejects hostile issue ids', () => {
    expect(() => resolve({ id: '../etc' })).toThrow(BranchNameError);
    expect(() => resolve({ id: '-rf' })).toThrow(BranchNameError);
    expect(() => resolve({ id: '' })).toThrow(BranchNameError);
  });
  it('supports {user}, {type} and {date}', () => {
    const config = {
      ...DEFAULT_CONFIG,
      branches: { ...DEFAULT_CONFIG.branches, feature: '{user}/{type}/{date}-{issue_id}' },
    };
    expect(resolve({ id: 1 }, config, 'Ada Lovelace').name).toBe('ada-lovelace/feature/20260305-1');
  });
  it('requires a user name when {user} is used', () => {
    const config = {
      ...DEFAULT_CONFIG,
      branches: { ...DEFAULT_CONFIG.branches, feature: '{user}/{issue_id}' },
    };
    expect(() => resolve({ id: 1 }, config)).toThrow(/user name/);
  });
  it('uses the explicit type over inference', () => {
    const r = resolveBranchName(
      { issue: { id: 3, labels: ['bug'] }, type: 'refactor' },
      DEFAULT_CONFIG,
    );
    expect(r).toMatchObject({ type: 'refactor', name: 'refactor/3' });
  });
});
