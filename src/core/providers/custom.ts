import { z } from 'zod';
import { renderCommand, validateCommandTemplate } from '../command-template.js';
import type { CommandRunner } from '../exec.js';
import {
  ProviderError,
  rankDuplicates,
  resolveLabels,
  type Issue,
  type IssueProvider,
  type IssueQuery,
  type NewIssue,
  type ProviderCapabilities,
} from '../issue-provider.js';

const template = z.string().superRefine((value, ctx) => {
  const problem = validateCommandTemplate(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

export const customOptionsSchema = z.strictObject({
  commands: z.strictObject({
    getIssue: template,
    listIssues: template.optional(),
    createIssue: template.optional(),
    addComment: template.optional(),
    linkPullRequest: template.optional(),
  }),
  timeoutSec: z.number().int().min(1).max(600).default(60),
});

export type CustomOptions = z.infer<typeof customOptionsSchema>;

const customIssue = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string().optional(),
  labels: z.array(z.string()).optional(),
  url: z.string().optional(),
  issueType: z.string().optional(),
  assignees: z.array(z.string()).optional(),
});

function toIssue(raw: z.infer<typeof customIssue>): Issue {
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body ?? '',
    state: /^(closed|done|resolved)$/i.test(raw.state ?? '') ? 'closed' : 'open',
    labels: raw.labels ?? [],
    url: raw.url ?? '',
    issueType: raw.issueType,
    assignees: raw.assignees ?? [],
  };
}

export interface CustomProviderOptions {
  readonly run: CommandRunner;
  readonly cwd: string;
  readonly options: CustomOptions;
  readonly labelMap?: Readonly<Record<string, string>> | undefined;
}

type Operation = keyof CustomOptions['commands'];

/**
 * Tracker driven by user-configured command templates, for trackers without a built-in
 * provider (Linear, …). Commands run without a shell; `getIssue`/`createIssue` must print
 * one JSON issue and `listIssues` a JSON array of issues.
 */
export class CustomIssueProvider implements IssueProvider {
  readonly type = 'custom';

  constructor(private readonly config: CustomProviderOptions) {}

  private async exec(
    operation: Operation,
    values: Parameters<typeof renderCommand>[1],
  ): Promise<string> {
    const templateText = this.config.options.commands[operation];
    if (templateText === undefined) {
      throw new ProviderError(
        'unsupported',
        `the custom provider has no "${operation}" command configured`,
      );
    }
    const { command, args } = renderCommand(templateText, values);
    const result = await this.config.run(command, args, {
      cwd: this.config.cwd,
      timeoutMs: this.config.options.timeoutSec * 1000,
    });
    if (result.notFound) {
      throw new ProviderError('unavailable', `custom provider command not found: ${command}`);
    }
    if (result.timedOut) {
      throw new ProviderError('unavailable', `custom ${operation} command timed out: ${command}`);
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
      throw new ProviderError(
        'failed',
        `custom ${operation} command failed (exit ${String(result.exitCode)}): ${detail}`,
      );
    }
    return result.stdout;
  }

  private parse<T>(schema: z.ZodType<T>, text: string, operation: Operation): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError('failed', `custom ${operation} command did not print valid JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ProviderError(
        'failed',
        `custom ${operation} output does not match the contract: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
      );
    }
    return parsed.data;
  }

  async getIssue(id: string): Promise<Issue> {
    return toIssue(this.parse(customIssue, await this.exec('getIssue', { id }), 'getIssue'));
  }

  async listIssues(query: IssueQuery = {}): Promise<Issue[]> {
    const out = await this.exec('listIssues', {
      query: query.search ?? '',
      state: query.state ?? 'open',
      labels: resolveLabels(query.labels, this.config.labelMap).join(','),
      limit: String(query.limit ?? 30),
    });
    return this.parse(z.array(customIssue), out, 'listIssues').map(toIssue);
  }

  async createIssue(issue: NewIssue): Promise<Issue> {
    const out = await this.exec('createIssue', {
      title: issue.title,
      body: issue.body,
      labels: resolveLabels(issue.labels, this.config.labelMap).join(','),
    });
    return toIssue(this.parse(customIssue, out, 'createIssue'));
  }

  async addComment(id: string, body: string): Promise<void> {
    await this.exec('addComment', { id, body });
  }

  async linkPullRequest(id: string, prUrl: string): Promise<void> {
    await this.exec('linkPullRequest', { id, url: prUrl });
  }

  async findDuplicates(title: string): Promise<Issue[]> {
    if (this.config.options.commands.listIssues === undefined) return [];
    return rankDuplicates(title, await this.listIssues({ state: 'all', search: title, limit: 10 }));
  }

  capabilities(): ProviderCapabilities {
    const c = this.config.options.commands;
    return {
      createIssue: c.createIssue !== undefined,
      addComment: c.addComment !== undefined,
      linkPullRequest: c.linkPullRequest !== undefined,
      listIssues: c.listIssues !== undefined,
      transitions: false,
    };
  }

  describe(): string {
    const caps = this.capabilities();
    const lines = [
      'Issue tracker: custom (user-configured commands).',
      '- Read an issue: sentinel issue get <id> --json',
    ];
    if (caps.listIssues) lines.push('- Search: sentinel issue list --search "<text>" --json');
    if (caps.createIssue) lines.push('- Create: sentinel issue create --title "..." --body "..."');
    if (caps.addComment) lines.push('- Comment: sentinel issue comment <id> --body "..."');
    if (caps.linkPullRequest) lines.push('- Link a PR: sentinel issue link <id> --pr <url>');
    const missing = (Object.entries(caps) as [string, boolean][])
      .filter(([k, v]) => !v && k !== 'transitions')
      .map(([k]) => k);
    if (missing.length > 0)
      lines.push(`- Not available with this provider: ${missing.join(', ')}.`);
    return lines.join('\n');
  }
}
