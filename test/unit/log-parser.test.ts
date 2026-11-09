import { describe, expect, it } from 'vitest';
import { parseFailureLog } from '../../src/core/log-parser.js';

describe('parseFailureLog', () => {
  it('reads tsc errors with file and line', () => {
    const packet = parseFailureLog(
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(3,1): error TS2304: Cannot find name 'x'.",
    );
    expect(packet.toolchain).toBe('tsc');
    expect(packet.errors).toHaveLength(2);
    expect(packet.errors[0]).toMatchObject({ file: 'src/a.ts', line: 12 });
    expect(packet.errors[0]?.message).toContain('TS2322');
    expect(packet.suspectedFlaky).toBe(false);
  });

  it('reads eslint stylish output', () => {
    const packet = parseFailureLog(
      [
        '/work/src/a.ts',
        '  10:3  error  Unexpected any  @typescript-eslint/no-explicit-any',
        '  11:1  warning  meh  x',
      ].join('\n'),
    );
    expect(packet.toolchain).toBe('eslint');
    expect(packet.errors).toEqual([
      expect.objectContaining({
        file: '/work/src/a.ts',
        line: 10,
        message: '@typescript-eslint/no-explicit-any: Unexpected any',
      }),
    ]);
  });

  it('reads vitest failures with assertion detail and stack line', () => {
    const packet = parseFailureLog(
      [
        ' FAIL  test/unit/x.test.ts > adds numbers',
        'AssertionError: expected 3 to be 4',
        ' ❯ test/unit/x.test.ts:9:17',
      ].join('\n'),
    );
    expect(packet.toolchain).toBe('vitest/jest');
    expect(packet.errors[0]).toMatchObject({ file: 'test/unit/x.test.ts', line: 9 });
    expect(packet.errors[0]?.message).toBe('adds numbers: expected 3 to be 4');
  });

  it('reads jest failures', () => {
    const packet = parseFailureLog(['FAIL src/x.test.js', '  ● suite › does a thing'].join('\n'));
    expect(packet.errors[0]).toMatchObject({
      file: 'src/x.test.js',
      message: 'suite › does a thing',
    });
  });

  it('reads pytest summaries', () => {
    const packet = parseFailureLog('FAILED tests/test_a.py::test_one - AssertionError: no');
    expect(packet.toolchain).toBe('pytest');
    expect(packet.errors[0]).toMatchObject({ file: 'tests/test_a.py' });
    expect(packet.errors[0]?.message).toContain('test_one');
  });

  it('reads go test and go build errors', () => {
    const packet = parseFailureLog(
      ['--- FAIL: TestX (0.00s)', '    main_test.go:14: got 1, want 2'].join('\n'),
    );
    expect(packet.toolchain).toBe('go');
    expect(packet.errors[0]).toMatchObject({ file: 'main_test.go', line: 14 });
  });

  it('reads dotnet errors', () => {
    const packet = parseFailureLog(
      'src/Program.cs(7,13): error CS0103: The name x does not exist [/w/App.csproj]',
    );
    expect(packet.toolchain).toBe('dotnet');
    expect(packet.errors[0]).toMatchObject({ file: 'src/Program.cs', line: 7 });
    expect(packet.errors[0]?.message).toBe('CS0103: The name x does not exist');
  });

  it('reads cargo errors with their location', () => {
    const packet = parseFailureLog(
      [
        'error[E0308]: mismatched types',
        ' --> src/main.rs:3:5',
        'error: could not compile `app`',
      ].join('\n'),
    );
    expect(packet.toolchain).toBe('cargo');
    expect(packet.errors).toHaveLength(1);
    expect(packet.errors[0]).toMatchObject({ file: 'src/main.rs', line: 3 });
  });

  it('falls back to a generic stack trace', () => {
    const packet = parseFailureLog(
      ['TypeError: x is not a function', '    at run (/app/src/run.js:20:7)'].join('\n'),
    );
    expect(packet.toolchain).toBe('generic');
    expect(packet.errors[0]).toMatchObject({ file: '/app/src/run.js', line: 20 });
  });

  it('keeps the log tail when nothing is recognised', () => {
    const packet = parseFailureLog('step one\nstep two\nsomething odd happened');
    expect(packet.toolchain).toBe('unknown');
    expect(packet.errors[0]?.message).toBe('something odd happened');
  });

  it('strips the gh prefix, timestamps and colours, and collects job names', () => {
    const line =
      'build\tRun tsc\t2026-01-01T10:00:00.0000000Z \u001b[31msrc/a.ts(1,1): error TS1: bad\u001b[0m';
    const packet = parseFailureLog(line);
    expect(packet.jobs).toEqual(['build']);
    expect(packet.errors[0]).toMatchObject({ file: 'src/a.ts', line: 1 });
  });

  it('flags infrastructure failures as suspected flaky', () => {
    expect(
      parseFailureLog('npm ERR! code ECONNRESET\nnpm ERR! network aborted').suspectedFlaky,
    ).toBe(true);
    expect(
      parseFailureLog('src/a.ts(1,1): error TS1: bad\nECONNRESET somewhere').suspectedFlaky,
    ).toBe(false);
  });

  it('gives the same signature when only line numbers and counts change', () => {
    const a = parseFailureLog(
      "src/a.ts(10,1): error TS2322: Type 'string' is not assignable (3 times)",
    );
    const b = parseFailureLog(
      "src/a.ts(42,9): error TS2322: Type 'string' is not assignable (7 times)",
    );
    const c = parseFailureLog(
      "src/b.ts(10,1): error TS2322: Type 'string' is not assignable (3 times)",
    );
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it('caps the number of errors', () => {
    const log = Array.from(
      { length: 50 },
      (_, i) => `src/f${String(i)}.ts(1,1): error TS1: e${String(i)}`,
    ).join('\n');
    expect(parseFailureLog(log).errors).toHaveLength(20);
  });
});
