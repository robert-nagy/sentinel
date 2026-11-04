import { describe, expect, it } from 'vitest';
import {
  renderCommand,
  tokenizeTemplate,
  validateCommandTemplate,
} from '../../src/core/command-template.js';

describe('tokenizeTemplate', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenizeTemplate(`linear issue view {id} --json --note "a b" 'c d'`)).toEqual([
      'linear',
      'issue',
      'view',
      '{id}',
      '--json',
      '--note',
      'a b',
      'c d',
    ]);
  });
  it('keeps empty quoted arguments', () => {
    expect(tokenizeTemplate(`tool ""`)).toEqual(['tool', '']);
  });
  it('reports unterminated quotes', () => {
    expect(tokenizeTemplate(`tool "oops`)).toContain('unterminated');
  });
});

describe('validateCommandTemplate', () => {
  it('accepts known placeholders', () => {
    expect(validateCommandTemplate('tool {id} {title} {body} {labels}')).toBeUndefined();
  });
  it('rejects unknown placeholders, empty templates and templated executables', () => {
    expect(validateCommandTemplate('tool {nope}')).toContain('unknown placeholder {nope}');
    expect(validateCommandTemplate('   ')).toContain('empty');
    expect(validateCommandTemplate('{id} run')).toContain('executable');
  });
});

describe('renderCommand', () => {
  it('substitutes values without letting them split or add arguments', () => {
    const { command, args } = renderCommand('tool create --title {title} --body={body}', {
      title: 'a b; rm -rf / "x"',
      body: '--evil\nline',
    });
    expect(command).toBe('tool');
    expect(args).toEqual(['create', '--title', 'a b; rm -rf / "x"', '--body=--evil\nline']);
  });
  it('replaces missing values with an empty string', () => {
    expect(renderCommand('tool {id} {state}', { id: '1' }).args).toEqual(['1', '']);
  });
  it('throws for invalid templates', () => {
    expect(() => renderCommand('tool {nope}', {})).toThrow(/unknown placeholder/);
  });
});
