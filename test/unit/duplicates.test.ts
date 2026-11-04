import { describe, expect, it } from 'vitest';
import { rankDuplicates, titleSimilarity } from '../../src/core/duplicates.js';

describe('titleSimilarity / rankDuplicates', () => {
  it('scores identical titles 1 and unrelated titles 0', () => {
    expect(titleSimilarity('Add login page', 'add LOGIN page!')).toBe(1);
    expect(titleSimilarity('Add login page', 'Fix payroll export')).toBe(0);
    expect(titleSimilarity('', 'x y')).toBe(0);
  });
  it('keeps only similar candidates, best first', () => {
    const ranked = rankDuplicates('Add login page', [
      { id: '1', title: 'Fix payroll export' },
      { id: '2', title: 'Add login page for admins' },
      { id: '3', title: 'Add login page' },
    ]);
    expect(ranked.map((i) => i.id)).toEqual(['3', '2']);
  });
});
