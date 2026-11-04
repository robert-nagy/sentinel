import { readFile, stat } from 'node:fs/promises';

/** The file-system reads core logic needs; injectable so tests can use an in-memory tree. */
export interface FileAccess {
  /** File contents, or `undefined` if the file does not exist. */
  readonly readText: (path: string) => Promise<string | undefined>;
  readonly exists: (path: string) => Promise<boolean>;
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Default {@link FileAccess} backed by the real file system. */
export const nodeFiles: FileAccess = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  },
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  },
};
