import type { ZodError } from 'zod';
import type { SentinelConfig } from '../config-schema.js';
import type { CommandRunner } from '../exec.js';
import { ProviderError, type IssueProvider } from '../issue-provider.js';
import { ConfigError } from '../config.js';
import { CustomIssueProvider, customOptionsSchema } from './custom.js';
import { GitHubIssueProvider, githubOptionsSchema } from './github.js';

function optionsProblem(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(options)'}: ${i.message}`).join('; ');
}

/** Builds the issue provider selected by `issueProvider.type`. */
export function createIssueProvider(
  config: SentinelConfig['issueProvider'],
  context: { run: CommandRunner; cwd: string },
): IssueProvider {
  switch (config.type) {
    case 'github': {
      const options = githubOptionsSchema.safeParse(config.options);
      if (!options.success) {
        throw new ConfigError(`invalid issueProvider.options for github: ${optionsProblem(options.error)}`);
      }
      return new GitHubIssueProvider({ ...context, repo: options.data.repo, labelMap: config.labelMap });
    }
    case 'custom': {
      const options = customOptionsSchema.safeParse(config.options);
      if (!options.success) {
        throw new ConfigError(`invalid issueProvider.options for custom: ${optionsProblem(options.error)}`);
      }
      return new CustomIssueProvider({ ...context, options: options.data, labelMap: config.labelMap });
    }
    default:
      throw new ProviderError('unsupported', `the ${config.type} issue provider is not implemented yet (planned for a later release)`);
  }
}
