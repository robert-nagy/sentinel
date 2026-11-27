import { describe, expect, it } from 'vitest';
import { compileGlob, globSpecificity, normalizePath, validateGlob } from '../../src/core/globs.js';

const matches = (glob: string, path: string) => compileGlob(glob).test(normalizePath(path));

describe('compileGlob', () => {
  it('matches ** across directories, including none', () => {
    expect(matches('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'src/core/deep/a.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'test/a.ts')).toBe(false);
    expect(matches('**', 'anything/at/all.md')).toBe(true);
    expect(matches('**/README.md', 'README.md')).toBe(true);
    expect(matches('docs/**', 'docs/adr/0001.md')).toBe(true);
  });

  it('keeps * and ? inside one segment', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/core/a.ts')).toBe(false);
    expect(matches('a?.md', 'ab.md')).toBe(true);
    expect(matches('a?.md', 'a/.md')).toBe(false);
  });

  it('expands braces', () => {
    expect(matches('src/**/*.{ts,tsx}', 'src/ui/x.tsx')).toBe(true);
    expect(matches('src/**/*.{ts,tsx}', 'src/ui/x.js')).toBe(false);
  });

  it('escapes regex characters', () => {
    expect(matches('a+b(1).md', 'a+b(1).md')).toBe(true);
    expect(matches('a.md', 'aXmd')).toBe(false);
  });

  it('accepts Windows separators and a leading ./ in paths', () => {
    expect(matches('src/**/*.ts', 'src\\core\\a.ts')).toBe(true);
    expect(matches('src/*.ts', './src/a.ts')).toBe(true);
  });
});

describe('validateGlob', () => {
  it.each([
    ['', 'empty'],
    ['/etc/*', 'relative'],
    ['C:/x/*', 'relative'],
    ['../x', '..'],
    ['src/[ab].ts', 'character classes'],
    ['!src/**', 'negation'],
    ['src/{a,{b,c}}', 'nested'],
    ['src/{a', 'unbalanced'],
    ['x'.repeat(201), 'long'],
    ['a*/b*/c*/d*/e*/f*/g*/h*/i*', 'wildcards'],
  ])('rejects %j', (glob, word) => {
    expect(validateGlob(glob)).toContain(word);
  });

  it('accepts normal globs and backslashes', () => {
    expect(validateGlob('src/**/*.ts')).toBeUndefined();
    expect(validateGlob('src\\core\\*.ts')).toBeUndefined();
    expect(validateGlob('**')).toBeUndefined();
  });
});

describe('globSpecificity', () => {
  it('counts literal characters, so deeper scopes rank higher', () => {
    expect(globSpecificity('**')).toBe(0);
    expect(globSpecificity('src/core/*.ts')).toBeGreaterThan(globSpecificity('src/**'));
  });
});

describe('glob matching stays fast', () => {
  it('collapses repeated ** so a pathological glob cannot backtrack', () => {
    const glob = `${'**/'.repeat(60)}x.ts`;
    expect(validateGlob(glob)).toBeUndefined();
    const path = `${'a/'.repeat(40)}y.ts`;
    const start = performance.now();
    expect(compileGlob(glob).test(path)).toBe(false);
    expect(compileGlob(glob).test(`${'a/'.repeat(40)}x.ts`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('glob matching cannot be made slow', () => {
  it.each([
    ['*a*a*a*a*a*a*a*b', 'a'.repeat(200)],
    ['{a,a,a,a}*{a,a}*{a,a}*b', 'a'.repeat(200)],
    ['**/*a*a*a*b/**/x', `${'a'.repeat(100)}/`.repeat(8)],
  ])('%s stays fast on a long non-matching path', (glob, path) => {
    expect(validateGlob(glob)).toBeUndefined();
    const start = performance.now();
    expect(compileGlob(glob).test(path)).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('refuses globs that expand to too many alternatives', () => {
    expect(validateGlob('{a,b,c,d}{e,f,g,h}{i,j,k}')).toContain('alternatives');
  });
});
