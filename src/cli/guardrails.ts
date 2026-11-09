import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import {
  applyClaudePointer,
  applyGuardrailBlock,
  renderGuardrailBlock,
} from '../core/guardrails.js';
import { findRepoRoot } from '../core/repo.js';
import { VERSION } from '../version.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

type Change = 'created' | 'updated' | 'unchanged';

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export function registerGuardrails(program: Command, deps: CliDeps): void {
  const guardrails = program.command('guardrails').description('Repo-level agent guardrails');

  guardrails
    .command('write')
    .description('Write the managed guardrail block to AGENTS.md (and an @AGENTS.md pointer)')
    .option('--dry-run', 'report what would change without writing')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: { dryRun?: boolean; json?: boolean }) => {
        const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
        const agentsPath = join(root, 'AGENTS.md');
        const claudePath = join(root, 'CLAUDE.md');
        const dryRun = options.dryRun === true;

        const agentsBefore = await deps.files.readText(agentsPath);
        const agentsAfter = applyGuardrailBlock(agentsBefore, renderGuardrailBlock(VERSION));
        const agents: Change =
          agentsBefore === undefined
            ? 'created'
            : agentsBefore === agentsAfter
              ? 'unchanged'
              : 'updated';
        if (agents !== 'unchanged' && !dryRun) await write(agentsPath, agentsAfter);

        const claudeBefore = await deps.files.readText(claudePath);
        let claude: Change | 'absent' = 'absent';
        if (claudeBefore !== undefined) {
          const claudeAfter = applyClaudePointer(claudeBefore);
          claude = claudeAfter === claudeBefore ? 'unchanged' : 'updated';
          if (claude === 'updated' && !dryRun) await write(claudePath, claudeAfter);
        }

        const result = { dryRun, agentsMd: agents, claudeMd: claude, path: agentsPath };
        if (options.json === true) {
          deps.stdout(JSON.stringify(result, null, 2));
        } else {
          const prefix = dryRun ? '(dry run) ' : '';
          deps.stdout(`${prefix}AGENTS.md: ${agents}`);
          deps.stdout(`${prefix}CLAUDE.md: ${claude}`);
        }
      }),
    );
}
