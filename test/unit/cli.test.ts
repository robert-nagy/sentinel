import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../../src/cli/index.js';
import type { CommandResult } from '../../src/core/exec.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { VERSION } from '../../src/version.js';

const ok = (stdout = ''): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  notFound: false,
  timedOut: false,
});

function harness(
  nodeVersion = '22.11.0',
  tree = new Map<string, string>(),
  respond: (line: string) => CommandResult | undefined = () => undefined,
) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const deps: CliDeps = {
    run: (command, args) => {
      const key = [command, ...args].join(' ');
      const responses: Record<string, CommandResult> = {
        'git --version': ok('git version 2.47.1'),
        'git rev-parse --is-inside-work-tree': ok('true'),
        'gh --version': ok('gh version 2.89.0'),
        'gh auth status': ok(),
      };
      return Promise.resolve(
        respond(key) ??
          responses[key] ?? {
            exitCode: null,
            stdout: '',
            stderr: '',
            notFound: true,
            timedOut: false,
          },
      );
    },
    files: {
      readText: (path) => Promise.resolve(tree.get(path)),
      exists: (path) => Promise.resolve(tree.has(path)),
      listDir: () => Promise.resolve(undefined),
    },
    homeDir: '/home/u',
    env: {},
    now: () => new Date('2026-03-05T12:00:00Z'),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
    nodeVersion,
    platform: 'linux',
    cwd: '/repo',
  };
  return { deps, out, err, exitCode: () => exitCode };
}

const argv = (...args: string[]) => ['node', 'sentinel', ...args];

describe('sentinel CLI', () => {
  it('prints the version', async () => {
    const h = harness();
    const code = await main(argv('--version'), h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toBe(VERSION);
  });

  it('prints help listing the doctor command', async () => {
    const h = harness();
    const code = await main(argv('--help'), h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('doctor');
  });

  it('rejects unknown commands with a non-zero exit code', async () => {
    const h = harness();
    const code = await main(argv('frobnicate'), h.deps);
    expect(code).not.toBe(0);
    expect(h.err.join('\n')).toContain('unknown command');
  });

  it('rejects unknown options on subcommands without exiting the process', async () => {
    const h = harness();
    const code = await main(argv('doctor', '--nope'), h.deps);
    expect(code).not.toBe(0);
    expect(h.err.join('\n')).toContain('unknown option');
  });

  it('doctor --json emits a parseable report and exits 0 when healthy', async () => {
    const h = harness();
    const code = await main(argv('doctor', '--json'), h.deps);
    expect(code).toBe(ExitCode.Ok);
    const report = JSON.parse(h.out.join('\n')) as { ok: boolean; checks: { id: string }[] };
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toContain('node');
  });

  it('doctor exits with Failure when a check fails', async () => {
    const h = harness('20.0.0');
    const code = await main(argv('doctor'), h.deps);
    expect(code).toBe(ExitCode.Failure);
    expect(h.exitCode()).toBe(ExitCode.Failure);
    expect(h.out.join('\n')).toContain('FAILED');
  });

  describe('branch name', () => {
    const repoTree = (config?: unknown) => {
      const tree = new Map<string, string>([[join('/repo', '.git'), '']]);
      if (config !== undefined) {
        tree.set(join('/repo', 'sentinel.config.json'), JSON.stringify(config));
      }
      return tree;
    };

    it('prints the default feature branch name', async () => {
      const h = harness('22.11.0', repoTree());
      const code = await main(
        argv('branch', 'name', '--issue', '#42', '--title', 'Add Login Page!'),
        h.deps,
      );
      expect(code).toBe(0);
      expect(h.out).toEqual(['feat/42-add-login-page']);
    });

    it('infers the type from labels and emits JSON', async () => {
      const h = harness('22.11.0', repoTree());
      await main(argv('branch', 'name', '--issue', '7', '--label', 'kind/bug', '--json'), h.deps);
      const parsed = JSON.parse(h.out.join('\n')) as { name: string; type: string };
      expect(parsed).toMatchObject({ name: 'fix/7', type: 'bugfix' });
    });

    it('uses repo config templates', async () => {
      const h = harness('22.11.0', repoTree({ branches: { feature: '{type}/{date}-{issue_id}' } }));
      await main(argv('branch', 'name', '--issue', 'PROJ-1'), h.deps);
      expect(h.out).toEqual(['feature/20260305-PROJ-1']);
    });

    it('rejects an invalid issue id with exit code 1', async () => {
      const h = harness('22.11.0', repoTree());
      const code = await main(argv('branch', 'name', '--issue', 'a b'), h.deps);
      expect(code).toBe(ExitCode.Failure);
      expect(h.err.join('\n')).toContain('invalid issue id');
    });

    it('rejects an unknown --type', async () => {
      const h = harness('22.11.0', repoTree());
      const code = await main(argv('branch', 'name', '--issue', '1', '--type', 'nope'), h.deps);
      expect(code).toBe(ExitCode.Failure);
    });

    it('exits 5 on invalid config', async () => {
      const h = harness('22.11.0', repoTree({ branches: { feature: 'no-placeholder' } }));
      const code = await main(argv('branch', 'name', '--issue', '1'), h.deps);
      expect(code).toBe(ExitCode.Config);
      expect(h.err.join('\n')).toContain('{issue_id}');
    });
  });

  describe('config', () => {
    it('shows defaults when no config file exists', async () => {
      const h = harness('22.11.0', new Map([[join('/repo', '.git'), '']]));
      const code = await main(argv('config', 'show'), h.deps);
      expect(code).toBe(0);
      const shown = JSON.parse(h.out.join('\n')) as { prd: { threshold: number } };
      expect(shown.prd.threshold).toBe(85);
    });

    it('prints a JSON schema', async () => {
      const h = harness();
      await main(argv('config', 'schema'), h.deps);
      const schema = JSON.parse(h.out.join('\n')) as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties)).toContain('branches');
    });
  });

  describe('pr', () => {
    const repoTree = (config?: unknown) => {
      const tree = new Map<string, string>([[join('/repo', '.git'), '']]);
      if (config !== undefined) {
        tree.set(join('/repo', 'sentinel.config.json'), JSON.stringify(config));
      }
      return tree;
    };
    const prJson = JSON.stringify({
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      title: 'Add login',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'feat/42-add-login',
      baseRefName: 'main',
    });
    const responder =
      (calls: string[], branch = 'feat/42-add-login') =>
      (l: string) => {
        calls.push(l);
        if (l === 'git rev-parse --abbrev-ref HEAD') return ok(`${branch}\n`);
        if (l.startsWith('git push')) return ok();
        if (l.startsWith('gh pr create')) return ok('https://github.com/o/r/pull/9\n');
        if (l.startsWith('gh pr view')) return ok(prJson);
        return undefined;
      };

    it('opens a pull request that closes a GitHub issue', async () => {
      const calls: string[] = [];
      const h = harness(
        '22.11.0',
        repoTree({ issueProvider: { tracker: 'github' } }),
        responder(calls),
      );
      expect(
        await main(argv('pr', 'create', '--issue', '#42', '--title', 'Add login'), h.deps),
      ).toBe(0);
      expect(h.out).toEqual(['https://github.com/o/r/pull/9']);
      expect(calls).toContain('git push --set-upstream origin feat/42-add-login');
      expect(calls.find((c) => c.startsWith('gh pr create'))).toContain('Closes #42');
      expect(h.err).toEqual([]);
    });

    it('references other trackers and hints at linking with the agent tools', async () => {
      const calls: string[] = [];
      const h = harness(
        '22.11.0',
        repoTree({ issueProvider: { tracker: 'jira' } }),
        responder(calls),
      );
      await main(
        argv(
          'pr',
          'create',
          '--issue',
          'PROJ-7',
          '--title',
          'Add login',
          '--issue-url',
          'https://acme.atlassian.net/browse/PROJ-7',
        ),
        h.deps,
      );
      const create = calls.find((c) => c.startsWith('gh pr create')) ?? '';
      expect(create).toContain('Refs PROJ-7: https://acme.atlassian.net/browse/PROJ-7');
      expect(create).not.toContain('Closes');
      expect(h.err.join('\n')).toContain('with your jira tools');
    });

    it('requires a title', async () => {
      const h = harness('22.11.0', repoTree());
      expect(await main(argv('pr', 'create', '--issue', '42'), h.deps)).not.toBe(0);
      expect(h.err.join('\n')).toContain('--title');
    });

    it('refuses to open a pull request from the default branch', async () => {
      const calls: string[] = [];
      const h = harness('22.11.0', repoTree(), responder(calls, 'main'));
      expect(await main(argv('pr', 'create', '--issue', '42', '--title', 'x'), h.deps)).toBe(
        ExitCode.Provider,
      );
      expect(h.err.join('\n')).toContain('into itself');
      expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
    });
  });

  describe('analyze', () => {
    it('reports an empty repo as JSON', async () => {
      const h = harness();
      const code = await main(argv('analyze', '--json'), h.deps);
      expect(code).toBe(0);
      expect(JSON.parse(h.out.join('\n'))).toEqual({ empty: true, projects: [] });
    });
  });
});
