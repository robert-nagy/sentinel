import { z } from 'zod';
import { findSecrets } from './issue-format.js';
import {
  ECOSYSTEMS,
  plannedProject,
  type Ecosystem,
  type ProjectReport,
} from './stack-analyzer.js';

/**
 * The project's stack and architecture decision (issue #44): decided with the user during
 * `sentinel setup`, checked here and recorded in the target repository, so the SDLC skills and
 * the reviewer can hold later work to it. sentinel never proposes the decision itself (ADR-0002);
 * the host agent proposes and the user chooses.
 */

export const ARCHITECTURE_FILE = '.sentinel/architecture.json';
export const ADR_DIR = 'docs/adr';
export const ADR_SLUG = 'stack-and-architecture';

export const DDD_LEVELS = ['none', 'tactical', 'strategic'] as const;
export type DddLevel = (typeof DDD_LEVELS)[number];

const DDD_MEANING: Readonly<Record<DddLevel, string>> = {
  none: 'none',
  tactical: 'tactical (entities, value objects and aggregates in code)',
  strategic: 'strategic and tactical (bounded contexts as modules, plus the tactical patterns)',
};

export const LIMITS = {
  layers: 10,
  frameworks: 10,
  principles: 10,
  alternatives: 4,
  folders: 40,
  short: 60,
  style: 120,
  purpose: 200,
  long: 600,
} as const;

/**
 * `missing-file`: no decision is recorded; `invalid-file`: the recorded file does not parse;
 * `invalid`: an option or input is wrong.
 */
export type ArchitectureErrorKind = 'missing-file' | 'invalid-file' | 'invalid';

export class ArchitectureError extends Error {
  constructor(
    message: string,
    readonly kind: ArchitectureErrorKind = 'invalid',
  ) {
    super(message);
    this.name = 'ArchitectureError';
  }
}

const MANAGED_MARKER = /sentinel:managed/i;
const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/;

/** A relative path with `/` separators, without `.`/`..` segments; a trailing `/` is dropped. */
export function normalizeRelativePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed.startsWith('/')) return undefined;
  const segments = trimmed.split('/');
  if (segments.some((s) => s === '.' || s === '..' || !SEGMENT.test(s))) return undefined;
  return segments.join('/');
}

/** Text that is safe to record: no secrets, no managed markers, optionally one line. */
function text(max: number, options: { singleLine?: boolean } = {}) {
  return z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(max, `must be at most ${String(max)} characters`)
    .superRefine((value, ctx) => {
      if (options.singleLine !== false && /[\r\n]/.test(value)) {
        ctx.addIssue({ code: 'custom', message: 'must be a single line' });
      }
      if (findSecrets(value).length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'looks like it contains a secret; remove it',
        });
      }
      if (MANAGED_MARKER.test(value)) {
        ctx.addIssue({ code: 'custom', message: 'must not contain sentinel:managed' });
      }
    });
}

const relativePath = z.string().transform((value, ctx) => {
  const normalized = normalizeRelativePath(value);
  if (normalized === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be a relative path with / separators and no . or .. segments',
    });
    return z.NEVER;
  }
  return normalized;
});

const layerSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be a lower-case slug such as backend or web-app'),
  path: relativePath.optional(),
  ecosystem: z.enum(ECOSYSTEMS as [Ecosystem, ...Ecosystem[]]).optional(),
  language: text(LIMITS.short),
  frameworks: z.array(text(LIMITS.short)).max(LIMITS.frameworks),
});

const inputSchema = z
  .strictObject({
    layers: z.array(layerSchema).min(1, 'name at least one layer').max(LIMITS.layers),
    architecture: z.strictObject({
      style: text(LIMITS.style),
      ddd: z.enum(DDD_LEVELS),
      principles: z.array(text(LIMITS.short)).max(LIMITS.principles),
      rationale: text(LIMITS.long, { singleLine: false }),
    }),
    alternatives: z
      .array(z.strictObject({ style: text(LIMITS.style), reason: text(LIMITS.long) }))
      .min(1, 'record at least one architecture that was not chosen, with the reason')
      .max(LIMITS.alternatives),
    folders: z
      .array(z.strictObject({ path: relativePath, purpose: text(LIMITS.purpose) }))
      .min(1, 'name at least one folder')
      .max(LIMITS.folders),
  })
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    for (const layer of value.layers) {
      if (names.has(layer.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['layers'],
          message: `duplicate name "${layer.name}"`,
        });
      }
      names.add(layer.name);
    }
    const built = value.layers.filter((layer) => layer.ecosystem !== undefined);
    const owners = new Map<string, string>();
    value.layers.forEach((layer, index) => {
      if (layer.ecosystem === undefined) return;
      if (layer.path === undefined) {
        if (built.length > 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['layers', index, 'path'],
            message:
              'required when more than one layer has an ecosystem (the workflows need a working directory for each)',
          });
        }
        return;
      }
      const owner = owners.get(layer.path);
      if (owner !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['layers', index, 'path'],
          message: `"${layer.path}" is already used by layer "${owner}"`,
        });
      }
      owners.set(layer.path, layer.name);
    });
    const folders = new Set<string>();
    for (const folder of value.folders) {
      if (folders.has(folder.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['folders'],
          message: `duplicate path "${folder.path}"`,
        });
      }
      folders.add(folder.path);
    }
  });

export type DecisionInput = z.output<typeof inputSchema>;
export type Layer = DecisionInput['layers'][number];

const decisionSchema = z.strictObject({
  version: z.literal(1),
  decidedAt: z.iso.datetime(),
  adr: relativePath,
  layers: z.array(layerSchema),
  architecture: inputSchema.shape.architecture,
  alternatives: inputSchema.shape.alternatives,
  folders: inputSchema.shape.folders,
});

export type ArchitectureDecision = z.output<typeof decisionSchema>;

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

export type DecisionCheck =
  | { readonly ok: true; readonly decision: DecisionInput }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Checks a decision the host agent wrote (without `version`, `decidedAt` and `adr`). */
export function validateDecision(value: unknown): DecisionCheck {
  const parsed = inputSchema.safeParse(value);
  if (parsed.success) return { ok: true, decision: parsed.data };
  return { ok: false, problems: formatIssues(parsed.error.issues) };
}

/** The recorded form: the checked input plus the fields sentinel owns. */
export function buildDecision(input: DecisionInput, now: Date, adr: string): ArchitectureDecision {
  return { version: 1, decidedAt: now.toISOString(), adr, ...input };
}

/** Reads a recorded decision; throws an `invalid-file` {@link ArchitectureError}. */
export function parseDecision(textValue: string, label: string): ArchitectureDecision {
  let json: unknown;
  try {
    json = JSON.parse(textValue);
  } catch {
    throw new ArchitectureError(`${label} is not valid JSON`, 'invalid-file');
  }
  const parsed = decisionSchema.safeParse(json);
  if (!parsed.success) {
    throw new ArchitectureError(
      `${label} is invalid: ${formatIssues(parsed.error.issues).join('; ')}`,
      'invalid-file',
    );
  }
  return parsed.data;
}

/**
 * Where the ADR goes, given the entries of `docs/adr/` (or `undefined` when it does not exist):
 * the existing stack-and-architecture ADR if there is one, else the next free number.
 */
export function nextAdrPath(names: readonly string[] | undefined): string {
  const numbered = (names ?? [])
    .map((name) => /^(\d{4})-(.+)\.md$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null);
  const existing = numbered.find((match) => match[2] === ADR_SLUG);
  if (existing !== undefined) return `${ADR_DIR}/${existing[0]}`;
  const highest = numbered.reduce((max, match) => Math.max(max, Number(match[1])), 0);
  return `${ADR_DIR}/${String(highest + 1).padStart(4, '0')}-${ADR_SLUG}.md`;
}

function cell(value: string): string {
  return value === '' ? '—' : value.replace(/\|/g, '\\|');
}

/** The ADR for people; `.sentinel/architecture.json` stays the source sentinel reads. */
export function renderDecisionAdr(decision: ArchitectureDecision): string {
  const number = /(\d{4})-[^/]*$/.exec(decision.adr)?.[1] ?? '0001';
  const { architecture } = decision;
  const lines = [
    `# ADR-${number}: Stack and architecture`,
    '',
    '- **Status:** Accepted',
    `- **Date:** ${decision.decidedAt.slice(0, 10)}`,
    `- **Recorded in:** \`${ARCHITECTURE_FILE}\`, which sentinel reads; this file is generated from it`,
    '',
    '## Context',
    '',
    'The stack, the architecture and the folder layout were decided with the project owner during',
    '`sentinel setup`, before any feature work, so that no pull request makes these choices on its',
    'own and later work can be checked against them.',
    '',
    '## Decision',
    '',
    `**Architecture:** ${architecture.style}`,
    '',
    `**Domain-driven design:** ${DDD_MEANING[architecture.ddd]}`,
    '',
    ...(architecture.principles.length > 0
      ? [`**Principles:** ${architecture.principles.join(', ')}`, '']
      : []),
    architecture.rationale,
    '',
    '### Stack',
    '',
    '| Layer | Language | Frameworks | Path |',
    '| --- | --- | --- | --- |',
    ...decision.layers.map(
      (layer) =>
        `| ${cell(layer.name)} | ${cell(layer.language)} | ${cell(layer.frameworks.join(', '))} | ${
          layer.path === undefined ? '—' : `\`${layer.path}\``
        } |`,
    ),
    '',
    '### Folder layout',
    '',
    ...decision.folders.map((folder) => `- \`${folder.path}\`: ${folder.purpose}`),
    '',
    '## Alternatives considered',
    '',
    ...decision.alternatives.map((alt) => `- **${alt.style}**: ${alt.reason}`),
    '',
    '## Consequences',
    '',
    'Every RFC names this decision and calls out any departure from it, and the sentinel reviewer',
    'flags pull requests that drift from it. To change the decision, run `sentinel setup',
    '--architecture <file> --force` with the new decision; it rewrites this ADR.',
    '',
  ];
  return lines.join('\n');
}

/** The projects the decision plans, for workflows before any code exists. */
export function plannedProjects(decision: ArchitectureDecision): ProjectReport[] {
  return decision.layers.flatMap((layer) => {
    if (layer.ecosystem === undefined) return [];
    const project = plannedProject(layer.ecosystem, layer.path ?? '.');
    return [{ ...project, language: layer.language, frameworks: [...layer.frameworks] }];
  });
}

export interface PlannedStack {
  readonly ecosystem: Ecosystem;
  readonly path: string;
}

/**
 * Parses `--stack`: one bare ecosystem (the repository root), or `<ecosystem>:<path>` entries
 * separated by commas, for example `dotnet:src/backend,node:src/web`.
 */
export function parseStackOption(value: string): PlannedStack[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) throw new ArchitectureError('--stack is empty');
  const stacks: PlannedStack[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const name = colon === -1 ? entry : entry.slice(0, colon);
    if (!(ECOSYSTEMS as readonly string[]).includes(name)) {
      throw new ArchitectureError(`unknown stack "${name}"; choose from ${ECOSYSTEMS.join(', ')}`);
    }
    let path = '.';
    if (colon !== -1) {
      const normalized = normalizeRelativePath(entry.slice(colon + 1));
      if (normalized === undefined) {
        throw new ArchitectureError(
          `--stack ${entry}: the path must be relative, with / separators and no . or .. segments`,
        );
      }
      path = normalized;
    } else if (entries.length > 1) {
      throw new ArchitectureError(
        '--stack lists several ecosystems: give each a path, for example dotnet:src/backend,node:src/web',
      );
    }
    if (seen.has(path)) throw new ArchitectureError(`--stack: "${path}" is used twice`);
    seen.add(path);
    stacks.push({ ecosystem: name as Ecosystem, path });
  }
  return stacks;
}

/** Plain-text summary for `sentinel architecture show`. */
export function formatDecision(decision: ArchitectureDecision): string {
  const { architecture } = decision;
  return [
    `architecture: ${architecture.style}`,
    `ddd: ${architecture.ddd}`,
    ...(architecture.principles.length > 0
      ? [`principles: ${architecture.principles.join(', ')}`]
      : []),
    'layers:',
    ...decision.layers.map((layer) => {
      const frameworks = layer.frameworks.length > 0 ? ` (${layer.frameworks.join(', ')})` : '';
      const at = layer.path === undefined ? '' : ` at ${layer.path}`;
      const eco = layer.ecosystem === undefined ? '' : ` [${layer.ecosystem}]`;
      return `  ${layer.name}: ${layer.language}${frameworks}${at}${eco}`;
    }),
    'folders:',
    ...decision.folders.map((folder) => `  ${folder.path}: ${folder.purpose}`),
    `adr: ${decision.adr}`,
    `decided: ${decision.decidedAt.slice(0, 10)}`,
  ].join('\n');
}
