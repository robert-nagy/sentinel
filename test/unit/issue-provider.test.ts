import { describe, expect, it } from 'vitest';
import {
  rankDuplicates,
  resolveLabels,
  titleSimilarity,
  type Issue,
} from '../../src/core/issue-provider.js';

const issue = (id: string, title: string): Issue => ({
  id,
  title,
  body: '',
  state: 'open',
  labels: [],
  url: '',
  assignees: [],
});

describe('resolveLabels', () => {
  it('maps logical names and passes unknown ones through, de-duplicated', () => {
    expect(resolveLabels(['bug', 'x', 'bug'], { bug: 'kind/bug' })).toEqual(['kind/bug', 'x']);
  });
  it('handles missing input', () => {
    expect(resolveLabels(undefined, undefined)).toEqual([]);
  });
});

describe('titleSimilarity / rankDuplicates', () => {
  it('scores identical titles 1 and unrelated titles 0', () => {
    expect(titleSimilarity('Add login page', 'add LOGIN page!')).toBe(1);
    expect(titleSimilarity('Add login page', 'Fix payroll export')).toBe(0);
    expect(titleSimilarity('', 'x y')).toBe(0);
  });
  it('keeps only similar candidates, best first', () => {
    const ranked = rankDuplicates('Add login page', [
      issue('1', 'Fix payroll export'),
      issue('2', 'Add login page for admins'),
      issue('3', 'Add login page'),
    ]);
    expect(ranked.map((i) => i.id)).toEqual(['3', '2']);
  });
});
