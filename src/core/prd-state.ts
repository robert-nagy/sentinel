import type { NextAction, PrdReport } from './prd-validator.js';

export class PrdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrdError';
  }
}

export interface PrdHistoryEntry {
  readonly at: string;
  readonly mean: number;
  readonly min: number;
  readonly nextAction: NextAction;
}

/** Persisted in `.sentinel/state/prd-<slug>.json`. */
export interface PrdState {
  readonly slug: string;
  /** Scored evaluations in the current cycle (a cycle ends when a PRD is accepted). */
  readonly evaluations: number;
  /** Hash of the PRD text and scores of the latest evaluation. */
  readonly lastHash: string;
  readonly history: readonly PrdHistoryEntry[];
}

const MAX_HISTORY = 20;

function cycleFinished(state: PrdState): boolean {
  return state.history.at(-1)?.nextAction === 'accept';
}

/**
 * How many scored evaluations count against the refinement budget for a run with this
 * input. Re-running identical input is idempotent (it does not use up a refinement), and
 * editing an already accepted PRD starts a fresh cycle.
 */
export function evaluationsBefore(state: PrdState | undefined, hash: string): number {
  if (state === undefined) return 0;
  if (state.lastHash === hash) return Math.max(0, state.evaluations - 1);
  return cycleFinished(state) ? 0 : state.evaluations;
}

/** State after a scored evaluation, or the unchanged state for a repeated run. */
export function recordEvaluation(
  state: PrdState | undefined,
  slug: string,
  hash: string,
  report: PrdReport,
  now: Date,
): PrdState {
  if (state?.lastHash === hash) return state;
  const entry: PrdHistoryEntry = {
    at: now.toISOString(),
    mean: report.mean ?? 0,
    min: report.min ?? 0,
    nextAction: report.nextAction,
  };
  const previous = state === undefined || cycleFinished(state) ? [] : state.history;
  return {
    slug,
    evaluations: report.evaluation,
    lastHash: hash,
    history: [...previous, entry].slice(-MAX_HISTORY),
  };
}
