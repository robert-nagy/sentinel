import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../../src/cli/index.js';
import { parseLabelPairs, splitList } from '../../src/cli/issue.js';
import { DEFAULT_CONFIG } from '../../src/core/config-schema.js';
import { ConfigError } from '../../src/core/config.js';
import type { CommandResult, CommandRunner } from '../../src/core/exec.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { nodeFiles } from '../../src/core/fs.js';
import {
  TrackerError,
  describeTracker,
  detectTrackerHints,
  forgeFromRemote,
  formatTrackerDescription,
  normalizeTracker,
  redactRemote,
  resolveTracker,
  saveTrackerChoice,
} from '../../src/core/issue-tracker.js';

const result = (stdout: string, exitCode = 0): CommandResult => ({
  exitCode,
  stdout,
  stderr: '',
  notFound: false,
  timedOut: false,
});
const missing: CommandResult = {
  exitCode: null,
  stdout: '',
  stderr: '',
  notFound: true,
  timedOut: false,
};

/** A runner that answers from a table keyed by the full command line. */
function runner(table: Record<string, CommandResult>): CommandRunner {
  return (command, args) => Promise.resolve(table[[command, ...args].join(' ')] ?? missing);
}

describe('normalizeTracker', () => {
  it.each([
    ['GitHub', 'github'],
    ['gh', 'github'],
    ['Azure Boards', 'azure-devops'],
    ['ado', 'azure-devops'],
    ['atlassian', 'jira'],
    ['linear', 'linear'],
    ['markdown', 'local'],
    ['you_track', 'you-track'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeTracker(raw)).toBe(expected);
  });

  it('rejects names that are not slugs', () => {
    expect(() => normalizeTracker('jira; rm -rf /')).toThrow(TrackerError);
    expect(() => normalizeTracker('')).toThrow(TrackerError);
  });
});

describe('forgeFromRemote', () => {
  it.each([
    ['https://github.com/robert-nagy/sentinel.git', 'github'],
    ['git@github.com:robert-nagy/sentinel.git', 'github'],
    ['ssh://git@github.mycorp.com/team/app.git', 'github'],
    ['https://gitlab.com/group/app.git', 'gitlab'],
    ['git@gitlab.internal:group/app.git', 'gitlab'],
    ['https://dev.azure.com/org/project/_git/app', 'azure-devops'],
    ['git@ssh.dev.azure.com:v3/org/project/app', 'azure-devops'],
    ['https://org.visualstudio.com/project/_git/app', 'azure-devops'],
    ['https://bitbucket.org/team/app.git', 'bitbucket'],
  ])('%s → %s', (url, forge) => {
    expect(forgeFromRemote(url)).toBe(forge);
  });

  it('returns undefined for unknown hosts and local paths', () => {
    expect(forgeFromRemote('https://git.example.com/app.git')).toBeUndefined();
    expect(forgeFromRemote('/srv/git/app.git')).toBeUndefined();
    expect(forgeFromRemote('../origin.git')).toBeUndefined();
  });
});

describe('redactRemote', () => {
  it('drops credentials from URLs', () => {
    expect(redactRemote('https://x-access-token:secret@github.com/a/b.git')).toBe(
      'https://github.com/a/b.git',
    );
    expect(redactRemote('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
  });
});

describe('resolveTracker', () => {
  it('uses the configured tracker when the caller does not report reachability', () => {
    expect(resolveTracker({ configured: 'jira', remoteForge: 'github' })).toMatchObject({
      action: 'use',
      tracker: 'jira',
      source: 'config',
      offerToSave: false,
    });
  });

  it('uses the configured tracker when it is reachable', () => {
    expect(
      resolveTracker({ configured: 'Linear', available: ['gh', 'linear'], remoteForge: 'github' }),
    ).toMatchObject({ action: 'use', tracker: 'linear', source: 'config' });
  });

  it('always treats a configured local tracker as reachable', () => {
    expect(resolveTracker({ configured: 'local', available: [] })).toMatchObject({
      action: 'use',
      tracker: 'local',
    });
  });

  it('reports a configured tracker the agent cannot reach as unavailable', () => {
    expect(resolveTracker({ configured: 'jira', available: ['github'] })).toMatchObject({
      action: 'unavailable',
      tracker: 'jira',
    });
  });

  it('uses the only reachable tracker when it matches the remote', () => {
    expect(resolveTracker({ configured: null, available: ['gh'], remoteForge: 'github' })).toEqual({
      action: 'use',
      tracker: 'github',
      source: 'detected',
      offerToSave: true,
      reason: 'github is the only reachable tracker and matches the git remote',
    });
  });

  it('uses the only reachable tracker when the remote is not on a forge', () => {
    expect(resolveTracker({ configured: null, available: ['linear'] })).toMatchObject({
      action: 'use',
      tracker: 'linear',
      offerToSave: true,
    });
  });

  it('asks when the only reachable tracker conflicts with the remote forge', () => {
    expect(
      resolveTracker({ configured: null, available: ['linear'], remoteForge: 'github' }),
    ).toMatchObject({
      action: 'ask',
      recommended: 'github',
      options: [
        { tracker: 'github', reachable: false },
        { tracker: 'linear', reachable: true },
        { tracker: 'local', reachable: true },
      ],
    });
  });

  it('asks when several trackers are reachable, recommending the remote forge first', () => {
    expect(
      resolveTracker({
        configured: null,
        available: ['linear', 'jira', 'github', 'gh'],
        remoteForge: 'github',
      }),
    ).toMatchObject({
      action: 'ask',
      recommended: 'github',
      options: [
        { tracker: 'github', reachable: true },
        { tracker: 'jira', reachable: true },
        { tracker: 'linear', reachable: true },
        { tracker: 'local', reachable: true },
      ],
    });
  });

  it('asks without a recommendation when the remote is not on a forge', () => {
    const decision = resolveTracker({ configured: null, available: ['jira', 'linear'] });
    expect(decision).toMatchObject({ action: 'ask', recommended: undefined });
  });

  it('falls back to the local tracker when nothing is reachable', () => {
    expect(resolveTracker({ configured: null, available: [] })).toMatchObject({
      action: 'fallback',
      tracker: 'local',
      offerToSave: true,
    });
    expect(resolveTracker({ configured: null, available: ['local'] })).toMatchObject({
      action: 'fallback',
    });
    expect(resolveTracker({ configured: null })).toMatchObject({ action: 'fallback' });
  });

  it('mentions an unreachable remote forge when falling back', () => {
    const decision = resolveTracker({ configured: null, available: [], remoteForge: 'gitlab' });
    expect(decision.reason).toContain('gitlab');
  });
});

describe('describeTracker', () => {
  it('describes an unconfigured tracker', () => {
    const d = describeTracker(DEFAULT_CONFIG.issueProvider);
    expect(d.tracker).toBeNull();
    expect(d.verbs.map((v) => v.verb)).toEqual([
      'get',
      'list',
      'dedupe',
      'create',
      'comment',
      'set-status',
      'link-pr',
      'close',
    ]);
    expect(formatTrackerDescription(d)).toContain('sentinel issue resolve');
  });

  it('tells the agent to use its own tools for remote trackers', () => {
    const d = describeTracker({
      ...DEFAULT_CONFIG.issueProvider,
      tracker: 'jira',
      location: 'Jira project PROJ',
      labelMap: { 'kind/bug': 'Bug' },
    });
    expect(d.verbs.every((v) => !('command' in v))).toBe(true);
    const text = formatTrackerDescription(d);
    expect(text).toContain('Use your own jira tools');
    expect(text).toContain('Location: Jira project PROJ');
    expect(text).toContain('kind/bug → Bug');
  });

  it('lists CLI commands for the local tracker', () => {
    const d = describeTracker({ ...DEFAULT_CONFIG.issueProvider, tracker: 'local' });
    expect(d.localDir).toBe('docs/issues');
    expect(d.verbs.find((v) => v.verb === 'create')?.command).toContain('sentinel issue create');
  });
});

describe('detectTrackerHints', () => {
  it('reads the origin remote and installed tracker CLIs', async () => {
    const hints = await detectTrackerHints(
      runner({
        'git remote get-url origin': result('https://token@github.com/a/b.git\n'),
        'gh --version': result('gh version 2.89.0'),
        'jira --version': result('', 1),
      }),
      '/repo',
    );
    expect(hints.remote).toEqual({ url: 'https://github.com/a/b.git', forge: 'github' });
    expect(hints.clis.filter((c) => c.installed).map((c) => c.tracker)).toEqual(['github']);
  });

  it('falls back to the first remote when there is no origin', async () => {
    const hints = await detectTrackerHints(
      runner({
        'git remote get-url origin': result('', 2),
        'git remote': result('upstream\nfork\n'),
        'git remote get-url upstream': result('git@gitlab.com:g/app.git'),
      }),
      '/repo',
    );
    expect(hints.remote).toEqual({ url: 'git@gitlab.com:g/app.git', forge: 'gitlab' });
  });

  it('reports no remote when there is none', async () => {
    const hints = await detectTrackerHints(runner({}), '/repo');
    expect(hints.remote).toBeUndefined();
  });
});

describe('CLI option parsing', () => {
  it('splits comma-separated and repeated lists', () => {
    expect(splitList(['github, linear', 'jira', ''])).toEqual(['github', 'linear', 'jira']);
    expect(splitList(undefined)).toBeUndefined();
  });

  it('parses label pairs', () => {
    expect(parseLabelPairs(['kind/bug=Bug', 'status/in-progress=In Progress'])).toEqual({
      'kind/bug': 'Bug',
      'status/in-progress': 'In Progress',
    });
    expect(() => parseLabelPairs(['kind/bug'])).toThrow(TrackerError);
    expect(() => parseLabelPairs(['=Bug'])).toThrow(TrackerError);
  });
});

describe('saveTrackerChoice and the issue CLI', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'sentinel-tracker-'));
    await mkdir(join(repo, '.git'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const configPath = () => join(repo, 'sentinel.config.json');

  it('creates the repo config when there is none', async () => {
    const path = await saveTrackerChoice(repo, repo, nodeFiles, {
      tracker: 'Linear',
      location: 'team ENG',
      labelMap: { 'kind/bug': 'Bug' },
    });
    expect(path).toBe(configPath());
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      issueProvider: { tracker: 'linear', location: 'team ENG', labelMap: { 'kind/bug': 'Bug' } },
    });
  });

  it('keeps other keys and merges the label map', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        $schema: 'x',
        prd: { threshold: 90 },
        issueProvider: { tracker: 'github', notes: 'keep', labelMap: { 'kind/bug': 'bug' } },
      }),
    );
    await saveTrackerChoice(repo, repo, nodeFiles, {
      tracker: 'jira',
      labelMap: { 'kind/feature': 'Story' },
    });
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
      $schema: 'x',
      prd: { threshold: 90 },
      issueProvider: {
        tracker: 'jira',
        notes: 'keep',
        labelMap: { 'kind/bug': 'bug', 'kind/feature': 'Story' },
      },
    });
  });

  it('refuses to overwrite an invalid config', async () => {
    await writeFile(configPath(), '{ not json');
    await expect(saveTrackerChoice(repo, repo, nodeFiles, { tracker: 'jira' })).rejects.toThrow(
      ConfigError,
    );
    await writeFile(configPath(), JSON.stringify({ unknownKey: true }));
    await expect(saveTrackerChoice(repo, repo, nodeFiles, { tracker: 'jira' })).rejects.toThrow(
      /refusing to write/,
    );
  });

  function cli(table: Record<string, CommandResult> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let exitCode: number | undefined;
    const deps: CliDeps = {
      run: runner(table),
      files: nodeFiles,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      setExitCode: (c) => {
        exitCode = c;
      },
      nodeVersion: '22.11.0',
      platform: 'linux',
      cwd: repo,
      homeDir: join(repo, 'home'),
      env: {},
      now: () => new Date('2026-11-04T12:00:00Z'),
    };
    return {
      run: (...args: string[]) => main(['node', 'sentinel', ...args], deps),
      out,
      err,
      exitCode: () => exitCode,
    };
  }

  it('resolves from the reported trackers and the remote', async () => {
    const c = cli({ 'git remote get-url origin': result('git@github.com:a/b.git') });
    await c.run('issue', 'resolve', '--available', 'linear,gh', '--json');
    const decision = JSON.parse(c.out.join('\n')) as { action: string; recommended: string };
    expect(decision).toMatchObject({
      action: 'ask',
      recommended: 'github',
      availableSource: 'reported',
    });
  });

  it('resolves from installed CLIs when nothing is reported', async () => {
    const c = cli({
      'git remote get-url origin': result('https://github.com/a/b.git'),
      'gh --version': result('gh version 2.89.0'),
    });
    await c.run('issue', 'resolve');
    expect(c.out.join('\n')).toMatch(/^use github/);
    expect(c.exitCode()).toBeUndefined();
  });

  it('exits 4 when the configured tracker is unreachable', async () => {
    await writeFile(configPath(), JSON.stringify({ issueProvider: { tracker: 'jira' } }));
    const c = cli();
    await c.run('issue', 'resolve', '--available', 'github');
    expect(c.out.join('\n')).toMatch(/^unavailable jira/);
    expect(c.exitCode()).toBe(ExitCode.Provider);
  });

  it('saves a choice with `issue use` and describes it', async () => {
    const c = cli();
    await c.run(
      'issue',
      'use',
      'atlassian',
      '--location',
      'Jira project PROJ',
      '--label',
      'kind/bug=Bug',
    );
    expect(c.out[0]).toContain('issueProvider.tracker = jira');
    await c.run('issue', 'describe', '--json');
    expect(JSON.parse(c.out[1] ?? '')).toMatchObject({
      tracker: 'jira',
      location: 'Jira project PROJ',
      labelMap: { 'kind/bug': 'Bug' },
    });
  });

  it('runs the local tracker end to end', async () => {
    const c = cli();
    await c.run('issue', 'create', '--title', 'Add login page', '--label', 'kind/feature');
    expect(c.out[0]).toContain('created #1');
    await c.run('issue', 'comment', '1', '--body', 'Started.');
    await c.run('issue', 'label', '1', '--add', 'In Progress');
    await c.run('issue', 'close', '#1');
    await c.run('issue', 'list', '--status', 'all', '--json');
    const [issue] = JSON.parse(c.out.at(-1) ?? '[]') as {
      status: string;
      labels: string[];
      comments: { body: string }[];
    }[];
    expect(issue).toMatchObject({
      status: 'closed',
      labels: ['kind/feature', 'In Progress'],
      comments: [{ body: 'Started.' }],
    });
    const text = await readFile(join(repo, 'docs', 'issues', '1-add-login-page.md'), 'utf8');
    expect(text).toContain('title: "Add login page"');
  });

  it('refuses local commands when issues live in another tracker', async () => {
    await writeFile(configPath(), JSON.stringify({ issueProvider: { tracker: 'linear' } }));
    const c = cli();
    await c.run('issue', 'create', '--title', 'x');
    expect(c.err.join('\n')).toContain('use your own linear tools');
    expect(c.exitCode()).toBe(ExitCode.Provider);
  });

  it('reports a missing local issue with exit 1', async () => {
    const c = cli();
    await c.run('issue', 'get', '7');
    expect(c.err.join('\n')).toContain('no local issue #7');
    expect(c.exitCode()).toBe(ExitCode.Failure);
  });
});
