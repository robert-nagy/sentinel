#!/usr/bin/env node
import { main } from '../cli/index.js';

try {
  await main(process.argv);
} catch (error) {
  process.stderr.write(`sentinel: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
