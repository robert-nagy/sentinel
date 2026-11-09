import type { CheckRun, CodeHost, PullRequest } from './code-host.js';
import { parseFailureLog, type FailurePacket } from './log-parser.js';
import type { StateStore } from './state.js';

/** A failure that survives this many patches is handed to a human. */
export const SAME_SIGNATURE_LIMIT = 3;
const MAX_LOG_RUNS = 3;

export type BabysitAction = 'wait' | 'done' | 'rerun' | 'patch' | 'give-up';

export interface BabysitState {
  readonly pr: number;
  /** Patch packets handed out for runs not seen before. */
  readonly attempts: number;
  readonly signatures: Readonly<Record<string, { readonly seen: number; readonly reran: boolean }>>;
  readonly lastRunIds: readonly string[];
  /** A re-run was requested and its outcome has not been looked at yet. */
  readonly afterRerun: boolean;
  readonly gaveUp: boolean;
}

export interface BabysitResult {
  readonly action: BabysitAction;
  readonly reason: string;
  readonly pr: PullRequest;
  readonly attempts: number;
  readonly packet?: FailurePacket | undefined;
  readonly state: BabysitState;
}

export interface BabysitSettings {
  readonly maxAttempts: number;
}

function initialState(pr: number): BabysitState {
  return { pr, attempts: 0, signatures: {}, lastRunIds: [], afterRerun: false, gaveUp: false };
}

function describe(packet: FailurePacket): string {
  const lines = packet.errors
    .slice(0, 5)
    .map((e) => `- ${e.file === undefined ? '' : `${e.file}${e.line === undefined ? '' : `:${String(e.line)}`}: `}${e.message}`);
  return lines.join('\n');
}

/**
 * One evaluation of a pull request's CI: wait, finish, re-run a flaky failure once, hand the
 * agent a failure packet to patch, or give up. Pure apart from the code host calls; the caller
 * persists the returned state.
 */
export async function babysitStep(
  host: CodeHost,
  pr: PullRequest,
  previous: BabysitState | undefined,
  settings: BabysitSettings,
): Promise<BabysitResult> {
  const state = previous ?? initialState(pr.number);
  const result = (
    action: BabysitAction,
    reason: string,
    next: BabysitState,
    packet?: FailurePacket,
  ): BabysitResult => ({ action, reason, pr, attempts: next.attempts, packet, state: next });

  if (pr.state === 'merged') return result('done', 'the pull request is merged', state);
  if (pr.state === 'closed') return result('done', 'the pull request is closed', state);
  if (state.gaveUp) return result('give-up', 'sentinel already gave up on this pull request', state);

  const checks: CheckRun[] = await host.listChecks(String(pr.number));
  if (checks.length === 0) return result('wait', 'no checks reported yet', state);
  if (checks.some((c) => c.bucket === 'pending')) return result('wait', 'checks are still running', state);

  const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancelled');
  if (failed.length === 0) return result('done', 'all checks passed', state);

  const runIds = [...new Set(failed.map((c) => c.runId).filter((id) => id !== undefined))].sort();
  if (runIds.length === 0) {
    const names = failed.map((c) => c.name).join(', ');
    return giveUp(host, pr, state, `failing checks are not GitHub Actions runs, so there are no logs to read: ${names}`, undefined, result);
  }

  const logs: string[] = [];
  for (const id of runIds.slice(0, MAX_LOG_RUNS)) logs.push(await host.getFailedLogs(id));
  const packet = parseFailureLog(logs.join('\n'), failed.map((c) => c.name));

  const known = state.signatures[packet.signature] ?? { seen: 0, reran: false };
  const sameRuns = runIds.join(',') === state.lastRunIds.join(',');
  const fresh = !sameRuns || state.afterRerun;

  if (!fresh) {
    return result('patch', 'the same failing run as before: push a fix first', state, packet);
  }

  if (known.seen === 0 && !known.reran && packet.suspectedFlaky) {
    for (const id of runIds) await host.rerunFailed(id);
    const next: BabysitState = {
      ...state,
      lastRunIds: runIds,
      afterRerun: true,
      signatures: { ...state.signatures, [packet.signature]: { seen: 1, reran: true } },
    };
    return result('rerun', 'the failure looks like an infrastructure problem: re-ran the failed jobs once', next, packet);
  }

  const seen = known.seen + 1;
  const attempts = state.attempts + 1;
  const next: BabysitState = {
    ...state,
    attempts,
    lastRunIds: runIds,
    afterRerun: false,
    signatures: { ...state.signatures, [packet.signature]: { seen, reran: known.reran } },
  };
  if (attempts > settings.maxAttempts) {
    return giveUp(host, pr, next, `${String(settings.maxAttempts)} fix attempts did not make CI green`, packet, result);
  }
  if (seen > SAME_SIGNATURE_LIMIT) {
    return giveUp(host, pr, next, `the same failure survived ${String(SAME_SIGNATURE_LIMIT)} fixes`, packet, result);
  }
  return result('patch', `CI failed (attempt ${String(attempts)} of ${String(settings.maxAttempts)})`, next, packet);
}

async function giveUp(
  host: CodeHost,
  pr: PullRequest,
  state: BabysitState,
  reason: string,
  packet: FailurePacket | undefined,
  result: (a: BabysitAction, r: string, s: BabysitState, p?: FailurePacket) => BabysitResult,
): Promise<BabysitResult> {
  const body = [
    `sentinel stopped babysitting this pull request: ${reason}.`,
    packet === undefined ? '' : `\nLast failure (${packet.signature}):\n${describe(packet)}`,
    '\nA human needs to take over.',
  ].join('\n');
  await host.comment(String(pr.number), body);
  return result('give-up', reason, { ...state, gaveUp: true }, packet);
}

export interface BabysitOptions {
  readonly settings: BabysitSettings;
  readonly pollIntervalSec: number;
  readonly timeoutMin: number;
  /** Evaluate once and return, even when CI is still running. */
  readonly once: boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly onProgress?: ((message: string) => void) | undefined;
}

/**
 * Evaluates a pull request until there is something for the caller to do. In `once` mode it
 * returns after a single evaluation; otherwise it polls while CI runs (and after a re-run).
 */
export async function babysit(
  host: CodeHost,
  ref: string,
  store: StateStore,
  options: BabysitOptions,
): Promise<BabysitResult> {
  const started = options.now();
  for (;;) {
    const pr = await host.getPullRequest(ref);
    const name = `babysit-pr-${String(pr.number)}`;
    const result = await babysitStep(host, pr, await store.read<BabysitState>(name), options.settings);
    await store.write(name, result.state);
    if (options.once || (result.action !== 'wait' && result.action !== 'rerun')) return result;
    options.onProgress?.(`${result.action}: ${result.reason}`);
    if (options.now() - started > options.timeoutMin * 60_000) {
      return { ...result, action: 'give-up', reason: `timed out after ${String(options.timeoutMin)} minutes` };
    }
    await options.sleep(options.pollIntervalSec * 1000);
  }
}
