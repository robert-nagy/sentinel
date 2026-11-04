// Writes schema/config.json (JSON Schema for sentinel.config.json) from the built library.
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { configJsonSchema } = await import(pathToFileURL(resolve('dist/index.js')).href);
await mkdir('schema', { recursive: true });
await writeFile('schema/config.json', `${JSON.stringify(configJsonSchema(), null, 2)}\n`, 'utf8');
