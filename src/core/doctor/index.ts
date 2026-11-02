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

/** Runs every environment check in order and aggregates the results. */
export async function runDoctor(ctx: DoctorContext): Promise<DoctorReport> {
  const checks: CheckResult[] = [checkNode(ctx)];

  const git = await checkGit(ctx);
  checks.push(git);
  if (git.status !== 'fail') {
    checks.push(await checkGitRepository(ctx));
  }

  const gh = await checkGh(ctx);
  checks.push(gh, await checkGhAuth(ctx, gh.status === 'pass'));

  checks.push(await checkWindowsLongPaths(ctx));

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
