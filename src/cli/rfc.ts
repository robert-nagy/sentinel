import type { Command } from 'commander';
import { normalizeIssueId } from '../core/branch-namer.js';
import { findRepoRoot } from '../core/repo.js';
import { fillTemplate, resolveInside, writeNewFile } from '../core/scaffold.js';
import { RFC_TEMPLATE } from '../templates/rfc-template.js';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

export function registerRfc(program: Command, deps: CliDeps): void {
  const rfc = program.command('rfc').description('Technical design documents (RFCs)');

  rfc
    .command('new')
    .description('Create docs/rfcs/issue-<id>.md from the RFC template')
    .argument('<issue-id>', 'issue the RFC belongs to')
    .option('--title <title>', 'RFC title (default: "Issue <id>")')
    .option('--force', 'overwrite an existing RFC')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (id: string, options: { title?: string; force?: boolean; json?: boolean }) => {
        const issueId = normalizeIssueId(id);
        const { config } = await loadCliConfig(deps);
        const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
        const path = resolveInside(root, config.rfc.dir, `issue-${issueId}.md`);
        const content = fillTemplate(RFC_TEMPLATE, {
          TITLE: options.title?.trim() || `Issue ${issueId}`,
          ISSUE: `#${issueId}`,
          DATE: deps.now().toISOString().slice(0, 10),
        });
        await writeNewFile(path, content, options.force === true);
        deps.stdout(options.json === true ? JSON.stringify({ path }, null, 2) : path);
      }),
    );
}
