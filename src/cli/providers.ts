import { GitHubCodeHost } from '../core/hosts/github.js';
import type { CodeHost } from '../core/code-host.js';
import type { SentinelConfig } from '../core/config-schema.js';
import type { IssueProvider } from '../core/issue-provider.js';
import { createIssueProvider } from '../core/providers/index.js';
import { loadCliConfig } from './common.js';
import type { CliDeps } from './deps.js';

export interface Services {
  readonly config: SentinelConfig;
  readonly issues: IssueProvider;
  readonly host: CodeHost;
}

/** Loads the configuration and builds the issue provider and code host it selects. */
export async function createServices(deps: CliDeps): Promise<Services> {
  const { config } = await loadCliConfig(deps);
  const context = { run: deps.run, cwd: deps.cwd };
  return {
    config,
    issues: createIssueProvider(config.issueProvider, context),
    host: new GitHubCodeHost(context),
  };
}
