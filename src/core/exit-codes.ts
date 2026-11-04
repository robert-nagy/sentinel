/**
 * Process exit codes shared by every sentinel command (see docs/PLAN.md §7).
 * Agents rely on these to branch without parsing human-readable output.
 */
export const ExitCode = {
  /** Command succeeded. */
  Ok: 0,
  /** Generic failure (e.g. a `doctor` check failed). */
  Failure: 1,
  /** A quality threshold was not met; the caller should refine and retry. */
  Refine: 2,
  /** Retry budget exhausted; escalate or hand over to a human. */
  Escalate: 3,
  /** Tracker unavailable here / code host / authentication error. */
  Provider: 4,
  /** Invalid or missing configuration. */
  Config: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
