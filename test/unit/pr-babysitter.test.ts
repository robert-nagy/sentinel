import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckBucket, CheckRun, CodeHost, PullRequest } from '../../src/core/code-host.js';
import {
  SAME_SIGNATURE_LIMIT,
  babysit,
  babysitStep,
  type BabysitState,
} from '../../src/core/pr-babysitter.js';
import { StateStore } from '../../src/core/state.js';

const PR: PullRequest = {
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  title: 't',
  state: 'open',
  isDraft: false,
  head: 'feat/7',
  base: 'main',
};

const check = (bucket: CheckBucket, runId: string | undefined = '100'): CheckRun => ({
  name: 'ci',
  bucket,
  workflow: 'CI',
  link: runId === undefined ? '' : `https://github.com/o/r/actions/runs/${runId}/job/1`,
  runId,
});

const TSC_LOG = 'ci\tbuild\t2026-01-01T00:00:00Z src/a.ts(1,1): error TS2322: bad type';
const FLAKY_LOG = 'ci\tinstall\t2026-01-01T00:00:00Z npm ERR! code ECONNRESET';

class FakeHost implements CodeHost {
  readonly type = 'fake';
  pr: PullRequest = PR;
  checks: CheckRun[] = [];
  log = TSC_LOG;
  reruns: string[] = [];
  comments: string[] = [];
  createPullRequest(): Promise<PullRequest> {
    throw new Error('unused');
  }
  getPullRequest(): Promise<PullRequest> {
    return Promise.resolve(this.pr);
  }
  listChecks(): Promise<CheckRun[]> {
    return Promise.resolve(this.checks);
  }
  getFailedLogs(): Promise<string> {
    return Promise.resolve(this.log);
  }
  rerunFailed(runId: string): Promise<void> {
    this.reruns.push(runId);
    return Promise.resolve();
  }
  comment(_ref: string, body: string): Promise<void> {
    this.comments.push(body);
    return Promise.resolve();
  }
  hasMergedPullRequest(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

const settings = { maxAttempts: 5 };

describe('babysitStep', () => {
  it('finishes when the pull request is merged or closed', async () => {
    const host = new FakeHost();
    expect((await babysitStep(host, { ...PR, state: 'merged' }, undefined, settings)).action).toBe('done');
    expect((await babysitStep(host, { ...PR, state: 'closed' }, undefined, settings)).action).toBe('done');
  });

  it('waits with no checks and while checks run', async () => {
    const host = new FakeHost();
    expect((await babysitStep(host, PR, undefined, settings)).action).toBe('wait');
    host.checks = [check('pass'), check('pending')];
    expect((await babysitStep(host, PR, undefined, settings)).action).toBe('wait');
  });

  it('is done when every check passed or was skipped', async () => {
    const host = new FakeHost();
    host.checks = [check('pass'), check('skipped')];
    expect((await babysitStep(host, PR, undefined, settings)).action).toBe('done');
  });

  it('hands a deterministic failure to the agent without re-running it', async () => {
    const host = new FakeHost();
    host.checks = [check('fail')];
    const result = await babysitStep(host, PR, undefined, settings);
    expect(result.action).toBe('patch');
    expect(result.packet?.errors[0]).toMatchObject({ file: 'src/a.ts', line: 1 });
    expect(result.attempts).toBe(1);
    expect(host.reruns).toEqual([]);
  });

  it('does not count a repeated request for the same failing run', async () => {
    const host = new FakeHost();
    host.checks = [check('fail')];
    const first = await babysitStep(host, PR, undefined, settings);
    const again = await babysitStep(host, PR, first.state, settings);
    expect(again.action).toBe('patch');
    expect(again.attempts).toBe(1);
  });

  it('re-runs a suspected flaky failure once, then hands it over', async () => {
    const host = new FakeHost();
    host.log = FLAKY_LOG;
    host.checks = [check('fail')];
    const first = await babysitStep(host, PR, undefined, settings);
    expect(first.action).toBe('rerun');
    expect(host.reruns).toEqual(['100']);
    expect(first.attempts).toBe(0);

    // The re-run keeps its run id and fails again.
    const second = await babysitStep(host, PR, first.state, settings);
    expect(second.action).toBe('patch');
    expect(host.reruns).toEqual(['100']);
    expect(second.attempts).toBe(1);
  });

  it('gives up after the attempt budget and comments once', async () => {
    const host = new FakeHost();
    let state: BabysitState | undefined;
    let last = await babysitStep(host, PR, state, { maxAttempts: 2 });
    for (let run = 1; run <= 3; run += 1) {
      host.checks = [check('fail', String(100 + run))];
      host.log = `ci\tb\t2026-01-01T00:00:00Z src/f${String(run)}.ts(1,1): error TS1: distinct ${'x'.repeat(run)}`;
      last = await babysitStep(host, PR, state, { maxAttempts: 2 });
      state = last.state;
      if (last.action === 'give-up') break;
    }
    expect(last.action).toBe('give-up');
    expect(host.comments).toHaveLength(1);
    expect(host.comments[0]).toContain('A human needs to take over');

    const after = await babysitStep(host, PR, last.state, { maxAttempts: 2 });
    expect(after.action).toBe('give-up');
    expect(host.comments).toHaveLength(1);
  });

  it('gives up when the same failure survives repeated fixes', async () => {
    const host = new FakeHost();
    let state: BabysitState | undefined;
    let action = '';
    for (let run = 1; run <= SAME_SIGNATURE_LIMIT + 1; run += 1) {
      host.checks = [check('fail', String(200 + run))];
      const result = await babysitStep(host, PR, state, { maxAttempts: 50 });
      state = result.state;
      action = result.action;
    }
    expect(action).toBe('give-up');
    expect(host.comments[0]).toContain('survived');
  });

  it('gives up on failing checks that have no Actions run', async () => {
    const host = new FakeHost();
    host.checks = [check('fail', undefined)];
    const result = await babysitStep(host, PR, undefined, settings);
    expect(result.action).toBe('give-up');
    expect(host.comments[0]).toContain('not GitHub Actions');
  });
});

describe('babysit', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sentinel-babysit-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const options = (overrides: Partial<Parameters<typeof babysit>[3]> = {}) => ({
    settings,
    pollIntervalSec: 1,
    timeoutMin: 10,
    once: false,
    sleep: () => Promise.resolve(),
    now: () => 0,
    ...overrides,
  });

  it('polls until checks finish', async () => {
    const host = new FakeHost();
    const states = [[check('pending')], [check('pending')], [check('pass')]];
    host.listChecks = () => Promise.resolve(states.shift() ?? [check('pass')]);
    const progress: string[] = [];
    const result = await babysit(host, '7', new StateStore(root), options({ onProgress: (m) => progress.push(m) }));
    expect(result.action).toBe('done');
    expect(progress).toHaveLength(2);
  });

  it('returns a single evaluation in once mode', async () => {
    const host = new FakeHost();
    host.checks = [check('pending')];
    const result = await babysit(host, '7', new StateStore(root), options({ once: true }));
    expect(result.action).toBe('wait');
  });

  it('gives up after the timeout', async () => {
    const host = new FakeHost();
    host.checks = [check('pending')];
    let clock = 0;
    const result = await babysit(
      host,
      '7',
      new StateStore(root),
      options({
        timeoutMin: 1,
        now: () => clock,
        sleep: () => {
          clock += 40_000;
          return Promise.resolve();
        },
      }),
    );
    expect(result.action).toBe('give-up');
    expect(result.reason).toContain('timed out');
  });

  it('keeps its state between invocations', async () => {
    const host = new FakeHost();
    host.checks = [check('fail')];
    const store = new StateStore(root);
    await babysit(host, '7', store, options({ once: true }));
    const saved = await store.read<BabysitState>('babysit-pr-7');
    expect(saved?.attempts).toBe(1);
  });
});
