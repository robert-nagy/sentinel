import type { Command } from 'commander';
import { formatDoctorReport, runDoctor } from '../core/doctor/index.js';
import { ExitCode } from '../core/exit-codes.js';
import type { CliDeps } from './deps.js';

export function registerDoctor(program: Command, deps: CliDeps): void {
  program
    .command('doctor')
    .description('Check that the environment has everything sentinel needs')
    .option('--json', 'output machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await runDoctor({
        run: deps.run,
        nodeVersion: deps.nodeVersion,
        platform: deps.platform,
        cwd: deps.cwd,
      });
      deps.stdout(options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      deps.setExitCode(report.ok ? ExitCode.Ok : ExitCode.Failure);
    });
}
