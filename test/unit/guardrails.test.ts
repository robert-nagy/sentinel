import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';
import {
  BLOCK_END,
  GUARDRAIL_RULES,
  GuardrailError,
  applyClaudePointer,
  applyGuardrailBlock,
  renderGuardrailBlock,
} from '../../src/core/guardrails.js';

const block = renderGuardrailBlock('1.2.3');

describe('applyGuardrailBlock', () => {
  it('creates the file content when there is none', () => {
    expect(applyGuardrailBlock(undefined, block)).toBe(`${block}\n`);
    expect(applyGuardrailBlock('  \n', block)).toBe(`${block}\n`);
  });

  it('appends after existing text and keeps it', () => {
    const result = applyGuardrailBlock('# Project\n\nBe nice.\n', block);
    expect(result.startsWith('# Project\n\nBe nice.\n\n<!-- sentinel:managed v1.2.3 -->')).toBe(
      true,
    );
    expect(result.endsWith(`${BLOCK_END}\n`)).toBe(true);
  });

  it('replaces only the managed block, including the version marker', () => {
    const first = applyGuardrailBlock('# Project\n', renderGuardrailBlock('1.0.0'));
    const tail = '\n\n## Notes\nkeep me\n';
    const second = applyGuardrailBlock(first.trimEnd() + tail, block);
    expect(second).toContain('v1.2.3');
    expect(second).not.toContain('v1.0.0');
    expect(second).toContain('# Project');
    expect(second.endsWith(tail)).toBe(true);
  });

  it('is idempotent', () => {
    const once = applyGuardrailBlock('# Project\n', block);
    expect(applyGuardrailBlock(once, block)).toBe(once);
  });

  it('keeps CRLF line endings', () => {
    const result = applyGuardrailBlock('# Project\r\n', block);
    expect(result).toContain('\r\n## Sentinel guardrails\r\n');
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('refuses unbalanced markers', () => {
    expect(() => applyGuardrailBlock('<!-- sentinel:managed v1 -->\nno end', block)).toThrow(
      GuardrailError,
    );
    expect(() => applyGuardrailBlock(`text\n${BLOCK_END}`, block)).toThrow(GuardrailError);
  });
});

describe('applyClaudePointer', () => {
  it('adds the import once', () => {
    const once = applyClaudePointer('# Claude\n');
    expect(once).toBe('# Claude\n\n@AGENTS.md\n');
    expect(applyClaudePointer(once)).toBe(once);
  });

  it('handles an empty file', () => {
    expect(applyClaudePointer('')).toBe('@AGENTS.md\n');
  });
});

describe('the Cursor rule', () => {
  it('is always on and carries every guardrail', async () => {
    const rule = await readFile(
      fileURLToPath(
        new URL('../../plugins/sentinel/rules/sentinel-guardrails.mdc', import.meta.url),
      ),
      'utf8',
    );
    expect(rule).toContain('alwaysApply: true');
    for (const guardrail of GUARDRAIL_RULES) expect(rule).toContain(guardrail);
  });
});

describe('sentinel guardrails write', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'sentinel-guardrails-'));
    await mkdir(join(repo, '.git'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function cli() {
    const out: string[] = [];
    const deps = {
      run: runCommand,
      files: nodeFiles,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => out.push(t),
      setExitCode: () => undefined,
      nodeVersion: process.versions.node,
      platform: process.platform,
      cwd: repo,
      homeDir: repo,
      env: {},
      now: () => new Date('2026-03-05T12:00:00Z'),
    };
    return { out, run: (...args: string[]) => main(['node', 'sentinel', ...args], deps) };
  }

  it('creates AGENTS.md and leaves CLAUDE.md absent', async () => {
    const { run, out } = cli();
    expect(await run('guardrails', 'write', '--json')).toBe(0);
    expect(JSON.parse(out.join('')) as unknown).toMatchObject({
      agentsMd: 'created',
      claudeMd: 'absent',
    });
    expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toContain('Never force-push.');
  });

  it('adds the pointer to an existing CLAUDE.md, and a second run changes nothing', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '# Claude\n', 'utf8');
    const first = cli();
    await first.run('guardrails', 'write');
    expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');

    const second = cli();
    await second.run('guardrails', 'write', '--json');
    expect(JSON.parse(second.out.join('')) as unknown).toMatchObject({
      agentsMd: 'unchanged',
      claudeMd: 'unchanged',
    });
  });

  it('--dry-run reports without writing', async () => {
    const { run, out } = cli();
    await run('guardrails', 'write', '--dry-run');
    expect(out.join('\n')).toContain('(dry run) AGENTS.md: created');
    await expect(readFile(join(repo, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });

  it('exits 1 on unbalanced markers and leaves the file alone', async () => {
    await writeFile(join(repo, 'AGENTS.md'), '<!-- sentinel:managed v1 -->\n', 'utf8');
    const codes: number[] = [];
    const out: string[] = [];
    const deps = {
      run: runCommand,
      files: nodeFiles,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => out.push(t),
      setExitCode: (c: number) => codes.push(c),
      nodeVersion: process.versions.node,
      platform: process.platform,
      cwd: repo,
      homeDir: repo,
      env: {},
      now: () => new Date(),
    };
    await main(['node', 'sentinel', 'guardrails', 'write'], deps);
    expect(codes).toContain(1);
    expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toBe('<!-- sentinel:managed v1 -->\n');
  });
});
