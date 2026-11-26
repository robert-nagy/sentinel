import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

/** JSON state kept under `<repoRoot>/.sentinel/state/<name>.json` (git-ignored). */
export class StateStore {
  readonly dir: string;

  constructor(repoRoot: string) {
    this.dir = join(repoRoot, '.sentinel', 'state');
  }

  private pathFor(name: string): string {
    if (!NAME_PATTERN.test(name) || name.includes('..')) {
      throw new StateError(`invalid state name "${name}"`);
    }
    return join(this.dir, `${name}.json`);
  }

  async read<T = unknown>(name: string): Promise<T | undefined> {
    const path = this.pathFor(name);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new StateError(`state file ${path} is corrupt; delete it to reset`);
    }
  }

  /** Atomic write: temp file in the same directory, then rename. */
  async write(name: string, value: unknown): Promise<void> {
    const path = this.pathFor(name);
    await this.ensureDir();
    const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /**
   * Creates the state directory with a `.gitignore` that ignores everything in it, so state
   * is never committed even in repositories whose own `.gitignore` does not mention it.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const ignore = join(this.dir, '.gitignore');
    try {
      await writeFile(ignore, '# sentinel state: local to this machine, never committed.\n*\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /** Names (without `.json`) of the state files that start with `prefix`. */
  async list(prefix: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((n) => NAME_PATTERN.test(n))
      .sort();
  }

  async remove(name: string): Promise<void> {
    await rm(this.pathFor(name), { force: true });
  }
}
