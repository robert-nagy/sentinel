export { VERSION } from './version.js';
export { ExitCode } from './core/exit-codes.js';
export {
  runCommand,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from './core/exec.js';
export {
  runDoctor,
  formatDoctorReport,
  type CheckResult,
  type CheckStatus,
  type DoctorContext,
  type DoctorReport,
} from './core/doctor/index.js';
export { createProgram, main, type CliDeps } from './cli/index.js';
