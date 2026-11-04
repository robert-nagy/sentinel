import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

/** Replaces `{{NAME}}` placeholders; unknown placeholders are left untouched. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => values[name] ?? match);
}

/** Resolves `dir/file` under `root`, refusing paths that escape the repository. */
export function resolveInside(root: string, dir: string, file: string): string {
  const target = resolve(root, dir, file);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ScaffoldError(`${dir} points outside the repository`);
  }
  return target;
}

/** Writes a new file (creating folders); refuses to overwrite unless `force`. */
export async function writeNewFile(path: string, content: string, force: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ScaffoldError(`${path} already exists (use --force to overwrite)`);
    }
    throw error;
  }
}

/** The trimmed title, or `fallback` when it is missing or blank. */
export function pickTitle(title: string | undefined, fallback: string): string {
  const trimmed = title?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : trimmed;
}
