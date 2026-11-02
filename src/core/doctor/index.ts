import {
  checkGh,
  checkGhAuth,
  checkGit,
  checkGitRepository,
  checkNode,
  checkWindowsLongPaths,
  type CheckResult,
  type CheckStatus,
  type DoctorContext,
} from './checks.js';

export * from './checks.js';

export interface DoctorReport {
  /** False when at least one check failed (warnings do not fail the report). */
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
}

/** git checks, in order. The repository check needs a working git. */
async function gitChecks(ctx: DoctorContext): Promise<CheckResult[]> {
  const git = await checkGit(ctx);
  const results = [git];
  if (git.status === 'pass' || git.status === 'warn') {
    results.push(await checkGitRepository(ctx));
  }
  return results;
}

/** GitHub CLI checks, in order. The auth check needs an installed gh. */
async function ghChecks(ctx: DoctorContext): Promise<CheckResult[]> {
  const gh = await checkGh(ctx);
  return [gh, await checkGhAuth(ctx, gh.status === 'pass')];
}

/**
 * Runs every environment check and aggregates the results. The git and gh
 * groups are independent, so they run concurrently: process start-up is slow on
 * Windows and `gh auth status` talks to the network. The report order is fixed
 * regardless of which group finishes first.
 */
export async function runDoctor(ctx: DoctorContext): Promise<DoctorReport> {
  const [git, gh, longPaths] = await Promise.all([
    gitChecks(ctx),
    ghChecks(ctx),
    checkWindowsLongPaths(ctx),
  ]);
  const checks = [checkNode(ctx), ...git, ...gh, longPaths];

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

const SYMBOLS: Record<CheckStatus, string> = {
  pass: '✔',
  warn: '⚠',
  fail: '✖',
  skip: '-',
};

/** Human-readable rendering of a {@link DoctorReport}. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => {
    const line = `${SYMBOLS[check.status]} ${check.title}: ${check.message}`;
    return check.hint && check.status !== 'pass' ? `${line}\n    → ${check.hint}` : line;
  });
  const counts = report.checks.reduce<Record<CheckStatus, number>>(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { pass: 0, warn: 0, fail: 0, skip: 0 },
  );
  lines.push(
    '',
    `${report.ok ? 'OK' : 'FAILED'}: ${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed, ${counts.skip} skipped`,
  );
  return lines.join('\n');
}
