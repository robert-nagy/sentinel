import { z } from 'zod';
import { validateBranchTemplate } from './branch-namer.js';

const branchTemplate = z.string().superRefine((value, ctx) => {
  const problem = validateBranchTemplate(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

const relativeDir = z.string().min(1);
const command = z.string().min(1).nullable();
const text = z.string().min(1);

/** Lower-case slug naming a tracker (`github`, `jira`, `linear`, `local`…); see ADR-0005. */
export const TRACKER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const sections = {
  /**
   * Which issue tracker the repo uses, recorded as intent only (ADR-0005). The host agent
   * reaches the tracker with its own tools; `null` means "resolve on first use".
   */
  issueProvider: z.strictObject({
    tracker: z
      .string()
      .regex(TRACKER_SLUG_PATTERN, 'use a lower-case slug such as github, jira, linear or local')
      .nullable(),
    location: text.nullable(),
    notes: text.nullable(),
    /** Neutral label (`kind/bug`, `status/in-progress`) → the tracker's own name for it. */
    labelMap: z.record(text, text),
    /** Directory of the local markdown tracker, relative to the repo root. */
    localDir: relativeDir,
  }),
  codeHost: z.strictObject({
    type: z.literal('github'),
    defaultBranch: z.string().min(1),
  }),
  branches: z.strictObject({
    feature: branchTemplate,
    bugfix: branchTemplate,
    hotfix: branchTemplate,
    refactor: branchTemplate,
  }),
  worktrees: z.strictObject({
    root: relativeDir,
    copyFiles: z.array(z.string().min(1)),
  }),
  prd: z.strictObject({
    dir: relativeDir,
    threshold: z.number().min(0).max(100),
    dimensionFloor: z.number().min(0).max(100),
    maxRefinements: z.number().int().min(0).max(20),
  }),
  rfc: z.strictObject({ dir: relativeDir }),
  babysit: z.strictObject({
    maxAttempts: z.number().int().min(1).max(50),
    pollIntervalSec: z.number().int().min(5).max(3600),
    timeoutMin: z.number().int().min(1).max(1440),
  }),
  testing: z.strictObject({
    unit: command,
    integration: command,
    e2e: command,
    load: command,
  }),
} as const;

/** The fully resolved configuration (defaults applied). */
export const configSchema = z
  .strictObject({
    issueProvider: sections.issueProvider,
    codeHost: sections.codeHost,
    branches: sections.branches,
    worktrees: sections.worktrees,
    prd: sections.prd,
    rfc: sections.rfc,
    babysit: sections.babysit,
    testing: sections.testing,
  })
  .superRefine((config, ctx) => {
    if (config.prd.dimensionFloor > config.prd.threshold) {
      ctx.addIssue({
        code: 'custom',
        path: ['prd', 'dimensionFloor'],
        message: 'dimensionFloor must not exceed threshold',
      });
    }
  });

export type SentinelConfig = z.infer<typeof configSchema>;

/** What a user may write in `sentinel.config.json`: every section and field is optional. */
export const userConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  issueProvider: sections.issueProvider.partial().optional(),
  codeHost: sections.codeHost.partial().optional(),
  branches: sections.branches.partial().optional(),
  worktrees: sections.worktrees.partial().optional(),
  prd: sections.prd.partial().optional(),
  rfc: sections.rfc.partial().optional(),
  babysit: sections.babysit.partial().optional(),
  testing: sections.testing.partial().optional(),
});

export type UserConfig = z.infer<typeof userConfigSchema>;

export const DEFAULT_CONFIG: SentinelConfig = {
  issueProvider: {
    tracker: null,
    location: null,
    notes: null,
    labelMap: {},
    localDir: 'docs/issues',
  },
  codeHost: { type: 'github', defaultBranch: 'main' },
  branches: {
    feature: 'feat/{issue_id}-{slug}',
    bugfix: 'fix/{issue_id}',
    hotfix: 'hotfix/{issue_id}-{slug}',
    refactor: 'refactor/{issue_id}-{slug}',
  },
  worktrees: { root: '.worktrees', copyFiles: ['.env.example'] },
  prd: { dir: 'docs/prd', threshold: 85, dimensionFloor: 70, maxRefinements: 3 },
  rfc: { dir: 'docs/rfcs' },
  babysit: { maxAttempts: 5, pollIntervalSec: 30, timeoutMin: 60 },
  testing: { unit: null, integration: null, e2e: null, load: null },
};

/** JSON Schema for `sentinel.config.json`, for editor completion and validation. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(userConfigSchema);
}
