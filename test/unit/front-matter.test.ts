import { describe, expect, it } from 'vitest';
import { parseFrontMatter, renderFrontMatter } from '../../src/core/front-matter.js';

describe('parseFrontMatter', () => {
  it('reads JSON-valued fields and the rest of the document', () => {
    const parsed = parseFrontMatter(
      '---\r\nid: "L-1"\r\ntags: ["a", "b"]\r\ncount: 3\r\n---\r\n\r\nBody.\r\n',
    );
    expect(parsed?.fields.get('id')).toBe('L-1');
    expect(parsed?.fields.get('tags')).toEqual(['a', 'b']);
    expect(parsed?.fields.get('count')).toBe('3');
    expect(parsed?.rest).toBe('\nBody.\n');
  });

  it('accepts hand-edited flow sequences and single quotes', () => {
    const parsed = parseFrontMatter("---\nlabels: [a, 'b']\ntitle: 'it''s'\n---\n");
    expect(parsed?.fields.get('labels')).toEqual(['a', 'b']);
    expect(parsed?.fields.get('title')).toBe("it's");
  });

  it('returns undefined without front matter', () => {
    expect(parseFrontMatter('# Title\n')).toBeUndefined();
  });
});

describe('renderFrontMatter', () => {
  it('writes strings and arrays as JSON and skips undefined', () => {
    expect(
      renderFrontMatter([
        ['id', 'L-1'],
        ['tags', ['a']],
        ['pr', undefined],
        ['n', 3],
      ]),
    ).toBe('---\nid: "L-1"\ntags: ["a"]\nn: 3\n---\n');
  });

  it('round-trips through parseFrontMatter', () => {
    const text = renderFrontMatter([['summary', 'Use "quotes": and [brackets]']]);
    expect(parseFrontMatter(text)?.fields.get('summary')).toBe('Use "quotes": and [brackets]');
  });
});
